import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

test('assessment records persist fields and local images while retaining feedback capability semantics', { concurrency: false }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'screen-damage-assessment-'))
  const previousDataDir = process.env.KNOWLEDGE_DATA_DIR
  process.env.KNOWLEDGE_DATA_DIR = dataDir

  const dbModule = await import('../src/db.mjs')
  const records = await import('../src/assessment-records.mjs')
  const databaseBatch = await import('../src/database-batch.mjs')
  t.after(async () => {
    try { dbModule.getDb().close() } catch {}
    if (previousDataDir === undefined) delete process.env.KNOWLEDGE_DATA_DIR
    else process.env.KNOWLEDGE_DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  })
  await dbModule.initDb()

  const capabilityToken = crypto.randomBytes(32).toString('base64url')
  const submissionId = crypto.randomUUID()
  const created = await records.createAssessmentRecord({
    submissionId,
    capabilityToken,
    images: [ONE_PIXEL_PNG],
    installStatus: 'not_installed',
    authPersonnel: 'yes',
    packageDamage: 'none',
    faultLinks: [],
    analysisMode: 'hybrid',
  })
  assert.equal(created.created, true)

  const db = dbModule.getDb()
  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(created.id)
  assert.equal(row.submission_id, submissionId)
  assert.equal(row.process_status, 'analyzing')
  assert.equal(row.install_status, 'not_installed')
  assert.equal(row.image_count, 1)
  assert.equal(row.capability_hash, crypto.createHash('sha256').update(capabilityToken).digest('hex'))

  const imageRow = db.prepare('SELECT * FROM feedback_images WHERE feedback_id = ?').get(created.id)
  assert.equal(imageRow.mime_type, 'image/png')
  assert.equal(imageRow.width, 1)
  assert.equal(imageRow.height, 1)
  await access(join(dataDir, 'feedback-images', imageRow.filename))

  const duplicate = await records.createAssessmentRecord({
    submissionId,
    capabilityToken,
    images: [ONE_PIXEL_PNG],
  })
  assert.equal(duplicate.created, false)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM feedback_images WHERE feedback_id = ?').get(created.id).count, 1)
  await assert.rejects(
    records.createAssessmentRecord({ submissionId, capabilityToken: crypto.randomBytes(32).toString('base64url'), images: [ONE_PIXEL_PNG] }),
    error => error.code === 'SUBMISSION_EXISTS',
  )

  const completed = records.updateAssessmentRecord({
    submissionId,
    capabilityToken,
    processStatus: 'completed',
    faultLinks: ['product_factor'],
    analysis: { location: '右下角', conclusion: 'product_quality_issue' },
    decision: { result: 'product_quality_issue', resultLabel: '质量问题' },
    llmConclusion: 'product_quality_issue',
    finalResult: 'product_quality_issue',
    caseId: 'CASE-1',
  })
  assert.equal(completed.processStatus, 'completed')
  assert.deepEqual(completed.faultLinks, ['product_factor'])
  assert.equal(dbModule.getFeedbackStats().total, 1)
  assert.equal(dbModule.confirmFeedback(created.id, capabilityToken).updated, 1)

  const listed = records.listAssessmentRecords({ page: 1, pageSize: 10, feedbackStatus: 'confirmed_correct' })
  assert.equal(listed.total, 1)
  assert.equal(listed.items[0].thumbnailImageId, imageRow.id)
  const detail = records.getAssessmentRecord(submissionId)
  assert.equal(detail.images.length, 1)
  assert.equal(detail.analysis.location, '右下角')
  const image = await records.readAssessmentImage(imageRow.id)
  assert.equal(image.mimeType, 'image/png')
  assert.ok(image.data.length > 0)

  const failedToken = crypto.randomBytes(32).toString('base64url')
  const failed = await records.createAssessmentRecord({
    submissionId: crypto.randomUUID(),
    capabilityToken: failedToken,
    images: [ONE_PIXEL_PNG],
    analysisMode: 'rag',
  })
  records.updateAssessmentRecord({
    submissionId: failed.submissionId,
    capabilityToken: failedToken,
    processStatus: 'failed',
    errorMessage: '分析超时',
  })
  assert.equal(dbModule.getFeedbackStats().total, 1)

  const legacyInfo = db.prepare(`INSERT INTO feedback (
    case_id, conclusion, status, remark, source, submission_id, process_status, image_count
  ) VALUES ('CASE-LEGACY', 'legacy', 'unconfirmed', '旧版无图片记录', 'h5', '', 'completed', 0)`).run()
  const legacyId = Number(legacyInfo.lastInsertRowid)
  const removedLegacy = await records.deleteFeedbackRecord(legacyId)
  assert.deepEqual(removedLegacy, { id: legacyId, submissionId: '', deletedImages: 0 })
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM feedback WHERE id = ?').get(legacyId).count, 0)

  const protectedInfo = db.prepare(`INSERT INTO feedback (
    case_id, conclusion, status, remark, source, submission_id, process_status, image_count, correction_pending_id
  ) VALUES ('CASE-PROTECTED', 'legacy', 'reported_incorrect', '受保护记录', 'h5', '', 'completed', 0, 999)`).run()
  const protectedId = Number(protectedInfo.lastInsertRowid)
  await assert.rejects(
    records.deleteFeedbackRecord(protectedId),
    error => error.code === 'ASSESSMENT_HAS_CORRECTION',
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM feedback WHERE id = ?').get(protectedId).count, 1)

  const imagePreview = databaseBatch.previewDatabaseBatch('feedback_images', [imageRow.id])
  assert.equal(imagePreview.deletable, 1)
  assert.equal(imagePreview.affectedRecords, 1)
  assert.equal(imagePreview.relatedImages, 1)

  const trainingInfo = db.prepare("INSERT INTO training (location, shape, source) VALUES ('左侧', '线裂', 'test')").run()
  const trainingId = Number(trainingInfo.lastInsertRowid)
  const removedTraining = await databaseBatch.deleteDatabaseBatch('training', [trainingId])
  assert.equal(removedTraining.deleted, 1)

  const rejectedPending = Number(db.prepare("INSERT INTO pending_cases (title, status) VALUES ('可删除', 'rejected')").run().lastInsertRowid)
  const approvedPending = Number(db.prepare("INSERT INTO pending_cases (title, status) VALUES ('受保护', 'approved')").run().lastInsertRowid)
  const pendingPreview = databaseBatch.previewDatabaseBatch('pending_cases', [rejectedPending, approvedPending])
  assert.equal(pendingPreview.deletable, 1)
  assert.equal(pendingPreview.protected, 1)
  const removedPending = await databaseBatch.deleteDatabaseBatch('pending_cases', [rejectedPending, approvedPending])
  assert.equal(removedPending.deleted, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pending_cases WHERE id = ?').get(approvedPending).count, 1)

  db.prepare("INSERT INTO schema_migrations (name) VALUES ('protected-test-migration')").run()
  const migrationPreview = databaseBatch.previewDatabaseBatch('schema_migrations', ['protected-test-migration'])
  assert.equal(migrationPreview.deletable, 0)
  assert.equal(migrationPreview.protected, 1)

  const batchLegacyInfo = db.prepare(`INSERT INTO feedback (
    case_id, conclusion, status, remark, source, submission_id, process_status, image_count
  ) VALUES ('CASE-BATCH', 'legacy', 'unconfirmed', '批量删除记录', 'h5', '', 'completed', 0)`).run()
  const batchLegacyId = Number(batchLegacyInfo.lastInsertRowid)
  const failedImage = db.prepare('SELECT filename FROM feedback_images WHERE feedback_id = ?').get(failed.id)
  const batchRemoved = await records.deleteFeedbackRecords([batchLegacyId, failed.id, protectedId, 999999])
  assert.equal(batchRemoved.requested, 4)
  assert.equal(batchRemoved.deleted, 2)
  assert.equal(batchRemoved.deletedImages, 1)
  assert.equal(batchRemoved.notFound, 1)
  assert.deepEqual(batchRemoved.skippedProtected.map(row => row.id), [protectedId])
  assert.deepEqual(batchRemoved.fileErrors, [])
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM feedback WHERE id IN (?, ?)').get(batchLegacyId, failed.id).count, 0)
  await assert.rejects(access(join(dataDir, 'feedback-images', failedImage.filename)))

  const removed = await records.deleteAssessmentRecord(submissionId)
  assert.equal(removed.deletedImages, 1)
  await assert.rejects(access(join(dataDir, 'feedback-images', imageRow.filename)))
})
