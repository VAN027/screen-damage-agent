import { createServer, json, fetchJson, pipeProxy } from './server-utils.mjs'
import { store } from './rules-store.mjs'
import { readFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.ADMIN_PORT || '8082', 10)
const KNOWLEDGE_AI_URL = process.env.KNOWLEDGE_AI_URL || 'http://localhost:8083'
const DECISION_ENGINE_URL = process.env.DECISION_ENGINE_URL || 'http://localhost:8081'
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || ''
const MAX_RULE_BODY_BYTES = 1024 * 1024
const startTime = Date.now()
let publishActivationTail = Promise.resolve()

const DEFAULT_RULES_NODES = [
  { id: 'node_start', type: 'start', description: '屏损故障发生', nextNodeId: 'decision_installed' },
  { id: 'decision_installed', type: 'decision', question: '是否已安装？',
    branches: [{ answer: '是', nextNodeId: 'outcome_C' }, { answer: '否', nextNodeId: 'decision_auth_personnel' }] },
  { id: 'decision_auth_personnel', type: 'decision', question: '开箱人员是否为TCL授权人员？',
    branches: [{ answer: '否', nextNodeId: 'outcome_E' }, { answer: '是', nextNodeId: 'decision_package_damage' }] },
  { id: 'decision_package_damage', type: 'decision', question: '包装箱是否有破损？',
    branches: [{ answer: '无破损', nextNodeId: 'decision_product_factor' }, { answer: '有破损', nextNodeId: 'decision_logistics_factor' }] },
  { id: 'decision_product_factor', type: 'decision', question: '故障环节是否包含"产品因素"？',
    branches: [{ answer: '是', nextNodeId: 'outcome_H' }, { answer: '否', nextNodeId: 'decision_install_use' }] },
  { id: 'decision_logistics_factor', type: 'decision', question: '故障环节是否包含"物流运输搬运"？',
    branches: [{ answer: '是', nextNodeId: 'outcome_K' }, { answer: '否', nextNodeId: 'decision_install_use' }] },
  { id: 'decision_install_use', type: 'decision', question: '故障环节是否包含"拆机验机安装"或"使用保管不当"？',
    branches: [{ answer: '是', nextNodeId: 'outcome_N' }, { answer: '否', nextNodeId: 'outcome_O' }] },
  { id: 'outcome_C', type: 'outcome', result: '非质量问题', conditionSummary: '已安装', nextNodeId: 'node_end' },
  { id: 'outcome_E', type: 'outcome', result: '非质量问题', conditionSummary: '未安装 + 非授权开箱', nextNodeId: 'node_end' },
  { id: 'outcome_H', type: 'outcome', result: '质量问题', conditionSummary: '未安装 + 授权开箱 + 包装完好 + 故障环节包含产品因素', nextNodeId: 'node_end' },
  { id: 'outcome_K', type: 'outcome', result: '非质量问题', conditionSummary: '未安装 + 授权开箱 + 包装破损 + 故障环节包含物流运输搬运', nextNodeId: 'node_end' },
  { id: 'outcome_N', type: 'outcome', result: '非质量问题', conditionSummary: '故障环节包含拆机验机安装或使用保管不当', nextNodeId: 'node_end' },
  { id: 'outcome_O', type: 'outcome', result: '非质量问题', conditionSummary: '排除产品因素、物流因素、安装/使用因素后，参考具体屏裂类型及案例指导', nextNodeId: 'node_end' },
  { id: 'node_end', type: 'end', description: '判定结束' },
]

async function seedDefaultRules() {
  const list = await store.list()
  if (list.length === 0) {
    const created = await store.create('屏损故障原因判定规则', '根据安装状态、开箱授权、包装状况和故障环节，判断屏损故障的责任归属', DEFAULT_RULES_NODES)
    await store.publish(created.id)
    console.log('[decision-admin] 已初始化默认规则集并发布')
  }
}

export class RulePublishActivationError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause ? { cause } : undefined)
    this.name = 'RulePublishActivationError'
    this.code = code
    this.statusCode = 502
    this.details = details
  }
}

function parseSuccessfulReload(result, expectedRule, action) {
  let parsed
  try {
    parsed = typeof result === 'string' ? JSON.parse(result) : result
  } catch (error) {
    throw new Error(`${action}返回了无效 JSON: ${error.message}`)
  }
  if (!parsed?.success) {
    throw new Error(parsed?.error?.message || `${action}未返回成功状态`)
  }
  if (expectedRule?.version && String(parsed.version) !== String(expectedRule.version)) {
    throw new Error(`${action}版本不匹配：期望 ${expectedRule.version}，实际 ${parsed.version || '未返回'}`)
  }
  if (expectedRule?.id && parsed.ruleId !== expectedRule.id) {
    throw new Error(`${action}规则 ID 不匹配：期望 ${expectedRule.id}，实际 ${parsed.ruleId || '未返回'}`)
  }
  if (expectedRule?.revision && parsed.revision !== expectedRule.revision) {
    throw new Error(`${action}规则修订标识不匹配`)
  }
  return parsed
}

