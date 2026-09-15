// 所有 Node.js 微服务共用的 HTTP 服务器工具
import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'

const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 50 * 1024 * 1024
const rateBuckets = new Map()
const concurrencyBuckets = new Map()

export class HttpError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message)
    this.name = 'HttpError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

/**
 * route 可选安全属性：
 *   auth: 'admin' | 'internal' | ['admin', 'internal']
 *   rateLimit: 每分钟最大请求数，或 { max, windowMs }
 *   globalRateLimit: 跨客户端共享的总量上限，格式同 rateLimit
 *   globalRateLimits: 多个跨客户端共享上限（例如分钟限额 + 每日预算）
 */
export function createServer(routes, port, name) {
  const server = http.createServer(async (req, res) => {
    setCors(req, res)
    setSecurityHeaders(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    let parsedUrl
    try {
      parsedUrl = new URL(req.url || '/', safeRequestBase(req))
    } catch {
      return json(res, 400, { success: false, error: { code: 'INVALID_URL', message: '请求地址无效' } })
    }

    const route = routes.find(r => r.method === req.method && r.path === parsedUrl.pathname)
    if (!route) {
      return json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: `路由不存在: ${req.method} ${parsedUrl.pathname}` } })
    }

    let releaseConcurrency = null
    try {
      authorizeRequest(req, route.auth)
      enforceRateLimit(req, route)
      // 大请求必须先获得容量再读取请求体，避免并发 Buffer/JSON 聚合耗尽内存。
      releaseConcurrency = acquireConcurrency(route)

      let body = null
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        body = await parseBody(req, route.maxBodyBytes)
      }
      const params = { body, query: Object.fromEntries(parsedUrl.searchParams) }
      await route.handler(req, res, params)
    } catch (err) {
      if (res.writableEnded) return
      if (err.code === 'CAPACITY_LIMITED') req.resume()
      const status = Number(err.statusCode) || 500
      const code = err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR')
      json(res, status, {
        success: false,
        error: {
          code,
          message: status >= 500 && !err.expose ? '服务暂时不可用' : err.message,
          ...(err.details === undefined ? {} : { details: err.details }),
        },
      })
      if (status >= 500) console.error(`[${name}] ${req.method} ${parsedUrl.pathname}:`, err.message)
    } finally {
      releaseConcurrency?.()
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

/**
 * 获取跨路由共享的进程内并发名额。返回的释放函数幂等。
 * route.concurrencyLimit: number | { key, max }
 */
export function acquireConcurrency(route) {
  const raw = route?.concurrencyLimit
  if (!raw) return null
  const max = typeof raw === 'number' ? raw : Number(raw.max)
  if (!Number.isFinite(max) || max <= 0) return null
  const routeKey = `${route.method || 'ANY'}:${route.path || 'unknown'}`
  const key = typeof raw === 'object' && raw.key ? String(raw.key) : routeKey
  const current = concurrencyBuckets.get(key) || 0
  if (current >= max) {
    const error = new HttpError(429, 'CAPACITY_LIMITED', '服务当前请求较多，请稍后重试', { retryAfter: 1 })
    error.expose = true
    throw error
  }
  concurrencyBuckets.set(key, current + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (concurrencyBuckets.get(key) || 1) - 1
    if (remaining > 0) concurrencyBuckets.set(key, remaining)
    else concurrencyBuckets.delete(key)
  }
}

function safeRequestBase(req) {
  const rawHost = String(req.headers.host || 'localhost')
  const host = /^[A-Za-z0-9.:[\]-]+$/.test(rawHost) ? rawHost : 'localhost'
  return `http://${host}`
}

function tokenMatches(actual, expected) {
  if (!actual || !expected) return false
  const a = Buffer.from(String(actual))
  const b = Buffer.from(String(expected))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function bearerToken(req) {
  const value = String(req.headers.authorization || '')
  const match = value.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

function matchesAuth(req, authType) {
  if (authType === 'admin') {
    const expected = process.env.ADMIN_API_TOKEN || ''
    if (!expected) return { configured: false, matched: false }
    return { configured: true, matched: tokenMatches(bearerToken(req), expected) }
  }
  if (authType === 'internal') {
    const expected = process.env.INTERNAL_SERVICE_TOKEN || ''
    if (!expected) return { configured: false, matched: false }
    return { configured: true, matched: tokenMatches(req.headers['x-internal-token'], expected) }
  }
  return { configured: false, matched: false, invalid: true }
}

export function authorizeRequest(req, authPolicy) {
  if (!authPolicy) return
  const policies = Array.isArray(authPolicy) ? authPolicy : [authPolicy]
  const checks = policies.map(policy => matchesAuth(req, policy))
  if (checks.some(check => check.invalid)) {
    throw new HttpError(500, 'INVALID_AUTH_POLICY', '接口鉴权策略配置错误')
  }
  if (checks.some(check => check.configured && check.matched)) return
  if (!checks.some(check => check.configured)) {
    const err = new HttpError(503, 'AUTH_NOT_CONFIGURED', '接口访问令牌尚未配置')
    err.expose = true
    throw err
  }
  const err = new HttpError(401, 'UNAUTHORIZED', '访问令牌无效或缺失')
  err.expose = true
  throw err
}

function getClientIp(req) {
  const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  const trustedPeers = new Set(String(process.env.TRUSTED_PROXY_IPS || '')
    .split(',').map(value => value.trim().replace(/^::ffff:/, '')).filter(Boolean))
  const peerIsTrusted = remote === '127.0.0.1' || remote === '::1' || trustedPeers.has(remote)
  if (process.env.TRUST_PROXY === '1' && peerIsTrusted) {
    const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(value => value.trim()).filter(Boolean)
    // 只信任紧邻代理追加的最右一项，避免客户端预置伪造的首项绕过限流。
    if (chain.length > 0) return chain.at(-1)
  }
  return remote || 'unknown'
}

function enforceRateLimit(req, route) {
  const consume = (rawConfig, key) => {
    if (!rawConfig) return
    const conf = typeof rawConfig === 'number'
      ? { max: rawConfig, windowMs: 60_000 }
      : { max: rawConfig.max, windowMs: rawConfig.windowMs || 60_000 }
    if (!Number.isFinite(conf.max) || conf.max <= 0) return

    const now = Date.now()
    let bucket = rateBuckets.get(key)
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + conf.windowMs }
    bucket.count += 1
    rateBuckets.set(key, bucket)

    if (bucket.count > conf.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      const err = new HttpError(429, 'RATE_LIMITED', `请求过于频繁，请在 ${retryAfter} 秒后重试`, { retryAfter })
      err.expose = true
      throw err
    }
  }

  const routeKey = `${route.method}:${route.path}`
  consume(route.rateLimit, `${getClientIp(req)}:${routeKey}`)
  const globalLimits = Array.isArray(route.globalRateLimits)
    ? route.globalRateLimits
    : (route.globalRateLimit ? [route.globalRateLimit] : [])
  for (const limit of globalLimits) {
    const globalKey = typeof limit === 'object' && limit.key ? String(limit.key) : routeKey
    const windowMs = typeof limit === 'object' && Number.isFinite(limit.windowMs) ? limit.windowMs : 60_000
    // 将窗口纳入桶键，允许同一业务键同时配置分钟突发限额和每日预算。
    consume(limit, `global:${globalKey}:${windowMs}`)
  }

  const now = Date.now()
  if (rateBuckets.size > 10_000) {
    for (const [key, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(key)
    while (rateBuckets.size > 10_000) {
      let oldestClientKey = null
      for (const key of rateBuckets.keys()) {
        if (!key.startsWith('global:')) { oldestClientKey = key; break }
      }
      if (!oldestClientKey) break
      rateBuckets.delete(oldestClientKey)
    }
  }
}

function allowedOrigins(req) {
  const configured = String(process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',').map(v => v.trim()).filter(Boolean)
  const sameOrigin = []
  if (req?.headers?.host) sameOrigin.push(`http://${req.headers.host}`, `https://${req.headers.host}`)
  return new Set([...configured, ...sameOrigin])
}

// 兼容旧的 setCors(res) 调用；新代码应使用 setCors(req, res)。
export function setCors(reqOrRes, maybeRes) {
  const req = maybeRes ? reqOrRes : null
  const res = maybeRes || reqOrRes
  const origin = req ? String(req.headers.origin || '') : ''
  if (origin && allowedOrigins(req).has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Internal-Token')
  res.setHeader('Access-Control-Max-Age', '600')
}

export function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()')
}

export function json(res, status, data) {
  if (res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

export function parseBody(req, configuredMaxBytes) {
  const maxBodyBytes = Number(configuredMaxBytes) || DEFAULT_MAX_BODY_BYTES
  const contentLength = Number.parseInt(req.headers['content-length'], 10)
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    const err = new HttpError(413, 'PAYLOAD_TOO_LARGE', `请求体超过 ${Math.round(maxBodyBytes / 1024 / 1024)}MB 上限`)
    err.expose = true
    req.resume()
    return Promise.reject(err)
  }

  return new Promise((resolve, reject) => {
    const chunks = []
    let totalBytes = 0
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      reject(err)
    }

    req.on('data', chunk => {
      if (settled) return
      totalBytes += chunk.length
      if (totalBytes > maxBodyBytes) {
        const err = new HttpError(413, 'PAYLOAD_TOO_LARGE', `请求体超过 ${Math.round(maxBodyBytes / 1024 / 1024)}MB 上限`)
        err.expose = true
        fail(err)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        const err = new HttpError(400, 'INVALID_JSON', '请求体 JSON 解析失败')
        err.expose = true
        reject(err)
      }
    })
    req.on('error', err => fail(new HttpError(400, 'REQUEST_STREAM_ERROR', err.message)))
    req.on('aborted', () => fail(new HttpError(400, 'REQUEST_ABORTED', '客户端已中止请求')))
  })
}

export function fetchJson(url, options = {}) {
  const timeout = options.timeout ?? 5000
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const target = new URL(url)
  const transport = target.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      family: options.family ?? 4,
      timeout,
    }, res => {
      const chunks = []
      let bytes = 0
      res.on('data', chunk => {
        bytes += chunk.length
        if (bytes > maxResponseBytes) {
          req.destroy(new Error('上游响应超过大小限制'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let payload = null
        try {
          payload = raw ? JSON.parse(raw) : null
        } catch (e) {
          const err = new HttpError(502, 'UPSTREAM_INVALID_JSON', `上游 JSON 解析失败: ${e.message}`)
          err.expose = true
          return reject(err)
        }

        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
          const message = payload?.error?.message || payload?.detail || `上游返回 HTTP ${res.statusCode}`
          const err = new HttpError(res.statusCode || 502, payload?.error?.code || 'UPSTREAM_ERROR', message, payload)
          err.expose = true
          err.upstreamBody = payload
          return reject(err)
        }
        resolve(payload)
      })
    })

    req.on('error', err => {
      if (err instanceof HttpError) return reject(err)
      const wrapped = new HttpError(502, 'UPSTREAM_NETWORK_ERROR', `HTTP ${options.method || 'GET'} ${target.origin} 失败: ${err.message}`)
      wrapped.expose = true
      reject(wrapped)
    })
    req.on('timeout', () => req.destroy(new Error(`请求超时 (${timeout}ms)`)))
    if (options.body !== undefined && options.body !== null) req.write(JSON.stringify(options.body))
    req.end()
  })
}
