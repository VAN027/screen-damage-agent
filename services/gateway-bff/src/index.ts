import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config } from './config.js'
import { healthRoutes } from './routes/health.js'
import { caseRoutes } from './routes/cases.js'

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })

await app.register(healthRoutes)
await app.register(caseRoutes)

try {
  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`[gateway-bff] 服务已启动 → http://localhost:${config.port}`)
  console.log(`[gateway-bff] 健康检查 → http://localhost:${config.port}/api/health`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
