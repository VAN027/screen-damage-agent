export interface Branch {
  answer: string
  nextNodeId: string
}

export interface StartNode {
  id: string
  type: 'start'
  description: string
  nextNodeId: string
}

export interface DecisionNode {
  id: string
  type: 'decision'
  question: string
  branches: Branch[]
}

export interface OutcomeNode {
  id: string
  type: 'outcome'
  result: string
  conditionSummary: string
  nextNodeId: string
}

export interface EndNode {
  id: string
  type: 'end'
  description: string
}

export type RuleNode = StartNode | DecisionNode | OutcomeNode | EndNode

export interface RuleSet {
  ruleSetName: string
  version: string
  description: string
  startNodeId: string
  nodes: RuleNode[]
}

export type DecisionBranch = Branch
