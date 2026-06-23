import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config } from './config.js'
import { healthRoutes } from './routes/health.js'
import { decideRoutes } from './routes/decide.js'

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })

await app.register(healthRoutes)
await app.register(decideRoutes)

try {
  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`[decision-engine] 服务已启动 → http://localhost:${config.port}`)
  console.log(`[decision-engine] 判定接口 → POST http://localhost:${config.port}/api/decision/evaluate`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
