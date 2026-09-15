import { createServer, json, fetchJson, HttpError } from './server-utils.mjs'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.BFF_PORT || '8080', 10)
const DECISION_ENGINE_URL = process.env.DECISION_ENGINE_URL || 'http://localhost:8081'
const KNOWLEDGE_AI_URL = process.env.KNOWLEDGE_AI_URL || 'http://localhost:8083'
const startTime = Date.now()
const configuredLlmGlobalLimit = Number.parseInt(process.env.LLM_GLOBAL_REQUESTS_PER_MINUTE || '30', 10)
const LLM_GLOBAL_REQUESTS_PER_MINUTE = Number.isFinite(configuredLlmGlobalLimit)
  ? Math.min(Math.max(configuredLlmGlobalLimit, 1), 1000)
  : 30
const configuredLlmDailyLimit = Number.parseInt(process.env.LLM_GLOBAL_REQUESTS_PER_DAY || '500', 10)
const LLM_GLOBAL_REQUESTS_PER_DAY = Number.isFinite(configuredLlmDailyLimit)
  ? Math.min(Math.max(configuredLlmDailyLimit, 1), 100000)
  : 500
const configuredLlmConcurrency = Number.parseInt(process.env.LLM_GLOBAL_CONCURRENCY || '2', 10)
const LLM_GLOBAL_CONCURRENCY = Number.isFinite(configuredLlmConcurrency)
  ? Math.min(Math.max(configuredLlmConcurrency, 1), 50)
  : 2
const configuredVectorConcurrency = Number.parseInt(process.env.VECTOR_GLOBAL_CONCURRENCY || '2', 10)
const VECTOR_GLOBAL_CONCURRENCY = Number.isFinite(configuredVectorConcurrency)
  ? Math.min(Math.max(configuredVectorConcurrency, 1), 50)
  : 2
const MAX_MULTI_IMAGE_BODY_BYTES = 22 * 1024 * 1024
const dailyBudgetBuckets = new Map()

export function reserveDailyBudget(key, limit, now = Date.now()) {
  let bucket = dailyBudgetBuckets.get(key)
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + 24 * 60 * 60 * 1000 }
  if (bucket.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    const error = new HttpError(429, 'DAILY_BUDGET_EXHAUSTED', '今日智能分析调用额度已用完，请稍后再试', { retryAfter })
    error.expose = true
    throw error
  }
  bucket.count += 1
  dailyBudgetBuckets.set(key, bucket)
  let refunded = false
  return {
    refund() {
      if (refunded) return
      refunded = true
      bucket.count = Math.max(0, bucket.count - 1)
      dailyBudgetBuckets.set(key, bucket)
    },
  }
}

async function withLlmDailyBudget(operation) {
  const reservation = reserveDailyBudget('llm-analysis', LLM_GLOBAL_REQUESTS_PER_DAY)
  try {
    const outcome = await operation()
    // 无效输入/鉴权等 4xx 没有触发付费模型调用，不消耗每日预算。
    if (outcome?.statusCode >= 400 && outcome.statusCode < 500) reservation.refund()
    return outcome
  } catch (error) {
    reservation.refund()
    throw error
  }
}

