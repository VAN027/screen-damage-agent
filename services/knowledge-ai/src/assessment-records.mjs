import crypto from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import sharp from 'sharp'
import { DATA_DIR, getDb } from './db.mjs'

const IMAGE_ROOT = join(DATA_DIR, 'feedback-images')
const MAX_IMAGES = 5
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_JSON_CHARS = 128 * 1024
const PROCESS_STATUSES = new Set(['analyzing', 'completed', 'failed'])
const FEEDBACK_STATUSES = new Set(['unconfirmed', 'confirmed_correct', 'reported_incorrect'])
const ANALYSIS_MODES = new Set(['hybrid', 'rag', 'llm'])
const createLocks = new Map()

class AssessmentRecordError extends Error {
  constructor(statusCode, code, message) {
    super(message)
    this.name = 'AssessmentRecordError'
    this.statusCode = statusCode
    this.code = code
    this.expose = true
  }
}

function fail(statusCode, code, message) {
  throw new AssessmentRecordError(statusCode, code, message)
}

function boundedString(value, field, maxLength) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') fail(400, 'INVALID_FIELD', `${field} 必须是字符串`)
  const text = value.trim()
  if (text.length > maxLength) fail(400, 'INVALID_FIELD', `${field} 超过 ${maxLength} 字符上限`)
  return text
}

function normalizeSubmissionId(value) {
  const id = boundedString(value, 'submissionId', 64)
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    fail(400, 'INVALID_SUBMISSION_ID', 'submissionId 格式无效')
  }
  return id
}

function normalizeCapabilityToken(value) {
  const token = boundedString(value, 'capabilityToken', 128)
  if (token.length < 32) fail(400, 'INVALID_CAPABILITY', '鉴定记录凭证无效')
  return token
}

function capabilityHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function hashMatches(actual, expected) {
  const a = Buffer.from(String(actual || ''))
  const b = Buffer.from(String(expected || ''))
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b)
}

function normalizeFaultLinks(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 10) fail(400, 'INVALID_FIELD', 'faultLinks 格式无效')
  const links = value.map(item => boundedString(item, 'faultLinks', 64)).filter(Boolean)
  return [...new Set(links)]
}

function jsonText(value, field, fallback = {}) {
  if (value === undefined) return null
  const normalized = value === null ? fallback : value
  if (typeof normalized !== 'object' || Array.isArray(normalized)) {
    fail(400, 'INVALID_FIELD', `${field} 必须是对象`)
  }
  const text = JSON.stringify(normalized)
  if (text.length > MAX_JSON_CHARS) fail(400, 'INVALID_FIELD', `${field} 内容过大`)
  return text
}

function safeJsonParse(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function decodeImage(dataUrl, index) {
  if (typeof dataUrl !== 'string') fail(400, 'INVALID_IMAGE', `第 ${index + 1} 张图片格式无效`)
  const match = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i)
  if (!match) fail(400, 'INVALID_IMAGE', `第 ${index + 1} 张图片格式无效`)
  const buffer = Buffer.from(match[2], 'base64')
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    fail(413, 'IMAGE_TOO_LARGE', `第 ${index + 1} 张图片超过大小限制`)
  }

  let metadata
  try {
    metadata = await sharp(buffer, { limitInputPixels: 40_000_000 }).metadata()
  } catch {
    fail(400, 'INVALID_IMAGE', `第 ${index + 1} 张图片无法解析`)
  }
  const format = metadata.format === 'jpg' ? 'jpeg' : metadata.format
  if (!['jpeg', 'png', 'webp'].includes(format) || !metadata.width || !metadata.height) {
    fail(400, 'INVALID_IMAGE', `第 ${index + 1} 张图片类型不受支持`)
  }
  const extension = format === 'jpeg' ? '.jpg' : `.${format}`
  return {
    buffer,
    extension,
    mimeType: format === 'jpeg' ? 'image/jpeg' : `image/${format}`,
    width: metadata.width,
    height: metadata.height,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  }
}

function publicRecord(row) {
  return {
    id: Number(row.id),
    submissionId: row.submission_id,
    processStatus: row.process_status,
    feedbackStatus: row.status,
    installStatus: row.install_status,
    authPersonnel: row.auth_personnel,
    packageDamage: row.package_damage,
    faultLinks: safeJsonParse(row.fault_links, []),
    analysisMode: row.analysis_mode,
    llmConclusion: row.llm_conclusion,
    finalResult: row.final_result,
    imageCount: Number(row.image_count) || 0,
    errorMessage: row.error_message,
    caseId: row.case_id,
    remark: row.remark,
    correctionPendingId: row.correction_pending_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    ...(row.analysis_payload === undefined ? {} : { analysis: safeJsonParse(row.analysis_payload, {}) }),
    ...(row.decision_payload === undefined ? {} : { decision: safeJsonParse(row.decision_payload, {}) }),
  }
}

