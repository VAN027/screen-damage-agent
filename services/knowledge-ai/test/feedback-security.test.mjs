import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('feedback capability tokens are hashed, scoped, and permit only one state transition', { concurrency: false }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'screen-damage-feedback-'))
  const previousDataDir = process.env.KNOWLEDGE_DATA_DIR
  process.env.KNOWLEDGE_DATA_DIR = dataDir

  let module
  t.after(async () => {
    try { module?.getDb().close() } catch {}
    if (previousDataDir === undefined) delete process.env.KNOWLEDGE_DATA_DIR
    else process.env.KNOWLEDGE_DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  })

  module = await import(`../src/db.mjs?feedback-test=${crypto.randomUUID()}`)
  const { initDb, getDb, saveFeedback, reportFeedback, confirmFeedback } = module
  await initDb()

  const db = getDb()
  assert.equal(resolve(db.name), join(resolve(dataDir), 'knowledge.db'))

  const first = saveFeedback({
    caseId: 'CASE-1',
    conclusion: 'not_product_quality',
    status: 'confirmed_correct', // 调用方不能越权指定初始状态
    remark: '',
  })
  const firstRow = db.prepare('SELECT * FROM feedback WHERE id = ?').get(first.id)
  assert.equal(firstRow.status, 'unconfirmed')
  assert.notEqual(firstRow.capability_hash, first.capabilityToken)
  assert.equal(
    firstRow.capability_hash,
    crypto.createHash('sha256').update(first.capabilityToken).digest('hex'),
  )

  const wrongToken = crypto.randomBytes(32).toString('base64url')
  assert.equal(confirmFeedback(first.id, wrongToken).updated, 0)
  assert.equal(db.prepare('SELECT status FROM feedback WHERE id = ?').get(first.id).status, 'unconfirmed')

  assert.equal(reportFeedback(first.id, '人工判断有误', first.capabilityToken).updated, 1)
  assert.deepEqual(
    db.prepare('SELECT status, remark FROM feedback WHERE id = ?').get(first.id),
    { status: 'reported_incorrect', remark: '人工判断有误' },
  )
  assert.equal(confirmFeedback(first.id, first.capabilityToken).updated, 0)
  assert.equal(db.prepare('SELECT status FROM feedback WHERE id = ?').get(first.id).status, 'reported_incorrect')

  const second = saveFeedback({ caseId: 'CASE-2', conclusion: 'no_damage' })
  assert.equal(reportFeedback(second.id, '跨记录凭证', first.capabilityToken).updated, 0)
  assert.equal(confirmFeedback(second.id, second.capabilityToken).updated, 1)
  assert.equal(reportFeedback(second.id, '二次变更', second.capabilityToken).updated, 0)
  assert.deepEqual(
    db.prepare('SELECT status, remark FROM feedback WHERE id = ?').get(second.id),
    { status: 'confirmed_correct', remark: '' },
  )

  assert.throws(() => confirmFeedback(second.id, 'too-short'), /反馈凭证/)
})