function internalHeaders(extra = {}) {
  return { 'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN || '', ...extra }
}

// ---------- 代理辅助函数 ----------

async function proxyToKnowledge(method, path, body, res, options = {}) {
  try {
    const result = await fetchJson(`${KNOWLEDGE_AI_URL}${path}`, {
      method,
      body,
      timeout: options.timeout || 15000,
      headers: internalHeaders(options.headers),
    })
    json(res, 200, result)
    return { statusCode: 200 }
  } catch (err) {
    const statusCode = err.statusCode || 502
    json(res, statusCode, err.upstreamBody || {
      success: false,
      error: { code: err.code || 'PROXY_ERROR', message: err.message },
    })
    return { statusCode }
  }
}

// SSE 流式代理 —— 直接把 knowledge-ai 的 SSE 流透传给客户端
export function proxyStreamToKnowledge(path, body, clientReq, clientRes) {
  return new Promise(resolve => {
    const url = new URL(`${KNOWLEDGE_AI_URL}${path}`)
    const reqBody = body ? JSON.stringify(body) : null
    let settled = false
    let outcomeStatus = 502
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(streamTimer)
      resolve({ statusCode: outcomeStatus })
    }

    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + (url.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': reqBody ? Buffer.byteLength(reqBody) : 0,
        ...internalHeaders(),
      },
    }

    const proxyReq = http.request(options, proxyRes => {
      outcomeStatus = proxyRes.statusCode || 502
      if (proxyRes.statusCode !== 200) {
        let errData = ''
        proxyRes.on('data', c => errData += c)
        proxyRes.on('end', () => {
          const status = proxyRes.statusCode >= 400 && proxyRes.statusCode < 500 ? proxyRes.statusCode : 502
          try { json(clientRes, status, JSON.parse(errData)) }
          catch { json(clientRes, status, { success: false, error: { code: 'UPSTREAM_ERROR', message: `HTTP ${proxyRes.statusCode}` } }) }
        })
        return
      }

      // 透传 SSE 响应头
      clientRes.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      proxyRes.on('error', err => proxyReq.destroy(err))
      proxyRes.pipe(clientRes)
    })

    // 超时覆盖完整响应流；客户端断开时同时终止上游推理。
    const streamTimer = setTimeout(() => proxyReq.destroy(new Error('LLM 流式请求超时')), 130000)
    clientRes.once('close', () => {
      if (!clientRes.writableEnded) proxyReq.destroy()
      finish()
    })
    clientRes.once('finish', finish)
    clientReq.once('aborted', () => proxyReq.destroy())

    proxyReq.on('error', err => {
      if (!clientRes.headersSent) {
        json(clientRes, 502, { success: false, error: { code: 'PROXY_ERROR', message: err.message } })
      } else if (!clientRes.writableEnded) {
        clientRes.write(`data: ${JSON.stringify({ stage: 'error', message: err.message })}\n\n`)
        clientRes.end()
      }
    })

    if (reqBody) proxyReq.write(reqBody)
    proxyReq.end()
  })
}

// 二进制通用代理（图片等非 JSON 资源透传）
export function pipeProxyToKnowledge(method, path, body, clientReq, clientRes) {
  const url = new URL(`${KNOWLEDGE_AI_URL}${path}`)
  const opts = {
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname + (url.search || ''),
    method,
    headers: internalHeaders({ 'Content-Type': 'application/json' }),
  }
  const proxyReq = http.request(opts, upstreamRes => {
    const headers = {
      'Content-Type': upstreamRes.headers['content-type'] || 'application/octet-stream',
      'Cache-Control': upstreamRes.headers['cache-control'] || 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    }
    if (upstreamRes.headers['content-length']) headers['Content-Length'] = upstreamRes.headers['content-length']
    if (upstreamRes.headers['content-disposition']) headers['Content-Disposition'] = upstreamRes.headers['content-disposition']
    clientRes.writeHead(upstreamRes.statusCode, headers)
    upstreamRes.pipe(clientRes)
  })
  proxyReq.on('error', () => {
    if (!clientRes.headersSent) { clientRes.writeHead(502); clientRes.end() }
  })
  proxyReq.setTimeout(15000, () => proxyReq.destroy(new Error('图片服务请求超时')))
  // IncomingMessage 的 close 也会在正常读完请求时触发；以响应连接关闭判断真正断连。
  clientReq.on('aborted', () => proxyReq.destroy())
  clientRes.on('close', () => {
    if (!clientRes.writableEnded) proxyReq.destroy()
  })
  clientReq.on('error', () => {
    proxyReq.destroy()
  })
  if (body) proxyReq.write(JSON.stringify(body))
  proxyReq.end()
}

