import type { FastifyInstance } from 'fastify'
import type { HealthCheckResponse } from '../types.js'

const startTime = Date.now()

export async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async (): Promise<HealthCheckResponse> => {
    return {
      service: 'decision-engine',
      status: 'ok',
      uptime: Date.now() - startTime,
      version: '1.0.0',
    }
  })
}
