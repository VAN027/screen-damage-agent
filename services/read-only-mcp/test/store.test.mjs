import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('store uses SQLite query-only mode and excludes sensitive columns', { concurrency: false }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'screen-damage-readonly-mcp-'))
  const previousDataDir = process.env.KNOWLEDGE_DATA_DIR
  process.env.KNOWLEDGE_DATA_DIR = dataDir
  const dbModule = await import(`../../knowledge-ai/src/db.mjs?mcp-store-test=${crypto.randomUUID()}`)
  await dbModule.initDb()
  const writer = dbModule.getDb()
  writer.prepare(`INSERT INTO feedback (
    submission_id, case_id, conclusion, status, remark, capability_hash, process_status,
    fault_links, analysis_payload, decision_payload, image_count
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'SUBMISSION-SECRET-TEST', 'CASE-1', 'not_product_quality', 'unconfirmed', '测试记录',
    'CAPABILITY_SECRET', 'completed', '["product_factor"]', '{"private":"RAW_ANALYSIS_SECRET"}',
    '{"private":"RAW_DECISION_SECRET"}', 1,
  )
  writer.prepare(`INSERT INTO pending_cases (
    title, status, imageBase64, image_path, correction_payload
  ) VALUES (?, ?, ?, ?, ?)`).run(
    '审核记录', 'approved', 'BASE64_SECRET', 'review-images/secret.jpg', 'CORRECTION_SECRET',
  )
  writer.prepare(`INSERT INTO cases (id, title, images, corrections, result)
    VALUES (?, ?, ?, ?, ?)`).run('CASE-1', '案例一', '["PRIVATE_IMAGE.jpg"]', '[{"private":"SECRET"}]', 'not_product_quality')

  const { ReadOnlyKnowledgeStore } = await import('../src/store.mjs')
  const store = new ReadOnlyKnowledgeStore(join(dataDir, 'knowledge.db'))
  t.after(async () => {
    store.close()
    try { writer.close() } catch {}
    if (previousDataDir === undefined) delete process.env.KNOWLEDGE_DATA_DIR
    else process.env.KNOWLEDGE_DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  })

  const assessments = store.queryAssessments({ keyword: 'SECRET-TEST' })
  assert.equal(assessments.total, 1)
  assert.deepEqual(assessments.rows[0].fault_links, ['product_factor'])
  const assessmentJson = JSON.stringify(assessments)
  assert.doesNotMatch(assessmentJson, /CAPABILITY_SECRET|RAW_ANALYSIS_SECRET|RAW_DECISION_SECRET/)

  const reviews = store.queryCorrectionReviews({ status: 'approved' })
  assert.equal(reviews.rows[0].image_storage, 'disk')
  assert.doesNotMatch(JSON.stringify(reviews), /BASE64_SECRET|secret\.jpg|CORRECTION_SECRET/)

  const cases = store.queryCases({ id: 'CASE-1' })
  assert.equal(cases.total, 1)
  assert.doesNotMatch(JSON.stringify(cases), /PRIVATE_IMAGE|"private"/)

  assert.throws(() => store.db.prepare("DELETE FROM feedback WHERE id = 1").run(), /readonly|read-only|query only/i)
  assert.equal(store.getStatistics('overview').counts.assessments, 1)
})
