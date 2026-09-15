import { createServer, json, fetchJson } from './server-utils.mjs'
import { DecisionTree, validateRuleSet } from './decision-tree.mjs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const PORT = parseInt(process.env.ENGINE_PORT || '8081', 10)
const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:8082'
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || ''
const configuredAiThreshold = Number(process.env.AI_CONCLUSION_MIN_CONFIDENCE ?? '0.85')
const AI_CONCLUSION_MIN_CONFIDENCE = Number.isFinite(configuredAiThreshold)
  ? Math.min(1, Math.max(0, configuredAiThreshold))
  : 0.85
const startTime = Date.now()
const decisionTree = new DecisionTree()
const configuredRetryBaseMs = Number.parseInt(process.env.RULE_RELOAD_RETRY_BASE_MS || '1000', 10)
const configuredRetryMaxMs = Number.parseInt(process.env.RULE_RELOAD_RETRY_MAX_MS || '30000', 10)
const RULE_RELOAD_RETRY_BASE_MS = Number.isFinite(configuredRetryBaseMs) && configuredRetryBaseMs > 0
  ? configuredRetryBaseMs
  : 1000
const RULE_RELOAD_RETRY_MAX_MS = Number.isFinite(configuredRetryMaxMs) && configuredRetryMaxMs > 0
  ? Math.max(RULE_RELOAD_RETRY_BASE_MS, configuredRetryMaxMs)
  : 30000
export const DEFAULT_RULE_RECONCILE_INTERVAL_MS = 30000
export const MIN_RULE_RECONCILE_INTERVAL_MS = 1000

export function normalizeRuleReconcileInterval(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_RULE_RECONCILE_INTERVAL_MS
  return Math.max(MIN_RULE_RECONCILE_INTERVAL_MS, parsed)
}

const RULE_RECONCILE_INTERVAL_MS = normalizeRuleReconcileInterval(process.env.RULE_RECONCILE_INTERVAL_MS)
const ruleSyncState = {
  rulesReady: false,
  source: 'builtin-fallback',
  lastError: '尚未从管理中台同步已发布规则',
  degraded: false,
  retryAttempt: 0,
  nextRetryAt: null,
  lastAttemptAt: null,
  lastSuccessfulSyncAt: null,
  lastAction: null,
  nextReconcileAt: null,
}
let reloadTail = Promise.resolve()
let retryTimer = null
let retrySchedulingStopped = false
let reconcileTimer = null
let reconcileSchedulingStopped = true
let reconcileFetcher = fetchJson
let reconcileIntervalMs = RULE_RECONCILE_INTERVAL_MS
let reconcileSetTimer = setTimeout
let reconcileClearTimer = clearTimeout

export function ruleReloadRetryDelay(attempt, {
  baseMs = RULE_RELOAD_RETRY_BASE_MS,
  maxMs = RULE_RELOAD_RETRY_MAX_MS,
} = {}) {
  const normalizedAttempt = Math.max(0, Number.isInteger(attempt) ? attempt : 0)
  return Math.min(maxMs, baseMs * (2 ** Math.min(normalizedAttempt, 30)))
}

function clearRuleReloadRetry() {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  ruleSyncState.nextRetryAt = null
}

export function stopRuleReloadRetry() {
  retrySchedulingStopped = true
  clearRuleReloadRetry()
}

function markRulesReady(source, action = 'reloaded') {
  clearRuleReloadRetry()
  ruleSyncState.rulesReady = true
  ruleSyncState.source = source
  ruleSyncState.lastError = null
  ruleSyncState.degraded = false
  ruleSyncState.retryAttempt = 0
  ruleSyncState.lastSuccessfulSyncAt = new Date().toISOString()
  ruleSyncState.lastAction = action
}

export function getRuleSyncStatus() {
  return {
    ...ruleSyncState,
    ruleId: decisionTree.currentRuleId,
    version: decisionTree.currentVersion,
    revision: decisionTree.currentRevision,
  }
}

function publishedIdentity(ruleSet) {
  for (const field of ['id', 'version', 'revision']) {
    if (typeof ruleSet?.[field] !== 'string' || !ruleSet[field].trim()) {
      throw new Error(`管理中台已发布规则缺少 ${field}`)
    }
  }
  return {
    ruleId: ruleSet.id,
    version: ruleSet.version,
    revision: ruleSet.revision,
  }
}

