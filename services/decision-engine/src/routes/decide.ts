import type { FastifyInstance } from 'fastify'
import type { DecisionRequest, ApiResponse, DecisionResult, DecisionOutcome } from '../types.js'
import { DecisionTree } from '../engine/DecisionTree.js'
import { calculateConfidence, needsExpertReview } from '../engine/ConfidenceScorer.js'
import type { EvaluationResult } from '../engine/DecisionTree.js'

const decisionTree = new DecisionTree()

function buildAnswers(req: DecisionRequest): Record<string, string> {
  const a: Record<string, string> = {}

  a['decision_installed'] = req.installStatus === 'installed' ? '是' : '否'

  if (req.installStatus === 'not_installed') {
    a['decision_auth_personnel'] = req.authPersonnel === 'yes' ? '是' : '否'
  }

  if (req.installStatus === 'not_installed' && req.authPersonnel === 'yes') {
    a['decision_package_damage'] = req.packageDamage === 'damaged' ? '有破损' : '无破损'
  }

  if (req.packageDamage !== 'damaged') {
    const hasProductFactor = req.faultLinks.includes('product_factor')
    a['decision_product_factor'] = hasProductFactor ? '是' : '否'
  } else {
    const hasLogistics = req.faultLinks.includes('logistics_transport')
    a['decision_logistics_factor'] = hasLogistics ? '是' : '否'
  }

  const hasInstallUse =
    req.faultLinks.includes('unboxing_install') || req.faultLinks.includes('usage_mishandling')
  a['decision_install_use'] = hasInstallUse ? '是' : '否'

  return a
}

function outcomeToEnum(outcome: string): DecisionOutcome {
  if (outcome === '产品质量问题') return 'product_quality_issue'
  if (outcome === '物流问题') return 'logistics_issue'
  if (outcome === '需进一步综合判定') return 'needs_further_review'
  return 'not_product_quality'
}

export async function decideRoutes(app: FastifyInstance) {
  app.post('/api/decision/evaluate', async (request, reply) => {
    const req = request.body as DecisionRequest

    const answers = buildAnswers(req)
    const evalResult: EvaluationResult = decisionTree.evaluate(answers)

    const confidence = calculateConfidence({
      evaluationResult: evalResult,
      symptomCount: req.symptoms.length,
      hasImpactPoint: req.hasImpactPoint,
      hasButterflyPattern: req.hasButterflyPattern,
      hasLeakIrregular: req.crackLocation !== undefined,
    })

    const result: DecisionResult = {
      caseId: req.caseId,
      result: outcomeToEnum(evalResult.outcome),
      resultLabel: evalResult.outcome,
      confidence,
      needExpertReview: needsExpertReview(confidence),
      decisionPath: evalResult.path,
      ruleVersion: decisionTree.currentVersion,
    }

    const response: ApiResponse<DecisionResult> = {
      success: true,
      data: result,
    }

    return reply.status(200).send(response)
  })
}