function buildDecisionRequest(submission, caseId) {
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)) {
    const error = new Error('请求体必须是 JSON 对象')
    error.statusCode = 400
    error.code = 'INVALID_REQUEST'
    error.expose = true
    throw error
  }
  const requireEnum = (value, allowed, field) => {
    if (typeof value !== 'string' || !allowed.has(value)) {
      const error = new Error(`${field} 取值无效或缺失`)
      error.statusCode = 400
      error.code = 'INVALID_REQUEST'
      error.expose = true
      throw error
    }
    return value
  }
  const installStatus = requireEnum(submission.installStatus, new Set(['installed', 'not_installed', 'unknown']), 'installStatus')
  const authPersonnel = requireEnum(submission.authPersonnel, new Set(['yes', 'no', 'unknown']), 'authPersonnel')
  const packageDamage = requireEnum(submission.packageDamage, new Set(['none', 'minor', 'severe', 'damaged', 'unknown']), 'packageDamage')
  if (!Array.isArray(submission.faultLinks)) {
    const error = new Error('faultLinks 必须显式提供数组')
    error.statusCode = 400
    error.code = 'INVALID_REQUEST'
    error.expose = true
    throw error
  }
  const allowedFaultLinks = new Set(['product_factor', 'logistics_transport', 'unboxing_install', 'usage_mishandling', 'unknown'])
  if (submission.faultLinks.length > allowedFaultLinks.size || submission.faultLinks.some(value => typeof value !== 'string' || !allowedFaultLinks.has(value))) {
    const error = new Error('faultLinks 包含不支持的选项')
    error.statusCode = 400
    error.code = 'INVALID_REQUEST'
    error.expose = true
    throw error
  }
  const faultLinks = [...new Set(submission.faultLinks)]
  if (faultLinks.length !== submission.faultLinks.length || (faultLinks.includes('unknown') && faultLinks.length > 1)) {
    const error = new Error('faultLinks 不允许重复，unknown 不能与其他选项并存')
    error.statusCode = 400
    error.code = 'INVALID_REQUEST'
    error.expose = true
    throw error
  }
  const symptoms = submission.symptoms === undefined ? [] : submission.symptoms
  if (!Array.isArray(symptoms) || symptoms.length > 20 || symptoms.some(value => typeof value !== 'string' || value.length > 100)) {
    const error = new Error('symptoms 必须是不超过 20 项的短字符串数组')
    error.statusCode = 400
    error.code = 'INVALID_REQUEST'
    error.expose = true
    throw error
  }

  return {
    caseId,
    symptoms,
    installStatus,
    authPersonnel,
    packageDamage,
    faultLinks,
    touchFeel: submission.touchFeel || null,
    hasImpactPoint: submission.hasImpactPoint || false,
    hasButterflyPattern: submission.hasButterflyPattern || false,
    crackLocation: submission.crackLocation || null,
    leakBoundary: submission.leakBoundary || null,
    scratchLayer: submission.scratchLayer || null,
    conclusion: submission.conclusion || null,
  }
}