function activeIdentityMatches(identity) {
  return decisionTree.currentRuleId === identity.ruleId &&
    decisionTree.currentVersion === identity.version &&
    decisionTree.currentRevision === identity.revision
}

export function reloadRulesFromAdmin({ fetcher = fetchJson, force = true } = {}) {
  const operation = async () => {
    ruleSyncState.lastAttemptAt = new Date().toISOString()
    try {
      const result = await fetcher(`${ADMIN_URL}/api/admin/rules/published`, {
        headers: { 'X-Internal-Token': INTERNAL_SERVICE_TOKEN },
      })
      const data = typeof result === 'string' ? JSON.parse(result) : result
      if (!data?.success || !data.data) {
        throw new Error(data?.error?.message || '管理中台未返回已发布规则')
      }
      validateRuleSet(data.data)
      const identity = publishedIdentity(data.data)
      const shouldReload = force || !activeIdentityMatches(identity)
      if (shouldReload) {
        decisionTree.reloadRuleSet(data.data)
        console.log(`[decision-engine] 已从管理中台加载规则: ${data.data.ruleSetName} v${identity.version} (${identity.ruleId})`)
      }
      markRulesReady('admin-published', shouldReload ? 'reloaded' : 'confirmed')
      return {
        ok: true,
        version: decisionTree.currentVersion,
        ruleId: decisionTree.currentRuleId,
        revision: decisionTree.currentRevision,
      }
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      if (!ruleSyncState.rulesReady) ruleSyncState.source = 'builtin-fallback'
      ruleSyncState.degraded = ruleSyncState.rulesReady
      ruleSyncState.lastError = error.message
      ruleSyncState.lastAction = 'failed'
      console.warn(`[decision-engine] 从管理中台加载规则失败: ${ruleSyncState.lastError}`)
      return { ok: false, error }
    }
  }

  const result = reloadTail.then(operation, operation)
  reloadTail = result.catch(() => {})
  return result
}

function scheduleRuleReloadRetry() {
  if (retrySchedulingStopped || retryTimer || ruleSyncState.rulesReady) return
  const delay = ruleReloadRetryDelay(ruleSyncState.retryAttempt)
  ruleSyncState.retryAttempt += 1
  ruleSyncState.nextRetryAt = new Date(Date.now() + delay).toISOString()
  retryTimer = setTimeout(async () => {
    retryTimer = null
    ruleSyncState.nextRetryAt = null
    const result = await reloadRulesFromAdmin()
    if (!result.ok) scheduleRuleReloadRetry()
    else startRuleReconciliation()
  }, delay)
  retryTimer.unref?.()
}

function scheduleRuleReconciliation() {
  if (reconcileSchedulingStopped || reconcileTimer) return
  ruleSyncState.nextReconcileAt = new Date(Date.now() + reconcileIntervalMs).toISOString()
  reconcileTimer = reconcileSetTimer(async () => {
    reconcileTimer = null
    ruleSyncState.nextReconcileAt = null
    try {
      await reloadRulesFromAdmin({ fetcher: reconcileFetcher, force: false })
    } finally {
      scheduleRuleReconciliation()
    }
  }, reconcileIntervalMs)
  reconcileTimer?.unref?.()
}

/**
 * 已就绪后周期核对管理中台的 published 指针。递归 setTimeout 避免慢请求重叠。
 * timer 注入仅用于确定性单元测试。
 */
export function startRuleReconciliation({
  fetcher = fetchJson,
  intervalMs = RULE_RECONCILE_INTERVAL_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  stopRuleReconciliation()
  reconcileSchedulingStopped = false
  reconcileFetcher = fetcher
  reconcileIntervalMs = normalizeRuleReconcileInterval(intervalMs)
  reconcileSetTimer = setTimer
  reconcileClearTimer = clearTimer
  scheduleRuleReconciliation()
}

export function stopRuleReconciliation() {
  reconcileSchedulingStopped = true
  if (reconcileTimer) reconcileClearTimer(reconcileTimer)
  reconcileTimer = null
  ruleSyncState.nextReconcileAt = null
  reconcileFetcher = fetchJson
  reconcileIntervalMs = RULE_RECONCILE_INTERVAL_MS
  reconcileSetTimer = setTimeout
  reconcileClearTimer = clearTimeout
}

export class DecisionRequestError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DecisionRequestError'
    this.code = 'INVALID_DECISION_REQUEST'
  }
}

