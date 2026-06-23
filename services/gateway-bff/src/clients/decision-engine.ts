import type { DecisionRequest, DecisionResult, ApiResponse } from '../types.js'
import { config } from '../config.js'

export async function requestDecision(req: DecisionRequest): Promise<ApiResponse<DecisionResult>> {
  const url = `${config.decisionEngine.baseUrl}/api/decision/evaluate`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(config.decisionEngine.timeout),
  })

  if (!response.ok) {
    return {
      success: false,
      error: {
        code: 'DECISION_ENGINE_ERROR',
        message: `决策引擎返回错误: ${response.status}`,
      },
    }
  }

  return response.json() as Promise<ApiResponse<DecisionResult>>
}