async function reloadDecisionEngine() {
  return fetchJson(`${DECISION_ENGINE_URL}/api/decision/reload`, {
    method: 'POST',
    headers: { 'X-Internal-Token': INTERNAL_SERVICE_TOKEN },
    timeout: 10000,
  })
}

async function resetDecisionEngine() {
  return fetchJson(`${DECISION_ENGINE_URL}/api/decision/reset-default`, {
    method: 'POST',
    headers: { 'X-Internal-Token': INTERNAL_SERVICE_TOKEN },
    timeout: 10000,
  })
}

/**
 * Persist the candidate, have the engine acknowledge it, and compensate both
 * sides if activation fails. Calls are serialized so one rollback cannot
 * overwrite a newer concurrent publish.
 */
export function publishAndReloadRule(id, {
  rulesStore = store,
  reloadEngine = reloadDecisionEngine,
  resetEngine = resetDecisionEngine,
} = {}) {
  const operation = async () => {
    const { rule, previousPublishedId } = await rulesStore.publishWithPrevious(id)
    const previousRule = previousPublishedId ? await rulesStore.get(previousPublishedId) : null

    try {
      const reloadResult = parseSuccessfulReload(await reloadEngine(), rule, '决策引擎热加载')
      return { rule, reloadResult, previousPublishedId }
    } catch (activationError) {
      try {
        await rulesStore.restorePublishedId(previousPublishedId, id)
      } catch (rollbackError) {
        throw new RulePublishActivationError(
          'PUBLISH_ROLLBACK_FAILED',
          `决策引擎热加载失败，且 publishedId 回滚失败：${rollbackError.message}`,
          {
            candidateId: id,
            previousPublishedId,
            engineReloaded: false,
            persistedRolledBack: false,
            requiresManualRecovery: true,
          },
          activationError,
        )
      }

      try {
        const rollbackReload = previousRule ? await reloadEngine() : await resetEngine()
        parseSuccessfulReload(rollbackReload, previousRule, '决策引擎回滚加载')
      } catch (rollbackReloadError) {
        throw new RulePublishActivationError(
          'ENGINE_ROLLBACK_RELOAD_FAILED',
          `publishedId 已回滚，但决策引擎未确认恢复原规则：${rollbackReloadError.message}`,
          {
            candidateId: id,
            previousPublishedId,
            engineReloaded: false,
            persistedRolledBack: true,
            engineRolledBack: false,
            requiresManualRecovery: true,
          },
          activationError,
        )
      }

      throw new RulePublishActivationError(
        'ENGINE_RELOAD_FAILED_ROLLED_BACK',
        `决策引擎未能激活新规则，已恢复发布前状态：${activationError.message}`,
        {
          candidateId: id,
          previousPublishedId,
          engineReloaded: false,
          persistedRolledBack: true,
          engineRolledBack: true,
          requiresManualRecovery: false,
        },
        activationError,
      )
    }
  }

  const result = publishActivationTail.then(operation, operation)
  publishActivationTail = result.catch(() => {})
  return result
}

function serveFile(res, filePath, contentType) {
  readFile(filePath)
    .then(data => {
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache, no-store, must-revalidate' })
      res.end(data)
    })
    .catch(() => {
      res.writeHead(404)
      res.end('Not Found')
    })
}