const INSTALL_STATUSES = new Set(['installed', 'not_installed', 'unknown'])
const AUTH_PERSONNEL_VALUES = new Set(['yes', 'no', 'unknown'])
const PACKAGE_DAMAGE_VALUES = new Set(['none', 'minor', 'severe', 'damaged', 'unknown'])
const FAULT_LINK_VALUES = new Set([
  'product_factor',
  'logistics_transport',
  'unboxing_install',
  'usage_mishandling',
  'unknown',
])

function requireEnum(value, allowed, fieldName) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new DecisionRequestError(`${fieldName} 取值无效`)
  }
}

function normalizeConfidence(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DecisionRequestError('conclusionConfidence 必须是数字')
  }
  if (value < 0 || value > 100) {
    throw new DecisionRequestError('conclusionConfidence 必须在 0-1 或 0-100 范围内')
  }
  return value > 1 ? value / 100 : value
}

export function validateDecisionRequest(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) {
    throw new DecisionRequestError('请求体必须是 JSON 对象')
  }
  if (req.caseId !== undefined && (typeof req.caseId !== 'string' || req.caseId.length > 128)) {
    throw new DecisionRequestError('caseId 必须是不超过 128 个字符的字符串')
  }
  requireEnum(req.installStatus, INSTALL_STATUSES, 'installStatus')
  requireEnum(req.authPersonnel, AUTH_PERSONNEL_VALUES, 'authPersonnel')
  requireEnum(req.packageDamage, PACKAGE_DAMAGE_VALUES, 'packageDamage')

  if (!Array.isArray(req.faultLinks)) throw new DecisionRequestError('faultLinks 必须是数组')
  if (req.faultLinks.length === 0) {
    throw new DecisionRequestError('faultLinks 不能为空，无法判断时请单独提交 unknown')
  }
  if (req.faultLinks.length > FAULT_LINK_VALUES.size) throw new DecisionRequestError('faultLinks 项目过多')
  const uniqueFaultLinks = new Set()
  for (const value of req.faultLinks) {
    requireEnum(value, FAULT_LINK_VALUES, 'faultLinks')
    if (uniqueFaultLinks.has(value)) throw new DecisionRequestError(`faultLinks 包含重复值 "${value}"`)
    uniqueFaultLinks.add(value)
  }
  if (uniqueFaultLinks.has('unknown') && uniqueFaultLinks.size > 1) {
    throw new DecisionRequestError('faultLinks 的 unknown 不能与其他选项同时提交')
  }

  if (req.conclusion !== undefined && req.conclusion !== null && req.conclusion !== '') {
    requireEnum(req.conclusion, new Set(['product_quality_issue', 'not_product_quality', 'no_damage']), 'conclusion')
  }
  if (req.conclusionTrusted !== undefined && typeof req.conclusionTrusted !== 'boolean') {
    throw new DecisionRequestError('conclusionTrusted 必须是布尔值')
  }
  const conclusionConfidence = normalizeConfidence(req.conclusionConfidence)
  if (conclusionConfidence !== null && !req.conclusion) {
    throw new DecisionRequestError('提供 conclusionConfidence 时必须同时提供 conclusion')
  }
  if (req.conclusionTrusted === true && !req.conclusion) {
    throw new DecisionRequestError('可信 AI 结论缺少 conclusion')
  }

  return { conclusionConfidence }
}

