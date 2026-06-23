import type { FastifyInstance } from 'fastify'
import type { CaseSubmission, ApiResponse, DecisionResult } from '../types.js'
import { requestDecision } from '../clients/decision-engine.js'

export async function caseRoutes(app: FastifyInstance) {
  app.post('/api/v1/cases/decide', async (request, reply) => {
    const submission = request.body as CaseSubmission

    const caseId = `CASE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const decisionReq = {
      caseId,
      symptoms: submission.symptoms,
      installStatus: submission.installStatus,
      authPersonnel: submission.authPersonnel,
      packageDamage: submission.packageDamage,
      faultLinks: submission.faultLinks,
      touchFeel: submission.touchFeel,
    }

    const result = await requestDecision(decisionReq)

    if (!result.success) {
      return reply.status(502).send(result)
    }

    const response: ApiResponse<{
      caseId: string
      decision: DecisionResult
    }> = {
      success: true,
      data: {
        caseId,
        decision: result.data!,
      },
    }

    return reply.status(200).send(response)
  })
}
