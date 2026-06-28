// 所有 Node.js 微服务共用的 HTTP 服务器工具
// 使用方式: import { createServer, json, fetchJson } from '../../shared/server-utils.mjs'
import http from 'node:http'

export function createServer(routes, port, name) {
  const server = http.createServer(async (req, res) => {
    setCors(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const { pathname } = new URL(req.url, `http://${req.headers.host}`)
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

export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

export function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

export function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(new Error('请求体 JSON 解析失败'))
      }
    })
    req.on('error', reject)
  })
}

export function fetchJson(url, options = {}) {
  const timeout = options.timeout ?? 5000
  return new Promise((resolve, reject) => {
    const { hostname, port, pathname, search } = new URL(url)
    const req = http.request({
      hostname,
      port: port || 80,
      path: pathname + (search || ''),
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      family: 4,
      timeout,
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error(`JSON解析失败: ${e.message}, 原始数据: ${data.substring(0, 200)}`)) }
      })
    })
    req.on('error', (err) => reject(new Error(`HTTP ${options.method || 'GET'} ${url} 失败: ${err.message}`)))
    req.on('timeout', () => { req.destroy(); reject(new Error(`请求超时: ${url}`)) })
    if (options.body) req.write(JSON.stringify(options.body))
    req.end()
  })
}
