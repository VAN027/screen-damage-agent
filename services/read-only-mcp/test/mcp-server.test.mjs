import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

process.env.MCP_DISABLE_AUTOSTART = '1'
const { startReadOnlyMcpServer } = await import('../src/index.mjs')

function fakeStore() {
  return {
    getStatistics: scope => ({ scope, counts: { assessments: 3 } }),
    queryAssessments: input => ({ rows: [{ id: 1 }], total: 1, ...input }),
    queryCorrectionReviews: input => ({ rows: [], total: 0, ...input }),
    queryCases: input => ({ rows: [], total: 0, ...input }),
    queryEvaluations: input => ({ rows: [], total: 0, ...input }),
    close() {},
  }
}

test('MCP exposes only authenticated read-only query and statistics tools', async t => {
  const token = crypto.randomBytes(32).toString('base64url')
  const running = startReadOnlyMcpServer({ host: '127.0.0.1', port: 0, token, store: fakeStore() })
  if (!running.server.listening) await once(running.server, 'listening')
  t.after(() => running.close())
  const { port } = running.server.address()
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`)

  const unauthorized = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: `127.0.0.1:${port}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  assert.equal(unauthorized.status, 401)

  const client = new Client({ name: 'read-only-mcp-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider: { token: async () => token },
  })
  await client.connect(transport)
  t.after(() => client.close())

  const listed = await client.listTools()
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [
    'get_statistics',
    'query_assessments',
    'query_cases',
    'query_correction_reviews',
    'query_evaluations',
  ])
  assert.equal(listed.tools.every(tool => tool.annotations?.readOnlyHint === true), true)
  assert.equal(listed.tools.every(tool => tool.annotations?.destructiveHint === false), true)

  const result = await client.callTool({ name: 'get_statistics', arguments: { scope: 'overview' } })
  assert.equal(result.isError, undefined)
  assert.match(result.content[0].text, /"assessments": 3/)
})