export function buildAnswers(req) {
  validateDecisionRequest(req)
  const a = {}
  let unknownCount = 0

  if (req.installStatus === 'unknown') {
    unknownCount++
    a['decision_installed'] = '否'
  } else {
    a['decision_installed'] = req.installStatus === 'installed' ? '是' : '否'
  }

  // Populate every supported decision ID even when the default graph would
  // skip it. Admin-managed graphs may reorder supported questions, and must
  // never fail merely because buildAnswers omitted a fixed input key.
  a['decision_auth_personnel'] = req.authPersonnel === 'yes' ? '是' : '否'
  if (req.installStatus !== 'installed' && req.authPersonnel === 'unknown') unknownCount++

  const installNotInstalled = req.installStatus === 'not_installed' || req.installStatus === 'unknown'
  const authIsYesOrUnknown = req.authPersonnel === 'yes' || req.authPersonnel === 'unknown'
  a['decision_package_damage'] = ['minor', 'severe', 'damaged'].includes(req.packageDamage) ? '有破损' : '无破损'
  if (installNotInstalled && authIsYesOrUnknown && req.packageDamage === 'unknown') unknownCount++

  const hasProductFactor = req.faultLinks.includes('product_factor')
  const hasLogistics = req.faultLinks.includes('logistics_transport')
  const hasInstallUse = req.faultLinks.includes('unboxing_install') || req.faultLinks.includes('usage_mishandling')

  if (req.faultLinks.length === 0 || req.faultLinks.includes('unknown')) {
    unknownCount++
  }

  a['decision_product_factor'] = hasProductFactor ? '是' : '否'
  a['decision_logistics_factor'] = hasLogistics ? '是' : '否'

  a['decision_install_use'] = hasInstallUse ? '是' : '否'

  return { answers: a, unknownCount }
}

export function outcomeToEnum(outcome) {
  if (outcome === '质量问题' || outcome === '产品质量问题') return 'product_quality_issue'
  if (outcome === '非质量问题' || outcome === '非产品质量问题') return 'not_product_quality'
  if (outcome === '屏幕完好') return 'no_damage'
  if (outcome === '人工复核' || outcome === '需人工复核' || outcome === '进一步鉴定') return 'manual_review'
  throw new Error(`规则返回了不支持的判定结论 "${outcome}"`)
}

const RESULT_LABELS = {
  product_quality_issue: '质量问题',
  not_product_quality: '非质量问题',
  no_damage: '屏幕完好',
  manual_review: '转人工复核',
}

export function buildAiAdvisory(req, ruleResult) {
  if (!req.conclusion) return null
  const confidence = normalizeConfidence(req.conclusionConfidence)
  const trusted = req.conclusionTrusted === true
  let status = 'ignored_untrusted'
  if (trusted && confidence === null) status = 'ignored_missing_confidence'
  else if (trusted && confidence < AI_CONCLUSION_MIN_CONFIDENCE) status = 'ignored_low_confidence'
  else if (trusted && req.conclusion === ruleResult) status = 'accepted_match'
  else if (trusted) status = 'conflict_manual_review'

  return {
    conclusion: req.conclusion,
    conclusionLabel: RESULT_LABELS[req.conclusion],
    trusted,
    confidence,
    requiredConfidence: AI_CONCLUSION_MIN_CONFIDENCE,
    status,
  }
}

export function evaluateDecision(req, tree = decisionTree) {
  const { answers, unknownCount } = buildAnswers(req)
  const evalResult = tree.evaluate(answers)
  const ruleResult = outcomeToEnum(evalResult.outcome)
  const aiAdvisory = buildAiAdvisory(req, ruleResult)

  let result = ruleResult
  let reviewReason = null
  if (unknownCount >= 2) {
    result = 'manual_review'
    reviewReason = 'insufficient_information'
  }

  // Only a server-trusted, sufficiently confident AI result is eligible for
  // reconciliation. A conflict never silently overwrites the rules.
  if (aiAdvisory?.status === 'conflict_manual_review') {
    result = 'manual_review'
    reviewReason = 'ai_rule_conflict'
    evalResult.path.push({
      nodeId: 'ai_conclusion',
      question: 'AI 图像鉴定结论',
      answer: `${aiAdvisory.conclusionLabel}（与规则冲突，转人工复核）`,
      timestamp: new Date().toISOString(),
    })
  }

  return {
    caseId: req.caseId,
    result,
    resultLabel: RESULT_LABELS[result],
    reviewReason,
    aiAdvisory,
    decisionPath: evalResult.path,
    ruleId: tree.currentRuleId,
    ruleVersion: tree.currentVersion,
    ruleRevision: tree.currentRevision,
  }
}

