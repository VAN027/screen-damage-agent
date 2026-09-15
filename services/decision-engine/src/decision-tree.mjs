const DEFAULT_RULES = {
  id: 'builtin-default',
  revision: 'builtin-default-v1',
  ruleSetName: '屏损故障原因判定规则',
  version: '1.0',
  description: '根据安装状态、开箱授权、包装状况和故障环节，判断屏损故障的责任归属',
  startNodeId: 'node_start',
  nodes: [
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
  ],
}

export const MAX_RULE_PATH_LENGTH = 100
export const MAX_RULE_NODES = 200
const MAX_RULE_NAME_LENGTH = 128
const MAX_RULE_DESCRIPTION_LENGTH = 4000
const MAX_NODE_DESCRIPTION_LENGTH = 1000
const MAX_QUESTION_LENGTH = 500
const MAX_CONDITION_SUMMARY_LENGTH = 2000
const ALLOWED_NODE_TYPES = new Set(['start', 'decision', 'outcome', 'end'])
const ALLOWED_OUTCOME_RESULTS = new Set([
  '质量问题', '产品质量问题',
  '非质量问题', '非产品质量问题',
  '屏幕完好',
  '人工复核', '需人工复核', '进一步鉴定',
])
// buildAnswers() in index.mjs is the only production source of decision
// answers. Reject graphs it can never execute instead of allowing a publish
// that will fail later for every request.
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

function failValidation(message) {
  throw new RuleValidationError(message)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate the complete executable graph, rather than only validating the JSON
 * shape. This function intentionally runs again in the engine even though the
 * admin service validates drafts: a damaged or manually edited data file must
 * never be allowed to block the event loop at evaluation time.
 */
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

  const outcomeNodes = ruleSet.nodes.filter(node => node.type === 'outcome')
  if (outcomeNodes.length === 0) failValidation('规则集至少需要一个 outcome 结论节点')
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
        if (answers.has(branch.answer)) {
          failValidation(`节点 "${node.id}" 存在重复答案 "${branch.answer}"`)
        }
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
      const target = nodeMap.get(node.nextNodeId)
      if (target.type !== 'end') {
        failValidation(`outcome 节点 "${node.id}" 必须直接指向 end 节点`)
      }
      continue
    }

    if (node.nextNodeId || (Array.isArray(node.branches) && node.branches.length > 0)) {
      failValidation(`end 节点 "${node.id}" 不能包含后继节点或分支`)
    }
  }

  // First pass: detect cycles in every component, including malformed
  // unreachable subgraphs, then calculate reachability from the start node.
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
  if (unreachable.length > 0) {
    failValidation(`规则图存在不可达节点: ${unreachable.join(', ')}`)
  }

  // Second pass: calculate the longest path in the now-known DAG.
  const longestMemo = new Map()
  const longestPathFrom = nodeId => {
    if (longestMemo.has(nodeId)) return longestMemo.get(nodeId)
    const targets = edges.get(nodeId)
    const length = targets.length === 0
      ? 1
      : 1 + Math.max(...targets.map(longestPathFrom))
    longestMemo.set(nodeId, length)
    return length
  }
  const longestPath = longestPathFrom(ruleSet.startNodeId)
  if (longestPath > maxPathLength) {
    failValidation(`规则图最长路径为 ${longestPath} 个节点，超过上限 ${maxPathLength}`)
  }

  // Every executable branch must pass through an outcome before reaching end.
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

export class DecisionTree {
  constructor(ruleSet) {
    const initialRuleSet = ruleSet || structuredClone(DEFAULT_RULES)
    validateRuleSet(initialRuleSet)
    this.ruleSet = initialRuleSet
  }

  get nodeMap() {
    const map = new Map()
    for (const node of this.ruleSet.nodes) {
      map.set(node.id, node)
    }
    return map
  }

  get startNode() {
    return this.nodeMap.get(this.ruleSet.startNodeId)
  }

  get currentVersion() {
    return this.ruleSet.version
  }

  get currentRuleId() {
    return this.ruleSet.id || null
  }

  get currentRevision() {
    return this.ruleSet.revision || null
  }

  evaluate(answers) {
    if (!isRecord(answers)) throw new Error('决策答案必须是对象')
    const path = []
    const nodeMap = this.nodeMap
    const visited = new Set()
    let currentNode = this.startNode
    let depth = 0

    while (currentNode) {
      depth++
      if (depth > MAX_RULE_PATH_LENGTH) {
        throw new Error(`规则执行路径超过安全上限 ${MAX_RULE_PATH_LENGTH}`)
      }
      if (visited.has(currentNode.id)) {
        throw new Error(`规则执行检测到环路，重复进入节点 "${currentNode.id}"`)
      }
      visited.add(currentNode.id)

      if (currentNode.type === 'outcome') {
        return {
          outcome: currentNode.result,
          conditionSummary: currentNode.conditionSummary || '',
          path,
        }
      }
      if (currentNode.type === 'end') {
        throw new Error('规则执行在产生判定结论前到达 end 节点')
      }

      if (currentNode.type === 'start') {
        const nextId = currentNode.nextNodeId
        if (!nextId) throw new Error(`start 节点 "${currentNode.id}" 缺少后继节点`)
        currentNode = nodeMap.get(nextId)
        if (!currentNode) throw new Error(`规则执行无法找到节点 "${nextId}"`)
        continue
      }

      if (currentNode.type === 'decision') {
        const userAnswer = answers[currentNode.id]
        if (!userAnswer) {
          throw new Error(`缺少决策节点 "${currentNode.question}" 的答案`)
        }

        const matchedBranch = currentNode.branches.find(b => b.answer === userAnswer)
        if (!matchedBranch) {
          throw new Error(`节点 "${currentNode.question}" 的答案 "${userAnswer}" 不匹配`)
        }

        path.push({
          nodeId: currentNode.id,
          question: currentNode.question,
          answer: userAnswer,
          timestamp: new Date().toISOString(),
        })

        currentNode = nodeMap.get(matchedBranch.nextNodeId)
        if (!currentNode) throw new Error(`规则执行无法找到节点 "${matchedBranch.nextNodeId}"`)
        continue
      }

      throw new Error(`规则执行遇到不支持的节点类型 "${currentNode.type}"`)
    }

    throw new Error('规则执行未到达判定结论')
  }

  reloadRuleSet(ruleSet) {
    validateRuleSet(ruleSet)
    this.ruleSet = ruleSet
  }

  resetToDefault() {
    this.reloadRuleSet(structuredClone(DEFAULT_RULES))
  }
}
