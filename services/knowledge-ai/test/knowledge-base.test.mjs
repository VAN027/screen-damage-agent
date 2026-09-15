import test from 'node:test'
import assert from 'node:assert/strict'
import { chunkText } from '../src/knowledge-base.mjs'

test('chunkText terminates at the document tail without duplicating the last chunk', () => {
  const text = '第一段。'.repeat(500)
  const chunks = chunkText(text, 120, 20)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.length < 100)
  assert.notEqual(chunks.at(-1), chunks.at(-2))
})

test('chunkText clamps invalid overlap and always advances', () => {
  const chunks = chunkText('abcdefghij'.repeat(20), 10, 10_000)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.length <= 200)
  assert.throws(() => chunkText('text', 0, 0), /正数/)
})
