import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server.address().port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
}

function closeServer(server) {
  return new Promise(resolve => {
    if (!server?.listening) return resolve()
    server.close(() => resolve())
  })
}

function request(url, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const encodedBody = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request(url, {
      method,
      headers: encodedBody ? {
        'Content-Type': 'application/json',
        'Content-Length': encodedBody.length,
      } : {},
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }))
    })
    req.setTimeout(2000, () => req.destroy(new Error('proxy regression test timed out')))
    req.on('error', reject)
    if (encodedBody) req.write(encodedBody)
    req.end()
  })
}

function delayedResponse(res, contentType, chunks) {
  res.writeHead(200, { 'Content-Type': contentType })
  res.flushHeaders()
  chunks.forEach((chunk, index) => {
    setTimeout(() => {
      if (res.destroyed) return
      if (index === chunks.length - 1) res.end(chunk)
      else res.write(chunk)
    }, 25 * (index + 1))
  })
}

test('gateway daily budget reservation can be refunded for rejected upstream requests', { concurrency: false }, async () => {
  const previousAutostart = process.env.GATEWAY_DISABLE_AUTOSTART
  process.env.GATEWAY_DISABLE_AUTOSTART = '1'
  try {
    const gateway = await import(`../gateway-bff/src/index.mjs?concurrency-test=${crypto.randomUUID()}`)
    const key = `unit-test-budget-${crypto.randomUUID()}`
    const reservation = gateway.reserveDailyBudget(key, 1, 1000)
    assert.throws(() => gateway.reserveDailyBudget(key, 1, 1000), error => error.code === 'DAILY_BUDGET_EXHAUSTED')
    reservation.refund()
    const available = gateway.reserveDailyBudget(key, 1, 1000)
    available.refund()
  } finally {
    if (previousAutostart === undefined) delete process.env.GATEWAY_DISABLE_AUTOSTART
    else process.env.GATEWAY_DISABLE_AUTOSTART = previousAutostart
  }
})

test('gateway and admin keep slow image/SSE upstreams alive after a normal request close', { concurrency: false }, async t => {
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const sse = ['data: {"stage":"first"}\n\n', 'data: {"stage":"done"}\n\n']
  const observations = []

  const upstream = http.createServer((req, res) => {
    const observation = { path: req.url, aborted: false, completed: false }
    observations.push(observation)
    req.on('aborted', () => { observation.aborted = true })
    req.resume()
    res.on('finish', () => { observation.completed = true })

    if (req.url === '/slow-image') {
      return delayedResponse(res, 'image/png', [image.subarray(0, 8), image.subarray(8)])
    }
    if (req.url === '/slow-sse') {
      return delayedResponse(res, 'text/event-stream', sse)
    }
    res.writeHead(404)
    res.end()
  })

  let upstreamPort
  try {
    upstreamPort = await listen(upstream)
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error?.code)) {
      t.skip(`sandbox does not permit loopback listen: ${error.code}`)
      return
    }
    throw error
  }
  t.after(() => closeServer(upstream))

  const upstreamUrl = `http://127.0.0.1:${upstreamPort}`
  const previousKnowledgeUrl = process.env.KNOWLEDGE_AI_URL
  const previousAutostart = process.env.GATEWAY_DISABLE_AUTOSTART
  const previousInternalToken = process.env.INTERNAL_SERVICE_TOKEN
  process.env.KNOWLEDGE_AI_URL = upstreamUrl
  process.env.GATEWAY_DISABLE_AUTOSTART = '1'
  process.env.INTERNAL_SERVICE_TOKEN = 'proxy-test-internal-token'
  t.after(() => {
    if (previousKnowledgeUrl === undefined) delete process.env.KNOWLEDGE_AI_URL
    else process.env.KNOWLEDGE_AI_URL = previousKnowledgeUrl
    if (previousAutostart === undefined) delete process.env.GATEWAY_DISABLE_AUTOSTART
    else process.env.GATEWAY_DISABLE_AUTOSTART = previousAutostart
    if (previousInternalToken === undefined) delete process.env.INTERNAL_SERVICE_TOKEN
    else process.env.INTERNAL_SERVICE_TOKEN = previousInternalToken
  })

  const gateway = await import(`../gateway-bff/src/index.mjs?proxy-test=${crypto.randomUUID()}`)
  const { pipeProxy } = await import('../decision-admin/src/server-utils.mjs')

  const gatewayServer = http.createServer((req, res) => {
    if (req.url === '/image') return gateway.pipeProxyToKnowledge('GET', '/slow-image', null, req, res)
    if (req.url === '/sse') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => gateway.proxyStreamToKnowledge('/slow-sse', JSON.parse(Buffer.concat(chunks)), req, res))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const gatewayPort = await listen(gatewayServer)
  t.after(() => closeServer(gatewayServer))

  const adminServer = http.createServer((req, res) => {
    if (req.url === '/image') return pipeProxy('GET', `${upstreamUrl}/slow-image`, null, req, res)
    if (req.url === '/sse') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => pipeProxy('POST', `${upstreamUrl}/slow-sse`, JSON.parse(Buffer.concat(chunks)), req, res))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const adminPort = await listen(adminServer)
  t.after(() => closeServer(adminServer))

  for (const port of [gatewayPort, adminPort]) {
    const imageResponse = await request(`http://127.0.0.1:${port}/image`)
    assert.equal(imageResponse.statusCode, 200)
    assert.equal(imageResponse.headers['content-type'], 'image/png')
    assert.deepEqual(imageResponse.body, image)

    const sseResponse = await request(`http://127.0.0.1:${port}/sse`, { method: 'POST', body: { image: 'test' } })
    assert.equal(sseResponse.statusCode, 200)
    assert.match(sseResponse.headers['content-type'], /^text\/event-stream/)
    assert.equal(sseResponse.body.toString(), sse.join(''))
  }

  assert.equal(observations.length, 4)
  assert.equal(observations.some(item => item.aborted), false)
  assert.equal(observations.every(item => item.completed), true)
})
