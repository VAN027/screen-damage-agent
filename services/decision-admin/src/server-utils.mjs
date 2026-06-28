import http from 'node:http'
import { json, parseBody, fetchJson, setCors } from '../../shared/server-utils.mjs'

const KNOWLEDGE_AI_URL = process.env.KNOWLEDGE_AI_URL || 'http://localhost:8083'

export function createServer(routes, port, name) {
  const server = http.createServer(async (req, res) => {
    setCors(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url, `http://${req.headers.host}`)
    const { pathname } = url

    // 代理 /api/knowledge/* → knowledge-ai (8083)
    if (pathname.startsWith('/api/knowledge/')) {
      try {
        let body = null
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
          body = await parseBody(req)
        }
        const forwardPath = pathname + (url.search || '')

        // 图片、SSE 流等非 JSON 资源：直接透传，不做 JSON 解析
        if (pathname === '/api/knowledge/images' || pathname === '/api/knowledge/analyze-llm-stream') {
          return pipeProxy(req.method, `${KNOWLEDGE_AI_URL}${forwardPath}`, body, res)
        }

        const result = await fetchJson(`${KNOWLEDGE_AI_URL}${forwardPath}`, { method: req.method, body, timeout: 60000 })
        return json(res, 200, result)
      } catch (err) {
        return json(res, 502, { success: false, error: { code: 'PROXY_ERROR', message: err.message } })
      }
    }

    // Fallthrough to manual routes
    const route = routes.find(r => r.method === req.method && r.path === pathname)

    if (!route) {
      json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: `路由不存在: ${req.method} ${pathname}` } })
      return
    }

    try {
      let body = null
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        body = await parseBody(req)
      }
      const params = { body, query: Object.fromEntries(new URL(req.url, `http://${req.headers.host}`).searchParams) }
      await route.handler(req, res, params)
    } catch (err) {
      json(res, 500, { success: false, error: { code: 'INTERNAL_ERROR', message: err.message } })
    }
  })

  server.listen(port, '0.0.0.0', () => {
    console.log(`[${name}] 服务已启动 → http://localhost:${port}`)
  })

  return server
}

export { json, parseBody, fetchJson, setCors }

// 通用 HTTP 代理：透传请求和响应（用于图片等二进制资源）
function pipeProxy(method, url, body, clientRes) {
  const { hostname, port, pathname, search } = new URL(url)
  const proxyReq = http.request({
    hostname,
    port: port || 80,
    path: pathname + (search || ''),
    method,
    headers: { 'Content-Type': 'application/json' },
  }, upstreamRes => {
    const ct = upstreamRes.headers['content-type'] || 'application/octet-stream'
    const headers = {
      'Content-Type': ct,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': upstreamRes.headers['cache-control'] || 'public, max-age=86400',
    }
    if (upstreamRes.headers['content-length']) {
      headers['Content-Length'] = upstreamRes.headers['content-length']
    }
    clientRes.writeHead(upstreamRes.statusCode, headers)
    upstreamRes.pipe(clientRes)
  })
  proxyReq.on('error', () => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502)
      clientRes.end()
    }
  })
  if (body) proxyReq.write(JSON.stringify(body))
  proxyReq.end()
}
