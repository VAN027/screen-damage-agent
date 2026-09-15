import { readFile, writeFile, mkdir, unlink, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', 'data')
export const MAX_RULE_PATH_LENGTH = 100
export const MAX_RULE_NODES = 200
const MAX_RULE_NAME_LENGTH = 128
const MAX_RULE_DESCRIPTION_LENGTH = 4000
const MAX_NODE_DESCRIPTION_LENGTH = 1000
const MAX_QUESTION_LENGTH = 500
const MAX_CONDITION_SUMMARY_LENGTH = 2000

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 })
    await rename(tempPath, filePath)
  } catch (error) {
    try { await unlink(tempPath) } catch {}
    throw error
  }
}
const ALLOWED_NODE_TYPES = new Set(['start', 'decision', 'outcome', 'end'])
const ALLOWED_OUTCOME_RESULTS = new Set([
  '质量问题', '产品质量问题',
  '非质量问题', '非产品质量问题',
  '屏幕完好',
  '人工复核', '需人工复核', '进一步鉴定',
])
const SUPPORTED_DECISION_ANSWERS = new Map([
  ['decision_installed', new Set(['是', '否'])],
  ['decision_auth_personnel', new Set(['是', '否'])],
  ['decision_package_damage', new Set(['无破损', '有破损'])],
  ['decision_product_factor', new Set(['是', '否'])],
  ['decision_logistics_factor', new Set(['是', '否'])],
  ['decision_install_use', new Set(['是', '否'])],
])

export class RuleValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RuleValidationError'
    this.code = 'INVALID_RULE_GRAPH'
  }
}

export class RuleConflictError extends Error {
  constructor(message, code = 'RULE_CONFLICT') {
    super(message)
    this.name = 'RuleConflictError'
    this.code = code
    this.statusCode = 409
  }
}

