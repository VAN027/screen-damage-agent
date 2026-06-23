import { createServer, json, fetchJson } from './server-utils.mjs'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.BFF_PORT || '8080', 10)
const DECISION_ENGINE_URL = process.env.DECISION_ENGINE_URL || 'http://localhost:8081'
const KNOWLEDGE_AI_URL = process.env.KNOWLEDGE_AI_URL || 'http://localhost:8083'
const startTime = Date.now()

// ---------- 代理辅助函数 ----------

function proxyToKnowledge(method, path, body, res) {
  return fetchJson(`${KNOWLEDGE_AI_URL}${path}`, { method, body })
    .then(result => json(res, 200, result))
    .catch(err => json(res, 502, { success: false, error: { code: 'PROXY_ERROR', message: err.message } }))
}

// SSE 流式代理 —— 直接把 knowledge-ai 的 SSE 流透传给客户端
function proxyStreamToKnowledge(path, body, clientReq, clientRes) {
  const url = new URL(`${KNOWLEDGE_AI_URL}${path}`)
  const reqBody = body ? JSON.stringify(body) : null

  const options = {
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname + (url.search || ''),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': reqBody ? Buffer.byteLength(reqBody) : 0,
    },
  }

  const proxyReq = http.request(options, proxyRes => {
    if (proxyRes.statusCode !== 200) {
      let errData = ''
      proxyRes.on('data', c => errData += c)
      proxyRes.on('end', () => {
        try { json(clientRes, 502, JSON.parse(errData)) }
        catch { json(clientRes, 502, { success: false, error: { code: 'UPSTREAM_ERROR', message: `HTTP ${proxyRes.statusCode}` } }) }
      })
      return
    }

    // 透传 SSE 响应头
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })

    proxyRes.pipe(clientRes)
  })

  proxyReq.on('error', err => {
    if (!clientRes.headersSent) {
      json(clientRes, 502, { success: false, error: { code: 'PROXY_ERROR', message: err.message } })
    }
  })

  if (reqBody) proxyReq.write(reqBody)
  proxyReq.end()
}

function buildDecisionRequest(submission, caseId) {
  return {
    caseId,
    symptoms: submission.symptoms || [],
    installStatus: submission.installStatus || 'not_installed',
    authPersonnel: submission.authPersonnel || 'yes',
    packageDamage: submission.packageDamage || 'none',
    faultLinks: submission.faultLinks || [],
    touchFeel: submission.touchFeel || null,
    hasImpactPoint: submission.hasImpactPoint || false,
    hasButterflyPattern: submission.hasButterflyPattern || false,
    crackLocation: submission.crackLocation || null,
    leakBoundary: submission.leakBoundary || null,
    scratchLayer: submission.scratchLayer || null,
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
    handler: async (_req, res, { body }) => {
      const submission = body
      const caseId = `CASE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      try {
        const decisionReq = buildDecisionRequest(submission, caseId)
        const engineResult = await fetchJson(`${DECISION_ENGINE_URL}/api/decision/evaluate`, {
          method: 'POST',
          body: decisionReq,
        })

        json(res, 200, {
          success: true,
          data: {
            caseId,
            decision: engineResult.data || engineResult,
          },
        })
      } catch (err) {
        json(res, 502, {
          success: false,
          error: {
            code: 'DECISION_ENGINE_ERROR',
            message: `决策引擎调用失败: ${err.message}`,
          },
        })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/v1/cases/search-similar',
    handler: async (_req, res, { body }) => {
      try {
        const result = await fetchJson(`${KNOWLEDGE_AI_URL}/api/knowledge/search`, {
          method: 'POST',
          body,
        })
        const parsed = typeof result === 'string' ? JSON.parse(result) : result
        json(res, 200, parsed)
      } catch (err) {
        json(res, 502, {
          success: false,
          error: { code: 'KNOWLEDGE_AI_ERROR', message: `知识检索服务调用失败: ${err.message}` },
        })
      }
    },
  },
  // ===== Knowledge-AI 代理（避免前端硬编码 localhost:8083） =====
  {
    method: 'GET',
    path: '/api/knowledge/model-config',
    handler: (_req, res) => proxyToKnowledge('GET', '/api/knowledge/model-config', null, res),
  },
  {
    method: 'POST',
    path: '/api/knowledge/model-config',
    handler: (_req, res, { body }) => proxyToKnowledge('POST', '/api/knowledge/model-config', body, res),
  },
  {
    method: 'POST',
    path: '/api/knowledge/search-vector',
    handler: (_req, res, { body }) => proxyToKnowledge('POST', '/api/knowledge/search-vector', body, res),
  },
  // SSE 流式分析 —— 特殊处理，不能走 fetchJson（会缓冲）
  {
    method: 'POST',
    path: '/api/knowledge/analyze-llm-stream',
    handler: (req, res, { body }) => proxyStreamToKnowledge('/api/knowledge/analyze-llm-stream', body, req, res),
  },
  // OPTIONS 预检（CORS）
  {
    method: 'OPTIONS',
    path: '/api/knowledge/model-config',
    handler: (_req, res) => { res.writeHead(204, corsHeaders()); res.end() },
  },
  {
    method: 'OPTIONS',
    path: '/api/knowledge/search-vector',
    handler: (_req, res) => { res.writeHead(204, corsHeaders()); res.end() },
  },
  {
    method: 'OPTIONS',
    path: '/api/knowledge/analyze-llm-stream',
    handler: (_req, res) => { res.writeHead(204, corsHeaders()); res.end() },
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

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

createServer(routes, PORT, 'gateway-bff')
console.log(`[gateway-bff] 案例判定接口 → POST http://localhost:${PORT}/api/v1/cases/decide`)
