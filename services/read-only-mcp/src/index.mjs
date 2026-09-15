import http from 'node:http'
import crypto from 'node:crypto'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createReadOnlyKnowledgeStore } from './store.mjs'
import { buildMcpServer } from './tools.mjs'

const PORT = Number.parseInt(process.env.MCP_PORT || '8090', 10)
const HOST = process.env.SERVICE_HOST || '127.0.0.1'
const MAX_BODY_BYTES = 1024 * 1024
const RATE_LIMIT = Math.max(10, Number.parseInt(process.env.MCP_REQUESTS_PER_MINUTE || '120', 10) || 120)
const TOKEN = String(process.env.MCP_API_TOKEN || '')
const allowedHosts = new Set(String(process.env.MCP_ALLOWED_HOSTS || 'localhost,127.0.0.1,::1,knowledge-mcp')
  .split(',').map(value => value.trim().toLowerCase()).filter(Boolean))
const rateBuckets = new Map()

function json(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(payload)
}

function requestHostname(value) {
  try { return new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, '').toLowerCase() } catch { return '' }
}

function headersAllowed(req) {
  const host = requestHostname(req.headers.host || '')
  if (!host || !allowedHosts.has(host)) return false
  const origin = req.headers.origin
  if (!origin) return true
  try { return allowedHosts.has(new URL(origin).hostname.toLowerCase()) } catch { return false }
}

function authorized(req, expectedToken) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)
  if (!match) return false
  const provided = Buffer.from(match[1])
  const expected = Buffer.from(expectedToken)
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected)
}

function rateAllowed(req) {
  const now = Date.now()
  const key = req.socket.remoteAddress || 'unknown'
  const bucket = rateBuckets.get(key)
  if (!bucket || now - bucket.startedAt >= 60000) {
    rateBuckets.set(key, { startedAt: now, count: 1 })
    return true
  }
  bucket.count++
  return bucket.count <= RATE_LIMIT
}

export function startReadOnlyMcpServer(options = {}) {
  const token = options.token || TOKEN
  if (typeof token !== 'string' || token.length < 32) throw new Error('MCP_API_TOKEN 必须设置且至少 32 个字符')
  if (!Number.isSafeInteger(options.port ?? PORT) || (options.port ?? PORT) < 0 || (options.port ?? PORT) > 65535) {
    throw new Error('MCP_PORT 不合法')
  }
  const store = options.store || createReadOnlyKnowledgeStore(options.dbPath)
  const handler = createMcpHandler(() => buildMcpServer(store))
  const nodeHandler = toNodeHandler(handler)
  const server = http.createServer((req, res) => {
    let url
    try { url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`) } catch {
      return json(res, 400, { error: 'Invalid request URL' })
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      return json(res, 200, { service: 'screen-damage-read-only-mcp', status: 'ok', readOnly: true })
    }
    if (url.pathname !== '/mcp') return json(res, 404, { error: 'Not found' })
    if (!headersAllowed(req)) return json(res, 403, { error: 'Host or Origin is not allowed' })
    if (!authorized(req, token)) {
      return json(res, 401, { error: 'Invalid bearer token' }, { 'WWW-Authenticate': 'Bearer realm="screen-damage-read-only-mcp"' })
    }
    if (!rateAllowed(req)) return json(res, 429, { error: 'Rate limit exceeded' }, { 'Retry-After': '60' })
    const contentLength = Number(req.headers['content-length'] || 0)
    if (contentLength > MAX_BODY_BYTES) return json(res, 413, { error: 'Request body too large' })
    void nodeHandler(req, res)
  })
  server.requestTimeout = 30000
  server.headersTimeout = 10000
  server.keepAliveTimeout = 5000
  server.listen(options.port ?? PORT, options.host || HOST, () => {
    const address = server.address()
    console.log(`[read-only-mcp] MCP endpoint → http://${options.host || HOST}:${address.port}/mcp`)
  })
  const close = async () => {
    await handler.close()
    await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()))
    store.close?.()
  }
  return { server, handler, store, close }
}

if (process.env.MCP_DISABLE_AUTOSTART !== '1') {
  let running
  try {
    running = startReadOnlyMcpServer()
  } catch (error) {
    console.error('[read-only-mcp] 启动失败:', error.message)
    process.exitCode = 1
  }
  const shutdown = () => running?.close().finally(() => process.exit())
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