const routes = [
  // ========== 健康检查 ==========
  {
    method: 'GET',
    path: '/api/health',
    handler: (_req, res) => {
      json(res, 200, { service: 'decision-admin', status: 'ok', uptime: Date.now() - startTime, version: '1.0.0' })
    },
  },
  // ========== 规则列表 ==========
  {
    method: 'GET',
    path: '/api/admin/rules',
    auth: 'admin',
    handler: async (_req, res) => {
      const list = await store.list()
      json(res, 200, { success: true, data: list })
    },
  },
  // ========== 规则详情 ==========
  {
    method: 'GET',
    path: '/api/admin/rules/detail',
    auth: 'admin',
    handler: async (_req, res, { query }) => {
      const rule = await store.get(query.id)
      if (!rule) return json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: '规则不存在' } })
      json(res, 200, { success: true, data: rule })
    },
  },
  // ========== 获取已发布规则（给 decision-engine 用） ==========
  {
    method: 'GET',
    path: '/api/admin/rules/published',
    auth: 'internal',
    handler: async (_req, res) => {
      const payload = await store.getDecisionTreePayload()
      if (!payload) return json(res, 404, { success: false, error: { code: 'NO_PUBLISHED', message: '没有已发布的规则' } })
      json(res, 200, { success: true, data: payload })
    },
  },
  // ========== 创建规则 ==========
  {
    method: 'POST',
    path: '/api/admin/rules',
    auth: 'admin',
    maxBodyBytes: MAX_RULE_BODY_BYTES,
    handler: async (_req, res, { body }) => {
      try {
        const rule = await store.create(body.ruleSetName, body.description || '', body.nodes || [])
        json(res, 201, { success: true, data: rule })
      } catch (e) {
        json(res, 400, { success: false, error: { code: 'CREATE_FAILED', message: e.message } })
      }
    },
  },
  // ========== 更新规则 ==========
  {
    method: 'PUT',
    path: '/api/admin/rules/update',
    auth: 'admin',
    maxBodyBytes: MAX_RULE_BODY_BYTES,
    handler: async (_req, res, { body }) => {
      try {
        const rule = await store.update(body.id, body)
        json(res, 200, { success: true, data: rule })
      } catch (e) {
        json(res, e.statusCode || 400, { success: false, error: { code: e.code || 'UPDATE_FAILED', message: e.message } })
      }
    },
  },
  // ========== 发布规则 ==========
  {
    method: 'POST',
    path: '/api/admin/rules/publish',
    auth: 'admin',
    maxBodyBytes: 16 * 1024,
    handler: async (_req, res, { body }) => {
      try {
        const { rule, reloadResult } = await publishAndReloadRule(body.id)

        json(res, 200, {
          success: true,
          data: { ...rule, engineReloaded: true },
          message: `规则已发布并由决策引擎确认生效（v${reloadResult.version || rule.version}）`,
        })
      } catch (e) {
        json(res, e.statusCode || 400, {
          success: false,
          data: e.details,
          error: { code: e.code || 'PUBLISH_FAILED', message: e.message },
        })
      }
    },
  },
  // ========== 删除规则 ==========
  {
    method: 'DELETE',
    path: '/api/admin/rules/delete',
    auth: 'admin',
    handler: async (_req, res, { query }) => {
      try {
        const ok = await store.remove(query.id)
        if (!ok) return json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: '规则不存在' } })
        json(res, 200, { success: true, message: '已删除' })
      } catch (e) {
        json(res, e.statusCode || 400, { success: false, error: { code: e.code || 'DELETE_FAILED', message: e.message } })
      }
    },
  },
  // ========== 数据库备份（通过 /api/admin 路径避免与通用代理冲突） ==========
  {
    method: 'POST',
    path: '/api/admin/backup',
    auth: 'admin',
    handler: async (req, res) => {
      try {
        const result = await fetchJson(`${KNOWLEDGE_AI_URL}/api/knowledge/backup`, {
          method: 'POST',
          headers: { 'Authorization': req.headers.authorization || '' },
          timeout: 30000,
        })
        json(res, 200, result)
      } catch (e) {
        json(res, 502, { success: false, error: { code: 'PROXY_ERROR', message: `备份失败: ${e.message}` } })
      }
    },
  },
  // ========== 用户在线鉴定记录 ==========
  {
    method: 'GET',
    path: '/api/admin/assessment-records',
    auth: 'admin',
    handler: async (req, res, { query }) => {
      try {
        const search = new URLSearchParams()
        for (const [key, value] of Object.entries(query || {})) if (value !== '') search.set(key, value)
        const suffix = search.size ? `?${search}` : ''
        const result = await fetchJson(`${KNOWLEDGE_AI_URL}/api/knowledge/assessment-records${suffix}`, {
          method: 'GET',
          headers: { 'Authorization': req.headers.authorization || '' },
          timeout: 30000,
        })
        json(res, 200, result)
      } catch (e) {
        json(res, e.statusCode || 502, e.upstreamBody || { success: false, error: { code: e.code || 'PROXY_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'GET',
    path: '/api/admin/assessment-record',
    auth: 'admin',
    handler: async (req, res, { query }) => {
      try {
        const result = await fetchJson(`${KNOWLEDGE_AI_URL}/api/knowledge/assessment-record?submissionId=${encodeURIComponent(query.submissionId || '')}`, {
          method: 'GET',
          headers: { 'Authorization': req.headers.authorization || '' },
          timeout: 30000,
        })
        json(res, 200, result)
      } catch (e) {
        json(res, e.statusCode || 502, e.upstreamBody || { success: false, error: { code: e.code || 'PROXY_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'GET',
    path: '/api/admin/assessment-image',
    auth: 'admin',
    handler: (req, res, { query }) => pipeProxy(
      'GET',
      `${KNOWLEDGE_AI_URL}/api/knowledge/assessment-image?id=${encodeURIComponent(query.id || '')}`,
      null,
      req,
      res,
      {
        'X-Internal-Token': INTERNAL_SERVICE_TOKEN,
        'Authorization': req.headers.authorization || '',
      },
    ),
  },
  {
    method: 'DELETE',
    path: '/api/admin/assessment-record',
    auth: 'admin',
    handler: async (req, res, { query }) => {
      try {
        const result = await fetchJson(`${KNOWLEDGE_AI_URL}/api/knowledge/assessment-record?submissionId=${encodeURIComponent(query.submissionId || '')}`, {
          method: 'DELETE',
          headers: { 'Authorization': req.headers.authorization || '' },
          timeout: 30000,
        })
        json(res, 200, result)
      } catch (e) {
        json(res, e.statusCode || 502, e.upstreamBody || { success: false, error: { code: e.code || 'PROXY_ERROR', message: e.message } })
      }
    },
  },
  // ========== 电视方向调试页及受保护代理 ==========
  {
    method: 'POST',
    path: '/api/admin/debug/tv-orient-job',
    auth: 'admin',
    maxBodyBytes: 16 * 1024 * 1024,
    handler: (req, res, { body }) => pipeProxy(
      'POST',
      `${KNOWLEDGE_AI_URL}/api/debug/tv-orient-job`,
      body,
      req,
      res,
      {
        'X-Internal-Token': INTERNAL_SERVICE_TOKEN,
        'Authorization': req.headers.authorization || '',
      },
    ),
  },
  {
    method: 'POST',
    path: '/api/admin/debug/tv-orient',
    auth: 'admin',
    maxBodyBytes: 16 * 1024 * 1024,
    handler: (req, res, { body }) => pipeProxy(
      'POST',
      `${KNOWLEDGE_AI_URL}/api/debug/tv-orient`,
      body,
      req,
      res,
      {
        'X-Internal-Token': INTERNAL_SERVICE_TOKEN,
        'Authorization': req.headers.authorization || '',
      },
    ),
  },
  {
    method: 'GET',
    path: '/api/admin/debug/tv-orient-defaults',
    auth: 'admin',
    handler: async (req, res) => {
      try {
        const result = await fetchJson(`${KNOWLEDGE_AI_URL}/api/debug/tv-orient-defaults`, {
          method: 'GET',
          headers: {
            'X-Internal-Token': INTERNAL_SERVICE_TOKEN,
            'Authorization': req.headers.authorization || '',
          },
          timeout: 10000,
        })
        json(res, 200, result)
      } catch (e) {
        json(res, e.statusCode || 502, e.upstreamBody || { success: false, error: { code: e.code || 'PROXY_ERROR', message: e.message } })
      }
    },
  },
  // ========== 静态文件：管理后台页面 ==========
  {
    method: 'GET',
    path: '/admin/tv-orient',
    handler: (_req, res) => {
      serveFile(res, join(__dirname, '..', '..', 'knowledge-ai', 'tools', 'tv-orient-debug.html'), 'text/html; charset=utf-8')
    },
  },
  {
    method: 'GET',
    path: '/admin',
    handler: (_req, res) => {
      serveFile(res, join(__dirname, '..', 'static', 'admin.html'), 'text/html; charset=utf-8')
    },
  },
  {
    method: 'GET',
    path: '/',
    handler: (_req, res) => {
      serveFile(res, join(__dirname, '..', 'static', 'admin.html'), 'text/html; charset=utf-8')
    },
  },
]

export async function startServer() {
  await store.ensureReady()
  await seedDefaultRules()

  const server = createServer(routes, PORT, 'decision-admin')
  console.log(`[decision-admin] 管理后台 → http://localhost:${PORT}/admin`)
  console.log(`[decision-admin] 规则API → GET http://localhost:${PORT}/api/admin/rules`)
  console.log(`[decision-admin] 已发布规则 → GET http://localhost:${PORT}/api/admin/rules/published`)
  return server
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
// PM2 loads applications through its process container, so process.argv[1]
// is not guaranteed to equal this module even though this is the configured script.
if (isEntryPoint || process.env.pm_id !== undefined) await startServer()
