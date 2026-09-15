import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { acquireConcurrency, authorizeRequest, fetchJson, setCors } from './server-utils.mjs'

function request(headers = {}) {
  return { headers, socket: { remoteAddress: '127.0.0.1' } }
}

test('admin and internal authentication fail closed and accept only their own tokens', { concurrency: false }, () => {
  const previousAdmin = process.env.ADMIN_API_TOKEN
  const previousInternal = process.env.INTERNAL_SERVICE_TOKEN
  try {
    delete process.env.ADMIN_API_TOKEN
    assert.throws(() => authorizeRequest(request(), 'admin'), error => error.statusCode === 503)

    process.env.ADMIN_API_TOKEN = 'admin-test-token'
    process.env.INTERNAL_SERVICE_TOKEN = 'internal-test-token'
    assert.throws(() => authorizeRequest(request({ authorization: 'Bearer wrong' }), 'admin'), error => error.statusCode === 401)
    assert.doesNotThrow(() => authorizeRequest(request({ authorization: 'Bearer admin-test-token' }), 'admin'))
    assert.doesNotThrow(() => authorizeRequest(request({ 'x-internal-token': 'internal-test-token' }), 'internal'))
    assert.throws(
      () => authorizeRequest(request({ authorization: 'Bearer admin-test-token' }), 'internal'),
      error => error.statusCode === 401,
    )
  } finally {
    if (previousAdmin === undefined) delete process.env.ADMIN_API_TOKEN
    else process.env.ADMIN_API_TOKEN = previousAdmin
    if (previousInternal === undefined) delete process.env.INTERNAL_SERVICE_TOKEN
    else process.env.INTERNAL_SERVICE_TOKEN = previousInternal
  }
})

test('CORS only reflects explicitly allowed or same-origin origins', { concurrency: false }, () => {
  const previous = process.env.CORS_ALLOWED_ORIGINS
  process.env.CORS_ALLOWED_ORIGINS = 'https://admin.example.com'
  const headers = new Map()
  const res = { setHeader: (key, value) => headers.set(key, value) }
  try {
    setCors(request({ origin: 'https://evil.example', host: 'app.example.com' }), res)
    assert.equal(headers.has('Access-Control-Allow-Origin'), false)
    setCors(request({ origin: 'https://admin.example.com', host: 'app.example.com' }), res)
    assert.equal(headers.get('Access-Control-Allow-Origin'), 'https://admin.example.com')
  } finally {
    if (previous === undefined) delete process.env.CORS_ALLOWED_ORIGINS
    else process.env.CORS_ALLOWED_ORIGINS = previous
  }
})

test('concurrency admission happens before work and releases its shared slot idempotently', () => {
  const route = {
    method: 'POST',
    path: '/large-body',
    concurrencyLimit: { key: `large-body-${process.pid}-${Date.now()}`, max: 1 },
  }
  const release = acquireConcurrency(route)
  assert.throws(() => acquireConcurrency(route), error => error.statusCode === 429 && error.code === 'CAPACITY_LIMITED')
  release()
  release()
  const releaseAgain = acquireConcurrency(route)
  assert.equal(typeof releaseAgain, 'function')
  releaseAgain()
})

test('fetchJson rejects non-2xx responses without losing the upstream payload', async t => {
  const server = http.createServer((_req, res) => {
    res.writeHead(422, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: false, error: { code: 'INVALID_CASE', message: 'invalid case' } }))
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('当前沙箱禁止监听本地回环端口')
      return
    }
    throw error
  }
  try {
    const { port } = server.address()
    await assert.rejects(
      fetchJson(`http://127.0.0.1:${port}/test`),
      error => error.statusCode === 422 && error.code === 'INVALID_CASE' && error.upstreamBody?.success === false,
    )
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
