import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

const JPEG_DATA_URL = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`

test('correction capability is consumed once and data enters learning only after review', { concurrency: false }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'screen-damage-correction-'))
  const previous = {
    dataDir: process.env.KNOWLEDGE_DATA_DIR,
    internalToken: process.env.INTERNAL_SERVICE_TOKEN,
    orientationPython: process.env.ORIENTATION_PYTHON,
  }
  process.env.KNOWLEDGE_DATA_DIR = dataDir
  delete process.env.INTERNAL_SERVICE_TOKEN
  process.env.ORIENTATION_PYTHON = '/bin/false'

  let activeDbModule
  t.after(async () => {
    try { activeDbModule?.getDb().close() } catch {}
    if (previous.dataDir === undefined) delete process.env.KNOWLEDGE_DATA_DIR
    else process.env.KNOWLEDGE_DATA_DIR = previous.dataDir
    if (previous.internalToken === undefined) delete process.env.INTERNAL_SERVICE_TOKEN
    else process.env.INTERNAL_SERVICE_TOKEN = previous.internalToken
    if (previous.orientationPython === undefined) delete process.env.ORIENTATION_PYTHON
    else process.env.ORIENTATION_PYTHON = previous.orientationPython
    await rm(dataDir, { recursive: true, force: true })
  })

  const search = await import(`../src/search-engine.mjs?correction-test=${crypto.randomUUID()}`)
  activeDbModule = await import('../src/db.mjs')
  await search.initializeSearchEngine()
  const db = activeDbModule.getDb()

  await search.createCase({
    title: '原始案例',
    crackLocation: '中央区域',
    crackShape: '单条线状屏裂',
    result: 'not_product_quality',
  }, { id: 'CASE-SOURCE' })

  const createReportedFeedback = (remark = '用户报告结论有误') => {
    const feedback = activeDbModule.saveFeedback({
      caseId: 'CASE-SOURCE',
      conclusion: 'not_product_quality',
    })
    assert.equal(activeDbModule.reportFeedback(feedback.id, remark, feedback.capabilityToken).updated, 1)
    return feedback
  }

  const correctionFor = (feedback, overrides = {}) => ({
    feedbackId: feedback.id,
    capabilityToken: feedback.capabilityToken,
    caseId: 'CASE-SOURCE',
    originalLocation: '中央区域',
    originalShape: '单条线状屏裂',
    originalConclusion: 'not_product_quality',
    correctedLocation: '左侧',
    correctedShape: '点放射状屏裂',
    correctedConclusion: 'product_quality_issue',
    remark: '人工复看后确认属于质量问题',
    imageBase64: JPEG_DATA_URL,
    ...overrides,
  })

  const first = activeDbModule.saveFeedback({
    caseId: 'CASE-SOURCE',
    conclusion: 'not_product_quality',
  })
  await assert.rejects(
    search.saveCorrection({ ...correctionFor(first), capabilityToken: undefined }),
    error => error.code === 'INVALID_CORRECTION_CAPABILITY' && error.statusCode === 403,
  )
  await assert.rejects(
    search.saveCorrection({ ...correctionFor(first), capabilityToken: crypto.randomBytes(32).toString('base64url') }),
    error => error.code === 'INVALID_CORRECTION_CAPABILITY' && error.statusCode === 403,
  )
  await assert.rejects(
    search.saveCorrection({ ...correctionFor(first), caseId: 'CASE-OTHER' }),
    error => error.code === 'INVALID_CORRECTION_CAPABILITY' && error.statusCode === 403,
  )
  const confirmed = activeDbModule.saveFeedback({
    caseId: 'CASE-SOURCE',
    conclusion: 'not_product_quality',
  })
  assert.equal(activeDbModule.confirmFeedback(confirmed.id, confirmed.capabilityToken).updated, 1)
  await assert.rejects(
    search.saveCorrection(correctionFor(confirmed)),
    error => error.code === 'CORRECTION_NOT_ALLOWED' && error.statusCode === 409,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM pending_cases').get().total, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM training').get().total, 0)
  assert.equal(db.prepare('SELECT status FROM feedback WHERE id = ?').get(first.id).status, 'unconfirmed')
  assert.deepEqual(JSON.parse(db.prepare('SELECT corrections FROM cases WHERE id = ?').get('CASE-SOURCE').corrections), [])

  const submitted = await search.saveCorrection(correctionFor(first))
  assert.equal(submitted.pendingCreated, true)
  const pending = db.prepare('SELECT * FROM pending_cases WHERE id = ?').get(submitted.pendingId)
  assert.equal(pending.status, 'pending')
  assert.equal(pending.feedback_id, first.id)
  assert.equal(pending.source_case_id, 'CASE-SOURCE')
  assert.equal(pending.imageBase64, JPEG_DATA_URL)
  assert.ok(pending.correction_payload)
  assert.equal(pending.correction_payload.includes(first.capabilityToken), false)
  assert.deepEqual(
    db.prepare('SELECT status, remark, correction_pending_id FROM feedback WHERE id = ?').get(first.id),
    {
      status: 'reported_incorrect',
      remark: '人工复看后确认属于质量问题',
      correction_pending_id: submitted.pendingId,
    },
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM training').get().total, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM cases').get().total, 1)
  assert.deepEqual(JSON.parse(db.prepare('SELECT corrections FROM cases WHERE id = ?').get('CASE-SOURCE').corrections), [])

  await assert.rejects(
    search.saveCorrection(correctionFor(first)),
    error => error.code === 'CORRECTION_CAPABILITY_USED' && error.statusCode === 409,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM pending_cases').get().total, 1)

  const approvalResults = await Promise.all([
    search.approvePendingCase(submitted.pendingId, 'reviewer-a', '证据充分'),
    search.approvePendingCase(submitted.pendingId, 'reviewer-b', '并发复核'),
  ])
  assert.deepEqual(approvalResults.map(item => item.idempotent).sort(), [false, true])
  assert.equal(new Set(approvalResults.map(item => item.caseId)).size, 1)
  const approved = approvalResults.find(item => !item.idempotent)
  assert.equal(approved.status, 'approved')
  assert.equal(approved.idempotent, false)
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM training').get().total, 1)
  assert.equal(db.prepare('SELECT source_pending_id FROM training').get().source_pending_id, submitted.pendingId)
  const sourceAfterApproval = activeDbModule.deserializeCase(db.prepare('SELECT * FROM cases WHERE id = ?').get('CASE-SOURCE'))
  assert.equal(sourceAfterApproval.corrections.length, 1)
  assert.equal(sourceAfterApproval.corrections[0].pendingId, submitted.pendingId)
  assert.equal(sourceAfterApproval.corrections[0].correctedConclusion, 'product_quality_issue')
  assert.ok(db.prepare('SELECT 1 FROM cases WHERE id = ?').get(approved.caseId))
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM cases WHERE id <> ?').get('CASE-SOURCE').total, 1)
  assert.deepEqual(
    db.prepare('SELECT status, imageBase64, correction_payload FROM pending_cases WHERE id = ?').get(submitted.pendingId),
    { status: 'approved', imageBase64: '', correction_payload: '' },
  )
  const approvedArchive = db.prepare(`SELECT image_path, image_mime_type, image_file_size,
      image_archived_at, image_expires_at, image_deleted_at
    FROM pending_cases WHERE id = ?`).get(submitted.pendingId)
  assert.match(approvedArchive.image_path, /^review-images\//)
  assert.equal(approvedArchive.image_mime_type, 'image/jpeg')
  assert.equal(approvedArchive.image_file_size, 4)
  assert.ok(approvedArchive.image_archived_at)
  assert.ok(approvedArchive.image_expires_at)
  assert.equal(approvedArchive.image_deleted_at, '')
  await access(join(dataDir, approvedArchive.image_path))
  assert.equal(await search.getPendingCaseImage(submitted.pendingId), JPEG_DATA_URL)

  const approvedAgain = await search.approvePendingCase(submitted.pendingId, 'reviewer-b', '重复点击')
  assert.equal(approvedAgain.idempotent, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM training').get().total, 1)
  assert.equal(activeDbModule.deserializeCase(db.prepare('SELECT * FROM cases WHERE id = ?').get('CASE-SOURCE')).corrections.length, 1)

  const rejectedFeedback = createReportedFeedback('另一次错误反馈')
  const rejectedSubmission = await search.saveCorrection(correctionFor(rejectedFeedback, {
    correctedLocation: '右侧',
    remark: '该样本证据不足，应驳回',
  }))
  const rejected = await search.rejectPendingCase(rejectedSubmission.pendingId, 'reviewer-r', '图片无法证明结论')
  assert.equal(rejected.status, 'rejected')
  assert.deepEqual(
    db.prepare('SELECT status, imageBase64, correction_payload FROM pending_cases WHERE id = ?').get(rejectedSubmission.pendingId),
    { status: 'rejected', imageBase64: '', correction_payload: '' },
  )
  const rejectedArchive = db.prepare('SELECT image_path FROM pending_cases WHERE id = ?').get(rejectedSubmission.pendingId)
  assert.match(rejectedArchive.image_path, /^review-images\//)
  await access(join(dataDir, rejectedArchive.image_path))
  assert.equal(await search.getPendingCaseImage(rejectedSubmission.pendingId), JPEG_DATA_URL)
  db.prepare("UPDATE pending_cases SET image_expires_at = '2000-01-01 00:00:00' WHERE id = ?").run(rejectedSubmission.pendingId)
  const cleanup = await activeDbModule.cleanupExpiredPendingCaseImages(new Date('2000-01-02T00:00:00Z'))
  assert.equal(cleanup.deleted, 1)
  assert.equal(cleanup.fileErrors.length, 0)
  assert.deepEqual(
    db.prepare('SELECT image_path, image_deleted_at FROM pending_cases WHERE id = ?').get(rejectedSubmission.pendingId),
    { image_path: '', image_deleted_at: '2000-01-02 00:00:00' },
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM training').get().total, 1)
  assert.equal(activeDbModule.deserializeCase(db.prepare('SELECT * FROM cases WHERE id = ?').get('CASE-SOURCE')).corrections.length, 1)

  // 模拟旧审批在“正式案例已创建、待审状态仍为 approaching”时崩溃；重试必须补齐训练与原案例收口。
  const recoveryFeedback = createReportedFeedback('审批恢复测试')
  const recoverySubmission = await search.saveCorrection(correctionFor(recoveryFeedback, {
    correctedLocation: '天侧',
    remark: '恢复审批时仍须写入全部学习闭环',
  }))
  const recoveryCaseId = `case-review-recovery-${recoverySubmission.pendingId}`
  await search.createCase({
    title: '崩溃前已创建的正式案例',
    imageData: JPEG_DATA_URL,
    crackLocation: '天侧',
    crackShape: '点放射状屏裂',
    result: 'product_quality_issue',
  }, { id: recoveryCaseId })
  db.prepare(`UPDATE pending_cases SET status = 'approving', approved_case_id = ? WHERE id = ?`)
    .run(recoveryCaseId, recoverySubmission.pendingId)

  const recovered = await search.approvePendingCase(recoverySubmission.pendingId, 'recovery-reviewer', '自动恢复')
  assert.equal(recovered.caseId, recoveryCaseId)
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM training').get().total, 2)
  const sourceAfterRecovery = activeDbModule.deserializeCase(db.prepare('SELECT * FROM cases WHERE id = ?').get('CASE-SOURCE'))
  assert.equal(sourceAfterRecovery.corrections.length, 2)
  assert.equal(sourceAfterRecovery.corrections.some(item => item.pendingId === recoverySubmission.pendingId), true)
  assert.deepEqual(
    db.prepare('SELECT status, imageBase64, correction_payload FROM pending_cases WHERE id = ?').get(recoverySubmission.pendingId),
    { status: 'approved', imageBase64: '', correction_payload: '' },
  )

  // 初始化迁移也会先归档旧版本终态行中的图片，再清理数据库大字段。
  db.prepare(`UPDATE pending_cases SET imageBase64 = ?, correction_payload = ? WHERE status IN ('approved', 'rejected')`)
    .run(JPEG_DATA_URL, JSON.stringify({ stale: true }))
  db.close()
  activeDbModule = await import(`../src/db.mjs?terminal-cleanup=${crypto.randomUUID()}`)
  await activeDbModule.initDb()
  assert.equal(
    activeDbModule.getDb().prepare(`SELECT COUNT(*) AS total FROM pending_cases
      WHERE status IN ('approved', 'rejected') AND (imageBase64 <> '' OR correction_payload <> '')`).get().total,
    0,
  )
})

test('legacy feedback and pending schemas migrate without retaining terminal images', { concurrency: false }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'screen-damage-correction-legacy-'))
  const previousDataDir = process.env.KNOWLEDGE_DATA_DIR
  process.env.KNOWLEDGE_DATA_DIR = dataDir
  let migratedModule
  t.after(async () => {
    try { migratedModule?.getDb().close() } catch {}
    if (previousDataDir === undefined) delete process.env.KNOWLEDGE_DATA_DIR
    else process.env.KNOWLEDGE_DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  })

  const legacy = new Database(join(dataDir, 'knowledge.db'))
  legacy.exec(`
    CREATE TABLE feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT DEFAULT '',
      conclusion TEXT DEFAULT '',
      feedback TEXT NOT NULL,
      remark TEXT DEFAULT '',
      source TEXT DEFAULT 'h5',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE pending_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT DEFAULT '',
      deviceModel TEXT DEFAULT '',
      statusObs TEXT DEFAULT '',
      crackLocation TEXT DEFAULT '',
      crackShape TEXT DEFAULT '',
      crackPrinciple TEXT DEFAULT '',
      crackStage TEXT DEFAULT '',
      result TEXT DEFAULT '',
      remark TEXT DEFAULT '',
      imageBase64 TEXT DEFAULT '',
      source TEXT DEFAULT 'manual_correction',
      status TEXT DEFAULT 'pending',
      reviewed_by TEXT DEFAULT '',
      review_remark TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      reviewed_at TEXT DEFAULT ''
    );
    INSERT INTO feedback (case_id, conclusion, feedback, remark)
      VALUES ('LEGACY-CASE', 'not_product_quality', 'incorrect', '旧反馈');
  `)
  const insertLegacyPending = legacy.prepare(`INSERT INTO pending_cases (
    title, crackLocation, crackShape, result, remark, imageBase64, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  insertLegacyPending.run('旧已批准', '中央区域', '单条线状屏裂', 'no_damage', '旧备注', JPEG_DATA_URL, 'approved')
  insertLegacyPending.run('旧已驳回', '左侧', '点放射状屏裂', 'product_quality_issue', '旧备注', JPEG_DATA_URL, 'rejected')
  legacy.close()

  migratedModule = await import(`../src/db.mjs?legacy-correction=${crypto.randomUUID()}`)
  await migratedModule.initDb()
  const db = migratedModule.getDb()
  const columns = table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name))
  assert.equal(columns('pending_cases').has('feedback_id'), true)
  assert.equal(columns('pending_cases').has('source_case_id'), true)
  assert.equal(columns('pending_cases').has('correction_payload'), true)
  assert.equal(columns('pending_cases').has('image_path'), true)
  assert.equal(columns('pending_cases').has('image_expires_at'), true)
  assert.equal(columns('feedback').has('correction_pending_id'), true)
  assert.equal(columns('feedback').has('correction_consumed_at'), true)
  assert.equal(columns('training').has('source_pending_id'), true)
  assert.deepEqual(
    db.prepare('SELECT status, capability_hash, correction_pending_id FROM feedback WHERE id = 1').get(),
    { status: 'reported_incorrect', capability_hash: '', correction_pending_id: null },
  )
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS total FROM pending_cases
      WHERE status IN ('approved', 'rejected') AND imageBase64 <> ''`).get().total,
    0,
  )
  const archivedLegacy = db.prepare(`SELECT image_path, image_mime_type, image_file_size, image_expires_at
    FROM pending_cases ORDER BY id`).all()
  assert.equal(archivedLegacy.every(row => row.image_path.startsWith('review-images/')), true)
  assert.equal(archivedLegacy.every(row => row.image_mime_type === 'image/jpeg' && row.image_file_size === 4), true)
  assert.equal(archivedLegacy.every(row => row.image_expires_at), true)
})