export const routes = [
  {
    method: 'GET',
    path: '/api/health',
    handler: (_req, res) => {
      const sync = getRuleSyncStatus()
      json(res, sync.rulesReady ? 200 : 503, {
        service: 'decision-engine',
        status: sync.rulesReady ? 'ok' : 'not_ready',
        uptime: Date.now() - startTime,
        version: '1.0.0',
        rulesReady: sync.rulesReady,
        degraded: sync.degraded,
        ruleSyncStatus: sync.rulesReady ? (sync.degraded ? 'degraded' : 'in_sync') : 'not_ready',
        rulesSource: sync.source,
        activeRuleId: sync.ruleId,
        activeRuleVersion: sync.version,
        activeRuleRevision: sync.revision,
        lastError: sync.lastError,
        lastRuleSyncError: sync.lastError,
        lastRuleSyncAttemptAt: sync.lastAttemptAt,
        lastSuccessfulRuleSyncAt: sync.lastSuccessfulSyncAt,
        lastRuleSyncAction: sync.lastAction,
        nextRuleRetryAt: sync.nextRetryAt,
        nextRuleReconcileAt: sync.nextReconcileAt,
      })
    },
  },
  {
    method: 'POST',
    path: '/api/decision/evaluate',
    auth: 'internal',
    maxBodyBytes: 64 * 1024,
    handler: (_req, res, { body }) => {
      if (!ruleSyncState.rulesReady) {
        return json(res, 503, {
          success: false,
          error: {
            code: 'RULES_NOT_READY',
            message: '决策引擎尚未从管理中台同步已发布规则',
          },
        })
      }
      try {
        json(res, 200, {
          success: true,
          data: evaluateDecision(body),
        })
      } catch (error) {
        const isRequestError = error instanceof DecisionRequestError
        json(res, isRequestError ? 400 : 422, {
          success: false,
          error: {
            code: isRequestError ? error.code : 'RULE_EVALUATION_FAILED',
            message: error.message,
          },
        })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/decision/reload',
    auth: ['internal', 'admin'],
    maxBodyBytes: 1024,
    handler: async (_req, res) => {
      const result = await reloadRulesFromAdmin()
      if (result.ok) {
        startRuleReconciliation()
        json(res, 200, {
          success: true,
          message: '规则已从管理中台重新加载',
          version: result.version,
          ruleId: result.ruleId,
          revision: result.revision,
        })
      } else {
        if (!ruleSyncState.rulesReady) scheduleRuleReloadRetry()
        json(res, 502, {
          success: false,
          error: { code: 'RELOAD_FAILED', message: result.error.message },
          rulesReady: ruleSyncState.rulesReady,
          activeRuleId: decisionTree.currentRuleId,
          activeVersion: decisionTree.currentVersion,
          activeRevision: decisionTree.currentRevision,
        })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/decision/reset-default',
    // This compensation endpoint is deliberately internal-only. Admin bearer
    // credentials can request a normal reload, but cannot reset active rules.
    auth: 'internal',
    maxBodyBytes: 1024,
    handler: (_req, res) => {
      decisionTree.resetToDefault()
      markRulesReady('builtin-default-explicit')
      startRuleReconciliation()
      json(res, 200, {
        success: true,
        message: '决策引擎已恢复内置默认规则',
        version: decisionTree.currentVersion,
        ruleId: decisionTree.currentRuleId,
        revision: decisionTree.currentRevision,
      })
    },
  },
]

export async function startServer() {
  // 在监听端口前先尝试同步。失败时仍启动健康端点，但 readiness
  // 保持 503，且判定接口 fail-closed，后台指数退避重试。
  retrySchedulingStopped = false
  const loaded = await reloadRulesFromAdmin()
  if (!loaded.ok) {
    console.warn('[decision-engine] 规则未就绪，判定接口已禁用，将后台重试')
    scheduleRuleReloadRetry()
  } else startRuleReconciliation()
  const server = createServer(routes, PORT, 'decision-engine')
  server.on('close', () => {
    stopRuleReloadRetry()
    stopRuleReconciliation()
  })
  console.log(`[decision-engine] 判定接口 → POST http://localhost:${PORT}/api/decision/evaluate`)
  return server
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
// PM2 loads applications through its process container, so process.argv[1]
// is not guaranteed to equal this module even though this is the configured script.
if (isEntryPoint || process.env.pm_id !== undefined) await startServer()
