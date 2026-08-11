const DEFAULT_RULES = {
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

export class DecisionTree {
  constructor(ruleSet) {
    this.ruleSet = ruleSet || DEFAULT_RULES
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

  evaluate(answers) {
    const path = []
    let currentNode = this.startNode

    while (currentNode && currentNode.type !== 'outcome' && currentNode.type !== 'end') {
      if (currentNode.type === 'start') {
        const nextId = currentNode.nextNodeId
        if (!nextId) break
        currentNode = this.nodeMap.get(nextId)
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

        currentNode = this.nodeMap.get(matchedBranch.nextNodeId)
        continue
      }

      break
    }

    let outcome = '未到达判定结论'
    let conditionSummary = ''

    if (currentNode && currentNode.type === 'outcome') {
      outcome = currentNode.result
      conditionSummary = currentNode.conditionSummary
    }

    return { outcome, conditionSummary, path }
  }

  reloadRuleSet(ruleSet) {
    this.ruleSet = ruleSet
  }
}


