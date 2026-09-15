import http from 'node:http'
import {
  json,
  parseBody,
  fetchJson,
  setCors,
  setSecurityHeaders,
  authorizeRequest,
} from '../../shared/server-utils.mjs'

const KNOWLEDGE_AI_URL = process.env.KNOWLEDGE_AI_URL || 'http://localhost:8083'

export function createServer(routes, port, name) {
  const server = http.createServer(async (req, res) => {
    setCors(req, res)
    setSecurityHeaders(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      return json(res, 400, { success: false, error: { code: 'INVALID_URL', message: '请求地址无效' } })
    }
    const { pathname } = url

    try {
      // 管理后台对 Knowledge-AI 的统一代理：先校验管理员，再以服务令牌访问内网服务。
      if (pathname.startsWith('/api/knowledge/')) {
        authorizeRequest(req, 'admin')
        let body = null
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) body = await parseBody(req)
        const forwardPath = pathname + url.search
        const upstreamHeaders = {
          'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN || '',
          'Authorization': req.headers.authorization || '',
        }

        const isStream = pathname === '/api/knowledge/images'
          || pathname === '/api/knowledge/review/image'
          || pathname === '/api/knowledge/analyze-llm-stream'
          || pathname === '/api/knowledge/eval/batch-analyze'
          || pathname === '/api/knowledge/eval/export-xlsx'
          || pathname === '/api/knowledge/sql-query/export'
        if (isStream) {
          return pipeProxy(req.method, `${KNOWLEDGE_AI_URL}${forwardPath}`, body, req, res, upstreamHeaders)
        }

        const result = await fetchJson(`${KNOWLEDGE_AI_URL}${forwardPath}`, {
          method: req.method,
          body,
          timeout: 120000,
          headers: upstreamHeaders,
        })
        return json(res, 200, result)
      }

      const route = routes.find(r => r.method === req.method && r.path === pathname)
      if (!route) {
        return json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: `路由不存在: ${req.method} ${pathname}` } })
      }

      authorizeRequest(req, route.auth)
      let body = null
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) body = await parseBody(req, route.maxBodyBytes)
      await route.handler(req, res, { body, query: Object.fromEntries(url.searchParams) })
    } catch (err) {
      if (res.writableEnded) return
      const status = Number(err.statusCode) || 500
      const code = err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR')
      if (status >= 500) console.error(`[${name}] ${req.method} ${pathname}:`, err.message)
      return json(res, status, err.upstreamBody || {
        success: false,
        error: { code, message: status >= 500 && !err.expose ? '服务暂时不可用' : err.message },
      })
    }
  })

  server.requestTimeout = 2 * 60 * 1000
  server.headersTimeout = 65 * 1000
  server.keepAliveTimeout = 5 * 1000
  const host = process.env.SERVICE_HOST || '127.0.0.1'
  server.listen(port, host, () => {
    console.log(`[${name}] 服务已启动 → http://${host}:${port}`)
  })
  return server
}

export { json, parseBody, fetchJson, setCors, setSecurityHeaders, authorizeRequest }

export function pipeProxy(method, url, body, clientReq, clientRes, headers = {}) {
  const { hostname, port, pathname, search } = new URL(url)
  const requestBody = body == null ? null : JSON.stringify(body)
  const proxyReq = http.request({
    hostname,
    port: port || 80,
    path: pathname + (search || ''),
    method,
    headers: {
      ...headers,
      ...(requestBody ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
      } : {}),
    },
  }, upstreamRes => {
    const responseHeaders = {
      'Content-Type': upstreamRes.headers['content-type'] || 'application/octet-stream',
      'Cache-Control': upstreamRes.headers['cache-control'] || 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }
    if (upstreamRes.headers['content-length']) responseHeaders['Content-Length'] = upstreamRes.headers['content-length']
    if (upstreamRes.headers['content-disposition']) responseHeaders['Content-Disposition'] = upstreamRes.headers['content-disposition']
    clientRes.writeHead(upstreamRes.statusCode || 502, responseHeaders)
    upstreamRes.pipe(clientRes)
  })

  const timeout = setTimeout(() => proxyReq.destroy(new Error('上游流式请求超时')), 130000)
  const cleanup = () => clearTimeout(timeout)
  clientRes.on('finish', cleanup)
  clientRes.on('close', () => {
    cleanup()
    if (!clientRes.writableEnded) proxyReq.destroy()
  })
  clientReq.on('aborted', () => proxyReq.destroy())
  proxyReq.on('error', err => {
    cleanup()
    if (!clientRes.headersSent) json(clientRes, 502, { success: false, error: { code: 'PROXY_ERROR', message: err.message } })
    else if (!clientRes.writableEnded) clientRes.end()
  })
  if (requestBody) proxyReq.write(requestBody)
  proxyReq.end()
}
