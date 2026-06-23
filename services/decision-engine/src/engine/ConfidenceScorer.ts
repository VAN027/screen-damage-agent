import type { EvaluationResult } from './DecisionTree.js'

export interface ConfidenceInput {
  evaluationResult: EvaluationResult
  symptomCount: number
  hasImpactPoint?: boolean
  hasButterflyPattern?: boolean
  hasLeakIrregular?: boolean
}

export function calculateConfidence(input: ConfidenceInput): number {
  const { evaluationResult, symptomCount } = input

  let baseScore = 70

  if (input.hasImpactPoint && input.hasButterflyPattern) {
    baseScore += 15
  } else if (input.hasImpactPoint || input.hasButterflyPattern) {
    baseScore += 7
  }

  if (input.hasLeakIrregular) {
    baseScore += 8
  }

  if (evaluationResult.path.length >= 3) {
    baseScore += 5
  }

  if (symptomCount >= 3) {
    baseScore += 5
  } else if (symptomCount >= 1) {
    baseScore += 2
  }

  return Math.min(baseScore, 100)
}

export function needsExpertReview(confidence: number): boolean {
  return confidence < 70
}