async function createAssessmentRecordUnlocked(data) {
  const db = getDb()
  const submissionId = normalizeSubmissionId(data?.submissionId)
  const capabilityToken = normalizeCapabilityToken(data?.capabilityToken)
  const expectedHash = capabilityHash(capabilityToken)
  const existing = db.prepare('SELECT * FROM feedback WHERE submission_id = ?').get(submissionId)
  if (existing) {
    if (!hashMatches(existing.capability_hash, expectedHash)) {
      fail(409, 'SUBMISSION_EXISTS', '该鉴定记录已存在')
    }
    return { id: Number(existing.id), submissionId, capabilityToken, created: false }
  }

  const images = data?.images
  if (!Array.isArray(images) || images.length === 0 || images.length > MAX_IMAGES) {
    fail(400, 'INVALID_IMAGES', `请提供 1-${MAX_IMAGES} 张图片`)
  }
  const decodedImages = []
  let totalBytes = 0
  for (let index = 0; index < images.length; index++) {
    const decoded = await decodeImage(images[index], index)
    totalBytes += decoded.buffer.length
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) fail(413, 'IMAGES_TOO_LARGE', '图片总大小超过限制')
    decodedImages.push(decoded)
  }

  const installStatus = boundedString(data?.installStatus, 'installStatus', 32)
  const authPersonnel = boundedString(data?.authPersonnel, 'authPersonnel', 32)
  const packageDamage = boundedString(data?.packageDamage, 'packageDamage', 32)
  const faultLinks = normalizeFaultLinks(data?.faultLinks)
  const analysisMode = boundedString(data?.analysisMode, 'analysisMode', 16)
  if (analysisMode && !ANALYSIS_MODES.has(analysisMode)) fail(400, 'INVALID_FIELD', 'analysisMode 无效')

  const info = db.prepare(`INSERT INTO feedback (
    status, source, capability_hash, submission_id, process_status,
    install_status, auth_personnel, package_damage, fault_links, analysis_mode,
    image_count, updated_at
  ) VALUES (
    'unconfirmed', 'h5', @capability_hash, @submission_id, 'analyzing',
    @install_status, @auth_personnel, @package_damage, @fault_links, @analysis_mode,
    0, datetime('now')
  )`).run({
    capability_hash: expectedHash,
    submission_id: submissionId,
    install_status: installStatus,
    auth_personnel: authPersonnel,
    package_damage: packageDamage,
    fault_links: JSON.stringify(faultLinks),
    analysis_mode: analysisMode,
  })
  const feedbackId = Number(info.lastInsertRowid)
  const dateParts = new Date().toISOString().slice(0, 10).split('-')
  const relativeDir = join(...dateParts, submissionId)
  const targetDir = join(IMAGE_ROOT, relativeDir)

  try {
    await ensurePrivateDir(targetDir)
    const rows = []
    for (let index = 0; index < decodedImages.length; index++) {
      const image = decodedImages[index]
      const basename = `${String(index + 1).padStart(2, '0')}${image.extension}`
      const relativeFilename = join(relativeDir, basename)
      const finalPath = join(IMAGE_ROOT, relativeFilename)
      const temporaryPath = `${finalPath}.${crypto.randomUUID()}.tmp`
      await writeFile(temporaryPath, image.buffer, { mode: 0o600, flag: 'wx' })
      await rename(temporaryPath, finalPath)
      await chmod(finalPath, 0o600)
      rows.push({
        feedback_id: feedbackId,
        filename: relativeFilename,
        sort_order: index,
        mime_type: image.mimeType,
        file_size: image.buffer.length,
        width: image.width,
        height: image.height,
        sha256: image.sha256,
      })
    }

    const insertImage = db.prepare(`INSERT INTO feedback_images (
      feedback_id, filename, sort_order, mime_type, file_size, width, height, sha256
    ) VALUES (
      @feedback_id, @filename, @sort_order, @mime_type, @file_size, @width, @height, @sha256
    )`)
    db.transaction(items => {
      for (const row of items) insertImage.run(row)
      db.prepare("UPDATE feedback SET image_count = ?, updated_at = datetime('now') WHERE id = ?")
        .run(items.length, feedbackId)
    })(rows)
  } catch (error) {
    db.prepare('DELETE FROM feedback WHERE id = ?').run(feedbackId)
    await rm(targetDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  return { id: feedbackId, submissionId, capabilityToken, created: true }
}

export async function createAssessmentRecord(data) {
  const submissionId = normalizeSubmissionId(data?.submissionId)
  const previous = createLocks.get(submissionId) || Promise.resolve()
  const current = previous.catch(() => {}).then(() => createAssessmentRecordUnlocked(data))
  createLocks.set(submissionId, current)
  try {
    return await current
  } finally {
    if (createLocks.get(submissionId) === current) createLocks.delete(submissionId)
  }
}

export function updateAssessmentRecord(data) {
  const db = getDb()
  const submissionId = normalizeSubmissionId(data?.submissionId)
  const capabilityToken = normalizeCapabilityToken(data?.capabilityToken)
  const row = db.prepare('SELECT * FROM feedback WHERE submission_id = ?').get(submissionId)
  if (!row || !hashMatches(row.capability_hash, capabilityHash(capabilityToken))) {
    fail(404, 'ASSESSMENT_NOT_FOUND', '鉴定记录不存在或凭证无效')
  }

  const processStatus = boundedString(data?.processStatus, 'processStatus', 16)
  if (!PROCESS_STATUSES.has(processStatus)) fail(400, 'INVALID_PROCESS_STATUS', '鉴定流程状态无效')

  const assignments = ['process_status = @process_status', "updated_at = datetime('now')"]
  const params = { id: row.id, process_status: processStatus }
  const optionalStrings = [
    ['caseId', 'case_id', 128],
    ['llmConclusion', 'llm_conclusion', 100],
    ['finalResult', 'final_result', 100],
    ['errorMessage', 'error_message', 1000],
  ]
  for (const [input, column, maxLength] of optionalStrings) {
    if (Object.prototype.hasOwnProperty.call(data, input)) {
      params[column] = boundedString(data[input], input, maxLength)
      assignments.push(`${column} = @${column}`)
    }
  }
  if (Object.prototype.hasOwnProperty.call(data, 'faultLinks')) {
    params.fault_links = JSON.stringify(normalizeFaultLinks(data.faultLinks))
    assignments.push('fault_links = @fault_links')
  }
  const analysisPayload = jsonText(data?.analysis, 'analysis')
  if (analysisPayload !== null) {
    params.analysis_payload = analysisPayload
    assignments.push('analysis_payload = @analysis_payload')
  }
  const decisionPayload = jsonText(data?.decision, 'decision')
  if (decisionPayload !== null) {
    params.decision_payload = decisionPayload
    assignments.push('decision_payload = @decision_payload')
  }
  if (Object.prototype.hasOwnProperty.call(data, 'llmConclusion')) {
    assignments.push('conclusion = @llm_conclusion')
  }
  if (processStatus === 'completed' || processStatus === 'failed') {
    assignments.push("completed_at = datetime('now')")
  } else {
    assignments.push("completed_at = ''")
  }

  db.prepare(`UPDATE feedback SET ${assignments.join(', ')} WHERE id = @id`).run(params)
  return publicRecord(db.prepare('SELECT * FROM feedback WHERE id = ?').get(row.id))
}

export function listAssessmentRecords(filters = {}) {
  const db = getDb()
  const page = Math.max(1, Math.min(Number.parseInt(filters.page, 10) || 1, 1_000_000))
  const pageSize = Math.max(1, Math.min(Number.parseInt(filters.pageSize, 10) || 24, 100))
  const clauses = ["f.submission_id <> ''"]
  const params = {}

  const processStatus = boundedString(filters.processStatus, 'processStatus', 16)
  if (processStatus) {
    if (!PROCESS_STATUSES.has(processStatus)) fail(400, 'INVALID_FILTER', '处理状态筛选无效')
    clauses.push('f.process_status = @process_status')
    params.process_status = processStatus
  }
  const feedbackStatus = boundedString(filters.feedbackStatus, 'feedbackStatus', 32)
  if (feedbackStatus) {
    if (!FEEDBACK_STATUSES.has(feedbackStatus)) fail(400, 'INVALID_FILTER', '反馈状态筛选无效')
    clauses.push('f.status = @feedback_status')
    params.feedback_status = feedbackStatus
  }
  const finalResult = boundedString(filters.finalResult, 'finalResult', 100)
  if (finalResult) {
    clauses.push('f.final_result = @final_result')
    params.final_result = finalResult
  }
  const search = boundedString(filters.search, 'search', 64)
  if (search) {
    clauses.push('(f.submission_id LIKE @search OR f.case_id LIKE @search)')
    params.search = `%${search}%`
  }
  const where = clauses.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) AS count FROM feedback f WHERE ${where}`).get(params).count
  const rows = db.prepare(`SELECT
      f.id, f.submission_id, f.process_status, f.status,
      f.install_status, f.auth_personnel, f.package_damage, f.fault_links,
      f.analysis_mode, f.llm_conclusion, f.final_result, f.image_count,
      f.error_message, f.case_id, f.remark, f.correction_pending_id,
      f.created_at, f.updated_at, f.completed_at,
      (SELECT fi.id FROM feedback_images fi WHERE fi.feedback_id = f.id ORDER BY fi.sort_order, fi.id LIMIT 1) AS thumbnail_image_id
    FROM feedback f
    WHERE ${where}
    ORDER BY f.created_at DESC, f.id DESC
    LIMIT @limit OFFSET @offset`).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize })

  return {
    items: rows.map(row => ({ ...publicRecord(row), thumbnailImageId: row.thumbnail_image_id || null })),
    total: Number(total) || 0,
    page,
    pageSize,
  }
}

export function getAssessmentRecord(submissionIdValue) {
  const db = getDb()
  const submissionId = normalizeSubmissionId(submissionIdValue)
  const row = db.prepare("SELECT * FROM feedback WHERE submission_id = ? AND submission_id <> ''").get(submissionId)
  if (!row) fail(404, 'ASSESSMENT_NOT_FOUND', '鉴定记录不存在')
  const images = db.prepare(`SELECT id, sort_order, mime_type, file_size, width, height, sha256, created_at
    FROM feedback_images WHERE feedback_id = ? ORDER BY sort_order, id`).all(row.id)
  return { ...publicRecord(row), images: images.map(image => ({
    id: Number(image.id),
    sortOrder: Number(image.sort_order),
    mimeType: image.mime_type,
    fileSize: Number(image.file_size),
    width: Number(image.width),
    height: Number(image.height),
    sha256: image.sha256,
    createdAt: image.created_at,
  })) }
}

function containedImagePath(filename) {
  const root = resolve(IMAGE_ROOT)
  const path = resolve(root, filename)
  const rel = relative(root, path)
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || extname(path) === '') {
    fail(404, 'IMAGE_NOT_FOUND', '鉴定图片不存在')
  }
  return path
}

export async function readAssessmentImage(imageIdValue) {
  const imageId = Number.parseInt(imageIdValue, 10)
  if (!Number.isSafeInteger(imageId) || imageId <= 0) fail(400, 'INVALID_IMAGE_ID', '图片 ID 无效')
  const row = getDb().prepare(`SELECT fi.filename, fi.mime_type
    FROM feedback_images fi JOIN feedback f ON f.id = fi.feedback_id
    WHERE fi.id = ? AND f.submission_id <> ''`).get(imageId)
  if (!row) fail(404, 'IMAGE_NOT_FOUND', '鉴定图片不存在')
  try {
    return { data: await readFile(containedImagePath(row.filename)), mimeType: row.mime_type }
  } catch (error) {
    if (error?.code === 'ENOENT') fail(404, 'IMAGE_NOT_FOUND', '鉴定图片文件不存在')
    throw error
  }
}

async function deleteFeedbackRow(db, row) {
  const pendingCorrection = db.prepare('SELECT id FROM pending_cases WHERE feedback_id = ? LIMIT 1').get(row.id)
  if (row.correction_pending_id !== null || pendingCorrection) {
    fail(409, 'ASSESSMENT_HAS_CORRECTION', '该鉴定记录已关联纠错审核，不能删除')
  }
  const files = db.prepare('SELECT filename FROM feedback_images WHERE feedback_id = ? ORDER BY sort_order').all(row.id)
  db.prepare('DELETE FROM feedback WHERE id = ?').run(row.id)
  const directories = new Set(files.map(file => dirname(containedImagePath(file.filename))))
  const imageRoot = resolve(IMAGE_ROOT)
  for (const directory of directories) {
    const relativeDirectory = relative(imageRoot, resolve(directory))
    if (!relativeDirectory || relativeDirectory.startsWith('..')) {
      fail(500, 'UNSAFE_IMAGE_PATH', '拒绝删除不安全的图片目录')
    }
    await rm(directory, { recursive: true, force: true })
  }
  return { id: Number(row.id), submissionId: row.submission_id || '', deletedImages: files.length }
}

export async function deleteAssessmentRecord(submissionIdValue) {
  const db = getDb()
  const submissionId = normalizeSubmissionId(submissionIdValue)
  const row = db.prepare("SELECT id, submission_id, correction_pending_id FROM feedback WHERE submission_id = ? AND submission_id <> ''").get(submissionId)
  if (!row) fail(404, 'ASSESSMENT_NOT_FOUND', '鉴定记录不存在')
  return deleteFeedbackRow(db, row)
}

export async function deleteFeedbackRecord(feedbackIdValue) {
  const db = getDb()
  const feedbackId = Number(feedbackIdValue)
  if (!Number.isSafeInteger(feedbackId) || feedbackId <= 0) fail(400, 'INVALID_FEEDBACK_ID', '鉴定记录 ID 无效')
  const row = db.prepare('SELECT id, submission_id, correction_pending_id FROM feedback WHERE id = ?').get(feedbackId)
  if (!row) fail(404, 'ASSESSMENT_NOT_FOUND', '鉴定记录不存在')
  return deleteFeedbackRow(db, row)
}

export async function deleteFeedbackRecords(feedbackIdValues) {
  if (!Array.isArray(feedbackIdValues)) fail(400, 'INVALID_FEEDBACK_IDS', '请提供鉴定记录 ID 数组')
  const ids = [...new Set(feedbackIdValues.map(value => Number(value)))]
  if (ids.length === 0 || ids.length > 1000 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    fail(400, 'INVALID_FEEDBACK_IDS', '请选择 1-1000 条有效鉴定记录')
  }

  const db = getDb()
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(`SELECT id, submission_id, correction_pending_id FROM feedback WHERE id IN (${placeholders})`).all(...ids)
  const pendingRows = rows.length
    ? db.prepare(`SELECT DISTINCT feedback_id FROM pending_cases WHERE feedback_id IN (${rows.map(() => '?').join(',')})`).all(...rows.map(row => row.id))
    : []
  const pendingIds = new Set(pendingRows.map(row => Number(row.feedback_id)))
  const protectedRows = rows.filter(row => row.correction_pending_id !== null || pendingIds.has(Number(row.id)))
  const protectedIds = new Set(protectedRows.map(row => Number(row.id)))
  const deletableRows = rows.filter(row => !protectedIds.has(Number(row.id)))
  const deletableIds = deletableRows.map(row => Number(row.id))

  const files = deletableIds.length
    ? db.prepare(`SELECT feedback_id, filename FROM feedback_images WHERE feedback_id IN (${deletableIds.map(() => '?').join(',')})`).all(...deletableIds)
    : []
  const imageRoot = resolve(IMAGE_ROOT)
  const directories = new Set()
  for (const file of files) {
    const directory = dirname(containedImagePath(file.filename))
    const relativeDirectory = relative(imageRoot, resolve(directory))
    if (!relativeDirectory || relativeDirectory.startsWith('..')) {
      fail(500, 'UNSAFE_IMAGE_PATH', '拒绝删除不安全的图片目录')
    }
    directories.add(directory)
  }

  let deleted = 0
  if (deletableIds.length) {
    deleted = db.transaction(targetIds => {
      let changes = 0
      for (let offset = 0; offset < targetIds.length; offset += 500) {
        const chunk = targetIds.slice(offset, offset + 500)
        changes += db.prepare(`DELETE FROM feedback WHERE id IN (${chunk.map(() => '?').join(',')})`).run(...chunk).changes
      }
      return changes
    })(deletableIds)
  }

  const fileErrors = []
  for (const directory of directories) {
    try {
      await rm(directory, { recursive: true, force: true })
    } catch (error) {
      fileErrors.push({ directory: relative(imageRoot, directory), message: error.message })
    }
  }

  return {
    requested: ids.length,
    deleted,
    deletedImages: files.length,
    skippedProtected: protectedRows.map(row => ({
      id: Number(row.id),
      submissionId: row.submission_id || '',
      correctionPendingId: row.correction_pending_id === null ? null : Number(row.correction_pending_id),
    })),
    notFound: ids.length - rows.length,
    fileErrors,
  }
}

export { AssessmentRecordError }