function failValidation(message) {
  throw new RuleValidationError(message)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function calculateRuleRevision(ruleSet) {
  const revisionPayload = {
    id: ruleSet.id || null,
    ruleSetName: ruleSet.ruleSetName,
    version: ruleSet.version,
    description: ruleSet.description || '',
    startNodeId: ruleSet.startNodeId,
    nodes: ruleSet.nodes,
  }
  return crypto.createHash('sha256').update(JSON.stringify(revisionPayload)).digest('hex')
}

function nextVersionForName(rules, ruleSetName) {
  let maxMinor = -1
  for (const rule of rules) {
    if (rule.ruleSetName !== ruleSetName) continue
    const match = String(rule.version || '').match(/^1\.(\d+)$/)
    if (match) maxMinor = Math.max(maxMinor, Number(match[1]))
  }
  return `1.${maxMinor + 1}`
}

// Keep this validator aligned with decision-engine/src/decision-tree.mjs. The
// services are packaged independently, so importing across service boundaries
// would make either Docker image incomplete.
export function validateRuleSet(ruleSet, { maxPathLength = MAX_RULE_PATH_LENGTH } = {}) {
  if (!isRecord(ruleSet)) failValidation('规则集必须是对象')
  if (typeof ruleSet.ruleSetName !== 'string' || !ruleSet.ruleSetName.trim()) {
    failValidation('规则集名称不能为空')
  }
  if (ruleSet.ruleSetName.length > MAX_RULE_NAME_LENGTH) {
    failValidation(`规则集名称不能超过 ${MAX_RULE_NAME_LENGTH} 个字符`)
  }
  if (typeof ruleSet.description !== 'string' || ruleSet.description.length > MAX_RULE_DESCRIPTION_LENGTH) {
    failValidation(`规则集描述必须是不超过 ${MAX_RULE_DESCRIPTION_LENGTH} 个字符的字符串`)
  }
  if (!Array.isArray(ruleSet.nodes) || ruleSet.nodes.length === 0) {
    failValidation('规则集至少需要一个节点')
  }
  if (ruleSet.nodes.length > MAX_RULE_NODES) {
    failValidation(`规则集节点数不能超过 ${MAX_RULE_NODES}`)
  }
  if (!Number.isInteger(maxPathLength) || maxPathLength < 2) {
    failValidation('最大规则路径长度配置无效')
  }

  const nodeMap = new Map()
  for (const [index, node] of ruleSet.nodes.entries()) {
    if (!isRecord(node)) failValidation(`第 ${index + 1} 个节点必须是对象`)
    if (typeof node.id !== 'string' || !node.id.trim()) {
      failValidation(`第 ${index + 1} 个节点缺少合法 ID`)
    }
    if (node.id.length > 128) failValidation(`节点 ID "${node.id}" 超过 128 个字符`)
    if (nodeMap.has(node.id)) failValidation(`节点 ID "${node.id}" 重复`)
    if (!ALLOWED_NODE_TYPES.has(node.type)) {
      failValidation(`节点 "${node.id}" 的类型 "${node.type}" 不合法`)
    }
    if (node.description !== undefined && (typeof node.description !== 'string' || node.description.length > MAX_NODE_DESCRIPTION_LENGTH)) {
      failValidation(`节点 "${node.id}" 的描述不能超过 ${MAX_NODE_DESCRIPTION_LENGTH} 个字符`)
    }
    nodeMap.set(node.id, node)
  }

  const startNodes = ruleSet.nodes.filter(node => node.type === 'start')
  if (startNodes.length !== 1) failValidation(`规则集必须且只能包含一个 start 节点，当前为 ${startNodes.length} 个`)
  if (typeof ruleSet.startNodeId !== 'string' || !ruleSet.startNodeId.trim()) {
    failValidation('规则集缺少 startNodeId')
  }
  const startNode = nodeMap.get(ruleSet.startNodeId)
  if (!startNode) failValidation(`startNodeId 指向不存在的节点 "${ruleSet.startNodeId}"`)
  if (startNode.type !== 'start') failValidation(`startNodeId "${ruleSet.startNodeId}" 指向的不是 start 节点`)
  if (startNodes[0].id !== ruleSet.startNodeId) {
    failValidation(`startNodeId 必须指向唯一的 start 节点 "${startNodes[0].id}"`)
  }
  if (!ruleSet.nodes.some(node => node.type === 'outcome')) {
    failValidation('规则集至少需要一个 outcome 结论节点')
  }
  if (!ruleSet.nodes.some(node => node.type === 'end')) failValidation('规则集至少需要一个 end 节点')

  const edges = new Map()
  const addTarget = (sourceNode, targetId, label) => {
    if (typeof targetId !== 'string' || !targetId.trim()) {
      failValidation(`节点 "${sourceNode.id}" 的${label}缺少 nextNodeId`)
    }
    if (!nodeMap.has(targetId)) {
      failValidation(`节点 "${sourceNode.id}" 的${label}指向不存在的节点 "${targetId}"`)
    }
    edges.get(sourceNode.id).push(targetId)
  }

  for (const node of ruleSet.nodes) {
    edges.set(node.id, [])
    if (node.type === 'start') {
      addTarget(node, node.nextNodeId, '后继')
      continue
    }
    if (node.type === 'decision') {
      const supportedAnswers = SUPPORTED_DECISION_ANSWERS.get(node.id)
      if (!supportedAnswers) {
        failValidation(`decision 节点 "${node.id}" 不受决策引擎固定输入支持`)
      }
      if (typeof node.question !== 'string' || !node.question.trim()) {
        failValidation(`decision 节点 "${node.id}" 缺少问题描述`)
      }
      if (node.question.length > MAX_QUESTION_LENGTH) {
        failValidation(`decision 节点 "${node.id}" 的问题不能超过 ${MAX_QUESTION_LENGTH} 个字符`)
      }
      if (!Array.isArray(node.branches) || node.branches.length !== supportedAnswers.size) {
        failValidation(`decision 节点 "${node.id}" 必须且只能包含分支: ${[...supportedAnswers].join('、')}`)
      }
      const answers = new Set()
      for (const [branchIndex, branch] of node.branches.entries()) {
        if (!isRecord(branch)) failValidation(`节点 "${node.id}" 的第 ${branchIndex + 1} 个分支必须是对象`)
        if (typeof branch.answer !== 'string' || !branch.answer.trim()) {
          failValidation(`节点 "${node.id}" 的第 ${branchIndex + 1} 个分支缺少答案`)
        }
        if (answers.has(branch.answer)) failValidation(`节点 "${node.id}" 存在重复答案 "${branch.answer}"`)
        answers.add(branch.answer)
        addTarget(node, branch.nextNodeId, `分支 "${branch.answer}" `)
      }
      const unsupportedAnswers = [...answers].filter(answer => !supportedAnswers.has(answer))
      const missingAnswers = [...supportedAnswers].filter(answer => !answers.has(answer))
      if (unsupportedAnswers.length > 0 || missingAnswers.length > 0) {
        failValidation(`decision 节点 "${node.id}" 的分支答案必须与引擎输入一致: ${[...supportedAnswers].join('、')}`)
      }
      continue
    }
    if (node.type === 'outcome') {
      if (typeof node.result !== 'string' || !node.result.trim()) {
        failValidation(`outcome 节点 "${node.id}" 缺少判定结论`)
      }
      if (!ALLOWED_OUTCOME_RESULTS.has(node.result)) {
        failValidation(`outcome 节点 "${node.id}" 的判定结论 "${node.result}" 不受支持`)
      }
      if (node.conditionSummary !== undefined && (typeof node.conditionSummary !== 'string' || node.conditionSummary.length > MAX_CONDITION_SUMMARY_LENGTH)) {
        failValidation(`outcome 节点 "${node.id}" 的条件摘要不能超过 ${MAX_CONDITION_SUMMARY_LENGTH} 个字符`)
      }
      addTarget(node, node.nextNodeId, '后继')
      if (nodeMap.get(node.nextNodeId).type !== 'end') {
        failValidation(`outcome 节点 "${node.id}" 必须直接指向 end 节点`)
      }
      continue
    }
    if (node.nextNodeId || (Array.isArray(node.branches) && node.branches.length > 0)) {
      failValidation(`end 节点 "${node.id}" 不能包含后继节点或分支`)
    }
  }

  const visitState = new Map()
  const detectCycle = nodeId => {
    const state = visitState.get(nodeId) || 0
    if (state === 1) failValidation(`规则图存在环路，重复进入节点 "${nodeId}"`)
    if (state === 2) return
    visitState.set(nodeId, 1)
    for (const targetId of edges.get(nodeId)) detectCycle(targetId)
    visitState.set(nodeId, 2)
  }
  for (const node of ruleSet.nodes) detectCycle(node.id)

  const reachable = new Set()
  const markReachable = nodeId => {
    if (reachable.has(nodeId)) return
    reachable.add(nodeId)
    for (const targetId of edges.get(nodeId)) markReachable(targetId)
  }
  markReachable(ruleSet.startNodeId)

  const unreachable = ruleSet.nodes.filter(node => !reachable.has(node.id)).map(node => node.id)
  if (unreachable.length > 0) failValidation(`规则图存在不可达节点: ${unreachable.join(', ')}`)

  const longestMemo = new Map()
  const longestPathFrom = nodeId => {
    if (longestMemo.has(nodeId)) return longestMemo.get(nodeId)
    const targets = edges.get(nodeId)
    const length = targets.length === 0 ? 1 : 1 + Math.max(...targets.map(longestPathFrom))
    longestMemo.set(nodeId, length)
    return length
  }
  const longestPath = longestPathFrom(ruleSet.startNodeId)
  if (longestPath > maxPathLength) {
    failValidation(`规则图最长路径为 ${longestPath} 个节点，超过上限 ${maxPathLength}`)
  }

  const outcomePathMemo = new Set()
  const assertOutcomePath = (nodeId, hasOutcome) => {
    const key = `${nodeId}:${hasOutcome ? 1 : 0}`
    if (outcomePathMemo.has(key)) return
    const node = nodeMap.get(nodeId)
    const nextHasOutcome = hasOutcome || node.type === 'outcome'
    if (node.type === 'end' && !nextHasOutcome) {
      failValidation(`存在未经过 outcome 结论节点就到达 end 的路径（终点: "${node.id}"）`)
    }
    for (const targetId of edges.get(nodeId)) assertOutcomePath(targetId, nextHasOutcome)
    outcomePathMemo.add(key)
  }
  assertOutcomePath(ruleSet.startNodeId, false)

  return { nodeCount: nodeMap.size, longestPath }
}

export class RulesStore {
  constructor({ dataDir = DATA_DIR } = {}) {
    this.dataDir = dataDir
    this.indexFile = join(dataDir, 'index.json')
    this.index = null
    this.mutationTail = Promise.resolve()
    this.initPromise = this.init()
  }

  enqueueMutation(operation) {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.catch(() => {})
    return result
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true })
    try {
      const raw = await readFile(this.indexFile, 'utf-8')
      this.index = JSON.parse(raw)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`规则索引读取失败: ${error.message}`)
      this.index = { rules: [], publishedId: null }
      await this.saveIndex()
    }
  }

  async ensureReady() {
    await this.initPromise
  }

  async saveIndex() {
    await writeJsonAtomic(this.indexFile, this.index)
  }

  async list() {
    await this.ensureReady()
    return this.index.rules.map(r => ({
      id: r.id,
      ruleSetName: r.ruleSetName,
      version: r.version,
      status: r.id === this.index.publishedId ? 'published' : (r.publishedAt ? 'archived' : 'draft'),
      updatedAt: r.updatedAt,
      publishedAt: r.publishedAt || null,
    }))
  }

  async get(id) {
    await this.ensureReady()
    const meta = this.index.rules.find(r => r.id === id)
    if (!meta) return null
    const filePath = join(this.dataDir, `${id}.json`)
    const raw = await readFile(filePath, 'utf-8')
    const storedRule = JSON.parse(raw)
    return {
      ...storedRule,
      revision: calculateRuleRevision(storedRule),
      status: id === this.index.publishedId ? 'published' : (meta.publishedAt ? 'archived' : 'draft'),
      publishedAt: meta.publishedAt || null,
    }
  }

  async getPublished() {
    await this.ensureReady()
    if (!this.index.publishedId) return null
    return this.get(this.index.publishedId)
  }

  async getPublishedId() {
    await this.ensureReady()
    return this.index.publishedId || null
  }

  async create(ruleSetName, description, nodes) {
    return this.enqueueMutation(async () => {
      await this.ensureReady()
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      const version = nextVersionForName(this.index.rules, ruleSetName)

      const meta = {
        id,
        ruleSetName,
        version,
        description,
        updatedAt: now,
        status: 'draft',
      }

      const ruleSet = {
        id,
        ruleSetName,
        version,
        description,
        startNodeId: Array.isArray(nodes) ? nodes.find(node => node?.type === 'start')?.id || '' : '',
        nodes,
        updatedAt: now,
        status: 'draft',
      }
      ruleSet.revision = calculateRuleRevision(ruleSet)

      validateRuleSet(ruleSet)

      const ruleFile = join(this.dataDir, `${id}.json`)
      const indexMeta = {
        id: meta.id,
        ruleSetName: meta.ruleSetName,
        version: meta.version,
        updatedAt: meta.updatedAt,
      }
      await writeJsonAtomic(ruleFile, ruleSet)
      this.index.rules.push(indexMeta)
      try {
        await this.saveIndex()
      } catch (error) {
        this.index.rules.pop()
        try {
          await unlink(ruleFile)
        } catch (cleanupError) {
          if (cleanupError?.code !== 'ENOENT') {
            throw new AggregateError([error, cleanupError], '规则创建失败，且未能清理未索引的规则文件')
          }
        }
        throw error
      }
      return ruleSet
    })
  }

  async update(id, updates) {
    return this.enqueueMutation(async () => {
      await this.ensureReady()
      const meta = this.index.rules.find(r => r.id === id)
      if (!meta) throw new Error(`规则 ${id} 不存在`)
      if (this.index.publishedId === id || meta.publishedAt) {
        throw new RuleConflictError('已发布规则不可原地修改，请复制为新草稿后再发布', 'PUBLISHED_RULE_IMMUTABLE')
      }

      const existing = await this.get(id)
      const now = new Date().toISOString()
      const nextRuleSetName = updates.ruleSetName ?? existing.ruleSetName
      const versionCollision = this.index.rules.some(rule => (
        rule.id !== id
        && rule.ruleSetName === nextRuleSetName
        && rule.version === existing.version
      ))
      if (versionCollision) {
        throw new RuleConflictError(
          `规则集 "${nextRuleSetName}" 已存在版本 ${existing.version}，不能通过改名造成版本碰撞`,
          'RULE_VERSION_CONFLICT',
        )
      }

      const updated = {
        ...existing,
        ruleSetName: nextRuleSetName,
        description: updates.description ?? existing.description,
        nodes: updates.nodes ?? existing.nodes,
        startNodeId: updates.nodes !== undefined
          ? (Array.isArray(updates.nodes) ? updates.nodes.find(node => node?.type === 'start')?.id || '' : '')
          : existing.startNodeId,
        updatedAt: now,
        status: existing.status,
      }
      updated.revision = calculateRuleRevision(updated)
      validateRuleSet(updated)

      const ruleFile = join(this.dataDir, `${id}.json`)
      const previousMetaUpdatedAt = meta.updatedAt
      const previousMetaName = meta.ruleSetName
      await writeJsonAtomic(ruleFile, updated)
      meta.updatedAt = now
      if (updates.ruleSetName) meta.ruleSetName = updates.ruleSetName
      try {
        await this.saveIndex()
      } catch (error) {
        meta.updatedAt = previousMetaUpdatedAt
        meta.ruleSetName = previousMetaName
        try {
          await writeJsonAtomic(ruleFile, existing)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], '规则索引更新失败，且规则文件回滚失败')
        }
        throw error
      }
      return updated
    })
  }

  async publish(id) {
    const transition = await this.publishWithPrevious(id)
    return transition.rule
  }

  async publishWithPrevious(id) {
    return this.enqueueMutation(async () => {
      await this.ensureReady()
      const meta = this.index.rules.find(r => r.id === id)
      if (!meta) throw new Error(`规则 ${id} 不存在`)

      const rule = await this.get(id)
      validateRuleSet(rule)

      const previousPublishedId = this.index.publishedId || null
      const publishedAt = new Date().toISOString()
      const targetPublishedAt = meta.publishedAt
      const previousMeta = previousPublishedId
        ? this.index.rules.find(indexMeta => indexMeta.id === previousPublishedId)
        : null
      const previousRulePublishedAt = previousMeta?.publishedAt
      meta.publishedAt ||= publishedAt
      if (previousMeta) previousMeta.publishedAt ||= publishedAt
      this.index.publishedId = id
      try {
        await this.saveIndex()
      } catch (error) {
        this.index.publishedId = previousPublishedId
        if (targetPublishedAt === undefined) delete meta.publishedAt
        else meta.publishedAt = targetPublishedAt
        if (previousMeta) {
          if (previousRulePublishedAt === undefined) delete previousMeta.publishedAt
          else previousMeta.publishedAt = previousRulePublishedAt
        }
        throw error
      }
      return {
        previousPublishedId,
        rule: { ...rule, status: 'published', publishedAt: meta.publishedAt },
      }
    })
  }

  async restorePublishedId(previousPublishedId, expectedCurrentId) {
    return this.enqueueMutation(async () => {
      await this.ensureReady()
      const normalizedPreviousId = previousPublishedId || null
      if (expectedCurrentId !== undefined && this.index.publishedId !== expectedCurrentId) {
        throw new RuleConflictError(
          `发布回滚冲突：当前已发布规则为 "${this.index.publishedId || '无'}"，预期为 "${expectedCurrentId || '无'}"`,
          'PUBLISH_ROLLBACK_CONFLICT',
        )
      }
      if (normalizedPreviousId && !this.index.rules.some(rule => rule.id === normalizedPreviousId)) {
        throw new Error(`无法回滚：原已发布规则 ${normalizedPreviousId} 不存在`)
      }

      const currentPublishedId = this.index.publishedId || null
      this.index.publishedId = normalizedPreviousId
      try {
        await this.saveIndex()
      } catch (error) {
        this.index.publishedId = currentPublishedId
        throw error
      }
      return normalizedPreviousId
    })
  }

  async remove(id) {
    return this.enqueueMutation(async () => {
      await this.ensureReady()
      const idx = this.index.rules.findIndex(r => r.id === id)
      if (idx === -1) return false

      const meta = this.index.rules[idx]
      if (this.index.publishedId === id || meta.publishedAt) {
        throw new RuleConflictError('已发布规则不可删除，历史版本必须作为审计快照保留', 'PUBLISHED_RULE_IMMUTABLE')
      }

      const [removedMeta] = this.index.rules.splice(idx, 1)
      try {
        await this.saveIndex()
      } catch (error) {
        this.index.rules.splice(idx, 0, removedMeta)
        throw error
      }

      try {
        await unlink(join(this.dataDir, `${id}.json`))
      } catch { /* file already gone */ }

      return true
    })
  }

  async getDecisionTreePayload(id) {
    await this.ensureReady()
    const targetId = id || this.index.publishedId
    if (!targetId) return null

    const rule = await this.get(targetId)
    if (!rule) return null

    validateRuleSet(rule)

    return {
      id: rule.id,
      revision: rule.revision,
      ruleSetName: rule.ruleSetName,
      version: rule.version,
      description: rule.description,
      startNodeId: rule.startNodeId,
      nodes: rule.nodes,
    }
  }
}

export const store = new RulesStore()
