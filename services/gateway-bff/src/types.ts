export type SymptomCategory =
  | 'linear_streak'
  | 'dot_star'
  | 'patch_leak'
  | 'rainbow_melt'
  | 'polarizer_scratch'

export interface TouchFeelInput {
  hasBumpFeeling: boolean
  crackUnderGlassOnly: boolean
}

export type FaultLink =
  | 'product_factor'
  | 'logistics_transport'
  | 'unboxing_install'
  | 'usage_mishandling'

export interface CaseSubmission {
  symptoms: SymptomCategory[]
  installStatus: 'installed' | 'not_installed'
  authPersonnel: 'yes' | 'no'
  packageDamage: 'none' | 'damaged'
  faultLinks: FaultLink[]
  touchFeel?: TouchFeelInput
}

export type DecisionOutcome =
  | 'product_quality_issue'
  | 'logistics_issue'
  | 'not_product_quality'
  | 'needs_further_review'

export interface DecisionNode {
  nodeId: string
  question: string
  answer: string
  timestamp: string
}

export interface DecisionResult {
  caseId: string
  result: DecisionOutcome
  resultLabel: string
  confidence: number
  needExpertReview: boolean
  decisionPath: DecisionNode[]
  ruleVersion: string
}

export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
  }
}

export interface HealthCheckResponse {
  service: string
  status: 'ok' | 'degraded'
  uptime: number
  version: string
}