const routes = [
  {
    method: 'GET',
    path: '/api/health',
    handler: (_req, res) => {
      json(res, 200, {
        service: 'gateway-bff',
        status: 'ok',
        uptime: Date.now() - startTime,
        version: '1.0.0',
      })
    },
  },
  {
    method: 'POST',
    path: '/api/v1/cases/decide',
    rateLimit: { max: 30, windowMs: 60000 },
    maxBodyBytes: 32 * 1024,
    handler: async (_req, res, { body }) => {
      const submission = body
      const caseId = `CASE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      try {
        const decisionReq = buildDecisionRequest(submission, caseId)
        const engineResult = await fetchJson(`${DECISION_ENGINE_URL}/api/decision/evaluate`, {
          method: 'POST',
          body: decisionReq,
          headers: { 'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN || '' },
        })

        json(res, 200, {
          success: true,
          data: {
            caseId,
            decision: engineResult.data || engineResult,
          },
        })
      } catch (err) {
        json(res, err.statusCode || 502, err.upstreamBody || {
          success: false,
          error: {
            code: err.code || 'DECISION_ENGINE_ERROR',
            message: `决策引擎调用失败: ${err.message}`,
          },
        })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/v1/cases/search-similar',
    rateLimit: { max: 30, windowMs: 60000 },
    concurrencyLimit: { key: 'vector-analysis', max: VECTOR_GLOBAL_CONCURRENCY },
    maxBodyBytes: 9 * 1024 * 1024,
    handler: async (_req, res, { body }) => {
      try {
        const result = await fetchJson(`${KNOWLEDGE_AI_URL}/api/knowledge/search`, {
          method: 'POST',
          body,
          headers: internalHeaders(),
        })
        const parsed = typeof result === 'string' ? JSON.parse(result) : result
        json(res, 200, parsed)
      } catch (err) {
        json(res, err.statusCode || 502, err.upstreamBody || {
          success: false,
          error: { code: 'KNOWLEDGE_AI_ERROR', message: `知识检索服务调用失败: ${err.message}` },
        })
      }
    },
  },
  // ===== Knowledge-AI 代理（避免前端硬编码 localhost:8083） =====
  // H5 仅可读取经过脱敏的公开显示配置；完整模型配置只在管理端开放。
  {
    method: 'GET',
    path: '/api/knowledge/public-config',
    handler: (_req, res) => proxyToKnowledge('GET', '/api/knowledge/public-config', null, res),
  },
  {
    method: 'POST',
    path: '/api/knowledge/search-vector',
    rateLimit: { max: 30, windowMs: 60000 },
    concurrencyLimit: { key: 'vector-analysis', max: VECTOR_GLOBAL_CONCURRENCY },
    maxBodyBytes: 9 * 1024 * 1024,
    handler: (_req, res, { body }) => proxyToKnowledge('POST', '/api/knowledge/search-vector', body, res),
  },
  {
    method: 'POST',
    path: '/api/knowledge/correction',
    rateLimit: { max: 5, windowMs: 60 * 60 * 1000 },
    maxBodyBytes: 4 * 1024 * 1024,
    handler: (_req, res, { body }) => proxyToKnowledge('POST', '/api/knowledge/correction', body, res),
  },
  {
    method: 'POST',
    path: '/api/knowledge/assessment-records',
    rateLimit: { max: 20, windowMs: 60000 },
    maxBodyBytes: MAX_MULTI_IMAGE_BODY_BYTES,
    handler: (_req, res, { body }) => proxyToKnowledge('POST', '/api/knowledge/assessment-records', body, res),
  },
  {
    method: 'PATCH',
    path: '/api/knowledge/assessment-records',
    rateLimit: { max: 40, windowMs: 60000 },
    maxBodyBytes: 512 * 1024,
    handler: (_req, res, { body }) => proxyToKnowledge('PATCH', '/api/knowledge/assessment-records', body, res),
  },
  {
    method: 'POST',
    path: '/api/knowledge/feedback',
    rateLimit: { max: 30, windowMs: 60000 },
    maxBodyBytes: 16 * 1024,
    handler: (_req, res, { body }) => proxyToKnowledge('POST', '/api/knowledge/feedback', body, res),
  },
  {
    method: 'POST',
    path: '/api/knowledge/feedback/report',
    rateLimit: { max: 30, windowMs: 60000 },
    maxBodyBytes: 16 * 1024,
    handler: (_req, res, { body }) => proxyToKnowledge('POST', '/api/knowledge/feedback/report', body, res),
  },
  {
    method: 'POST',
    path: '/api/knowledge/feedback/confirm',
    rateLimit: { max: 30, windowMs: 60000 },
    maxBodyBytes: 16 * 1024,
    handler: (_req, res, { body }) => proxyToKnowledge('POST', '/api/knowledge/feedback/confirm', body, res),
  },
  {
    method: 'GET',
    path: '/api/knowledge/cases/result-stats',
    handler: (_req, res, { query }) => {
      const qs = Object.entries(query || {}).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
      return proxyToKnowledge('GET', '/api/knowledge/cases/result-stats' + (qs ? '?' + qs : ''), null, res)
    },
  },
  // 图片方向预检：算法优先，允许时由多模态模型比较 0/180° 候选图。
  {
    method: 'POST',
    path: '/api/knowledge/orient-images',
    rateLimit: { max: 10, windowMs: 60000 },
    globalRateLimit: { key: 'llm-analysis-minute', max: LLM_GLOBAL_REQUESTS_PER_MINUTE, windowMs: 60000 },
    concurrencyLimit: { key: 'llm-analysis', max: LLM_GLOBAL_CONCURRENCY },
    maxBodyBytes: MAX_MULTI_IMAGE_BODY_BYTES,
    handler: (_req, res, { body }) => {
      const operation = () => proxyToKnowledge('POST', '/api/knowledge/orient-images', body, res, { timeout: 600000 })
      return body?.allowModel === false ? operation() : withLlmDailyBudget(operation)
    },
  },
  // 非流式 LLM 分析 —— 供 RAG 路径获取 AI 生成的 description
  {
    method: 'POST',
    path: '/api/knowledge/analyze-llm',
    rateLimit: { max: 10, windowMs: 60000 },
    globalRateLimit: { key: 'llm-analysis-minute', max: LLM_GLOBAL_REQUESTS_PER_MINUTE, windowMs: 60000 },
    concurrencyLimit: { key: 'llm-analysis', max: LLM_GLOBAL_CONCURRENCY },
    maxBodyBytes: MAX_MULTI_IMAGE_BODY_BYTES,
    handler: (_req, res, { body }) => withLlmDailyBudget(
      () => proxyToKnowledge('POST', '/api/knowledge/analyze-llm', body, res, { timeout: 125000 }),
    ),
  },
  // SSE 流式分析 —— 特殊处理，不能走 fetchJson（会缓冲）
  {
    method: 'POST',
    path: '/api/knowledge/analyze-llm-stream',
    rateLimit: { max: 10, windowMs: 60000 },
    globalRateLimit: { key: 'llm-analysis-minute', max: LLM_GLOBAL_REQUESTS_PER_MINUTE, windowMs: 60000 },
    concurrencyLimit: { key: 'llm-analysis', max: LLM_GLOBAL_CONCURRENCY },
    maxBodyBytes: MAX_MULTI_IMAGE_BODY_BYTES,
    handler: (req, res, { body }) => withLlmDailyBudget(
      () => proxyStreamToKnowledge('/api/knowledge/analyze-llm-stream', body, req, res),
    ),
  },
  // 集中式字段定义
  {
    method: 'GET',
    path: '/api/knowledge/field-defs',
    handler: (_req, res) => proxyToKnowledge('GET', '/api/knowledge/field-defs', null, res),
  },
  // 案例图片代理（二进制透传，供前端展示相似案例缩略图）
  {
    method: 'GET',
    path: '/api/knowledge/images',
    handler: (req, res, { query }) => {
      const qs = query.name ? `?name=${encodeURIComponent(query.name)}` : ''
      pipeProxyToKnowledge('GET', `/api/knowledge/images${qs}`, null, req, res)
    },
  },
  // ===== 前端页面 =====
  {
    method: 'GET',
    path: '/',
    handler: (_req, res) => {
      readFile(join(__dirname, '..', '..', '..', 'frontend', 'index.html'), 'utf-8')
        .then(html => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html) })
        .catch(() => { res.writeHead(404); res.end('Frontend not found') })
    },
  },
  {
    method: 'GET',
    path: '/index.html',
    handler: (_req, res) => {
      readFile(join(__dirname, '..', '..', '..', 'frontend', 'index.html'), 'utf-8')
        .then(html => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html) })
        .catch(() => { res.writeHead(404); res.end('Frontend not found') })
    },
  },
]

if (process.env.GATEWAY_DISABLE_AUTOSTART !== '1') {
  createServer(routes, PORT, 'gateway-bff')
  console.log(`[gateway-bff] 案例判定接口 → POST http://localhost:${PORT}/api/v1/cases/decide`)
}
