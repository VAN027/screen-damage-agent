import type { DecisionNode } from '../types.js'
import type { RuleSet, RuleNode, DecisionBranch } from './types.js'
import { DEFAULT_RULES } from './default-rules.js'

export interface EvaluationResult {
  outcome: string
  conditionSummary: string
  path: DecisionNode[]
}

export class DecisionTree {
  private ruleSet: RuleSet

  constructor(ruleSet?: RuleSet) {
    this.ruleSet = ruleSet ?? DEFAULT_RULES
  }

  get nodeMap(): Map<string, RuleNode> {
    const map = new Map<string, RuleNode>()
    for (const node of this.ruleSet.nodes) {
      map.set(node.id, node)
    }
    return map
  }

  get startNode(): RuleNode {
    const node = this.nodeMap.get(this.ruleSet.startNodeId)
    if (!node) throw new Error(`起始节点 ${this.ruleSet.startNodeId} 不存在`)
    return node
  }

  evaluate(answers: Record<string, string>): EvaluationResult {
    const path: DecisionNode[] = []
    let currentNode = this.startNode

    while (currentNode.type !== 'outcome' && currentNode.type !== 'end') {
      if (currentNode.type === 'start') {
        const nextId = this.findNext(currentNode)
        if (!nextId) break
        currentNode = this.nodeMap.get(nextId)!
        continue
      }

      if (currentNode.type === 'decision') {
        const userAnswer = answers[currentNode.id]
        if (!userAnswer) {
          throw new Error(`缺少决策节点 ${currentNode.id}("${currentNode.question}") 的答案`)
        }

        const matchedBranch = currentNode.branches.find(
          (b: DecisionBranch) => b.answer === userAnswer
        )

        if (!matchedBranch) {
          throw new Error(
            `节点 ${currentNode.id}("${currentNode.question}") 的答案 "${userAnswer}" 不匹配任何分支`
          )
        }

        path.push({
          nodeId: currentNode.id,
          question: currentNode.question,
          answer: userAnswer,
          timestamp: new Date().toISOString(),
        })

        const nextNode = this.nodeMap.get(matchedBranch.nextNodeId)
        if (!nextNode) break
        currentNode = nextNode
        continue
      }

      break
    }

    let outcome = '未到达判定结论'
    let conditionSummary = ''

    if (currentNode.type === 'outcome') {
      outcome = currentNode.result
      conditionSummary = currentNode.conditionSummary
    }

    return { outcome, conditionSummary, path }
  }

  private findNext(node: RuleNode): string | null {
    if (node.type === 'start' && 'nextNodeId' in node) {
      return (node as { nextNodeId?: string }).nextNodeId ?? null
    }
    const nodeMap = this.nodeMap
    for (const [, n] of nodeMap) {
      if (n.type === 'decision') {
        for (const b of n.branches) {
          if (b.nextNodeId === node.id) return null
        }
      }
    }
    return null
  }

  get currentVersion(): string {
    return this.ruleSet.version
  }

  reloadRuleSet(ruleSet: RuleSet): void {
    this.ruleSet = ruleSet
  }
}
