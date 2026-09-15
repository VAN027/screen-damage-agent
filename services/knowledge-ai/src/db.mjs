import Database from 'better-sqlite3'
import { readFile, writeFile, mkdir, access, chmod, rename, unlink, readdir, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { normalizeEvalField } from './field-normalize.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = resolve(process.env.KNOWLEDGE_DATA_DIR || join(__dirname, '..', 'data'))
const BACKUP_DIR = join(DATA_DIR, 'backup')
const REVIEW_IMAGES_DIR = join(DATA_DIR, 'review-images')
const DB_PATH = join(DATA_DIR, 'knowledge.db')
const CASES_FILE = join(DATA_DIR, 'cases.json')
const TRAINING_FILE = join(DATA_DIR, 'training.json')

function configuredReviewImageRetentionDays() {
  const parsed = Number.parseInt(process.env.REVIEW_IMAGE_RETENTION_DAYS || '90', 10)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 3650 ? parsed : 90
}

export const REVIEW_IMAGE_RETENTION_DAYS = configuredReviewImageRetentionDays()

const REVIEW_IMAGE_TYPES = Object.freeze({
  jpeg: { mime: 'image/jpeg', extension: 'jpg' },
  jpg: { mime: 'image/jpeg', extension: 'jpg' },
  png: { mime: 'image/png', extension: 'png' },
  webp: { mime: 'image/webp', extension: 'webp' },
  gif: { mime: 'image/gif', extension: 'gif' },
  bmp: { mime: 'image/bmp', extension: 'bmp' },
  avif: { mime: 'image/avif', extension: 'avif' },
})

function sqliteTimestamp(value = new Date()) {
  return value.toISOString().slice(0, 19).replace('T', ' ')
}

function reviewImageSignatureMatches(subtype, data) {
  if (!Buffer.isBuffer(data) || data.length < 4) return false
  if (subtype === 'jpeg' || subtype === 'jpg') return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
  if (subtype === 'png') return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (subtype === 'gif') return data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a'
  if (subtype === 'webp') return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP'
  if (subtype === 'bmp') return data[0] === 0x42 && data[1] === 0x4d
  if (subtype === 'avif') return data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp' && data.subarray(8, 12).toString('ascii').includes('avif')
  return false
}

function decodeReviewImageDataUrl(value) {
  const match = typeof value === 'string'
    ? value.match(/^data:image\/(jpeg|jpg|png|webp|gif|bmp|avif);base64,([A-Za-z0-9+/]+={0,2})$/i)
    : null
  if (!match) throw new Error('纠错图片不是受支持的 Base64 图片')
  const subtype = match[1].toLowerCase()
  const type = REVIEW_IMAGE_TYPES[subtype]
  const data = Buffer.from(match[2], 'base64')
  if (!data.length || !reviewImageSignatureMatches(subtype, data)) throw new Error('纠错图片内容与格式不匹配')
  return { data, ...type }
}

function resolveStoredReviewImagePath(storedPath) {
  if (typeof storedPath !== 'string' || !storedPath.trim()) return null
  const absolute = resolve(DATA_DIR, storedPath)
  if (absolute === REVIEW_IMAGES_DIR || !absolute.startsWith(REVIEW_IMAGES_DIR + sep)) {
    throw new Error('纠错图片路径越界')
  }
  return absolute
}

async function existingFile(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export async function archivePendingCaseImage(id) {
  const safeId = Number(id)
  if (!Number.isSafeInteger(safeId) || safeId <= 0) throw new Error('纠错审核记录 id 不合法')
  const activeDb = getDb()
  const row = activeDb.prepare(`SELECT id, status, imageBase64, image_path, image_mime_type,
      image_file_size, image_archived_at, image_expires_at
    FROM pending_cases WHERE id = ?`).get(safeId)
  if (!row) return { id: safeId, archived: false, missing: true }
  if (!['approved', 'rejected'].includes(row.status)) return { id: safeId, archived: false, pending: true }

  const now = new Date()
  const archivedAt = sqliteTimestamp(now)
  const expiresAt = sqliteTimestamp(new Date(now.getTime() + REVIEW_IMAGE_RETENTION_DAYS * 86400000))
  const storedAbsolute = resolveStoredReviewImagePath(row.image_path)
  if (storedAbsolute && await existingFile(storedAbsolute)) {
    activeDb.prepare(`UPDATE pending_cases SET
        imageBase64 = '', correction_payload = '',
        image_archived_at = CASE WHEN image_archived_at = '' THEN ? ELSE image_archived_at END,
        image_expires_at = CASE WHEN image_expires_at = '' THEN ? ELSE image_expires_at END,
        image_deleted_at = ''
      WHERE id = ? AND status IN ('approved', 'rejected')`).run(archivedAt, expiresAt, safeId)
    return { id: safeId, archived: true, path: row.image_path, reused: true }
  }

  if (!row.imageBase64) {
    activeDb.prepare(`UPDATE pending_cases SET correction_payload = ''
      WHERE id = ? AND status IN ('approved', 'rejected')`).run(safeId)
    return { id: safeId, archived: false, noImage: true }
  }

  const decoded = decodeReviewImageDataUrl(row.imageBase64)
  const digest = crypto.createHash('sha256').update(decoded.data).digest('hex')
  const dateParts = archivedAt.slice(0, 10).split('-')
  const targetDir = join(REVIEW_IMAGES_DIR, ...dateParts)
  await ensureDir(targetDir)
  const target = join(targetDir, `pending-${safeId}-${digest.slice(0, 16)}.${decoded.extension}`)
  const storedPath = relative(DATA_DIR, target).split(sep).join('/')
  let created = false
  try {
    try {
      await writeFile(target, decoded.data, { flag: 'wx', mode: 0o600 })
      created = true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    await chmod(target, 0o600)
    const updated = activeDb.prepare(`UPDATE pending_cases SET
        image_path = ?, image_mime_type = ?, image_file_size = ?,
        image_archived_at = ?, image_expires_at = ?, image_deleted_at = '',
        imageBase64 = '', correction_payload = ''
      WHERE id = ? AND status IN ('approved', 'rejected')`).run(
      storedPath, decoded.mime, decoded.data.length, archivedAt, expiresAt, safeId,
    )
    if (updated.changes !== 1) {
      if (created) await unlink(target).catch(() => {})
      return { id: safeId, archived: false, stateChanged: true }
    }
    return { id: safeId, archived: true, path: storedPath, bytes: decoded.data.length, expiresAt }
  } catch (error) {
    if (created) await unlink(target).catch(() => {})
    throw error
  }
}

export async function archiveTerminalPendingImages() {
  const activeDb = getDb()
  const rows = activeDb.prepare(`SELECT id FROM pending_cases
    WHERE status IN ('approved', 'rejected')
      AND (imageBase64 <> '' OR correction_payload <> '')`).all()
  let archived = 0
  let failed = 0
  for (const row of rows) {
    try {
      const result = await archivePendingCaseImage(row.id)
      if (result.archived) archived++
    } catch (error) {
      failed++
      console.warn(`[knowledge-ai] 纠错审核记录 ${row.id} 图片归档失败: ${error.message}`)
    }
  }
  return { scanned: rows.length, archived, failed }
}

export async function readPendingCaseImageDataUrl(id) {
  const safeId = Number(id)
  if (!Number.isSafeInteger(safeId) || safeId <= 0) throw new Error('纠错审核记录 id 不合法')
  const row = getDb().prepare(`SELECT imageBase64, image_path, image_mime_type
    FROM pending_cases WHERE id = ?`).get(safeId)
  if (!row) return null
  if (row.imageBase64) return row.imageBase64
  const absolute = resolveStoredReviewImagePath(row.image_path)
  if (!absolute) return ''
  try {
    const data = await readFile(absolute)
    const mime = /^image\/(?:jpeg|png|webp|gif|bmp|avif)$/i.test(row.image_mime_type)
      ? row.image_mime_type.toLowerCase()
      : 'application/octet-stream'
    if (mime === 'application/octet-stream') throw new Error('纠错图片 MIME 类型无效')
    return `data:${mime};base64,${data.toString('base64')}`
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

export async function cleanupExpiredPendingCaseImages(now = new Date()) {
  const activeDb = getDb()
  const cutoff = sqliteTimestamp(now)
  const rows = activeDb.prepare(`SELECT id, image_path FROM pending_cases
    WHERE image_path <> '' AND image_expires_at <> '' AND image_expires_at <= ?
      AND status IN ('approved', 'rejected')`).all(cutoff)
  let deleted = 0
  const fileErrors = []
  for (const row of rows) {
    try {
      const absolute = resolveStoredReviewImagePath(row.image_path)
      if (absolute) await unlink(absolute).catch(error => { if (error?.code !== 'ENOENT') throw error })
      const updated = activeDb.prepare(`UPDATE pending_cases SET
          image_path = '', image_deleted_at = ?
        WHERE id = ? AND image_path = ?`).run(cutoff, row.id, row.image_path)
      deleted += updated.changes
    } catch (error) {
      fileErrors.push({ id: row.id, message: error.message })
    }
  }
  return { scanned: rows.length, deleted, fileErrors }
}

export async function removePendingCaseImageFiles(storedPaths) {
  const uniquePaths = [...new Set((storedPaths || []).filter(Boolean).map(String))]
  const fileErrors = []
  let deletedFiles = 0
  for (const storedPath of uniquePaths) {
    try {
      const absolute = resolveStoredReviewImagePath(storedPath)
      if (!absolute) continue
      await unlink(absolute)
      deletedFiles++
    } catch (error) {
      if (error?.code !== 'ENOENT') fileErrors.push({ path: storedPath, message: error.message })
    }
  }
  return { deletedFiles, fileErrors }
}

// knowledge-ai 是独立进程；其新建的 DB/WAL/备份/用户图片默认仅服务账号可读写。
process.umask(0o077)

let db = null
let initPromise = null

async function ensureDir(dir) {
  try { await access(dir) } catch { await mkdir(dir, { recursive: true, mode: 0o700 }) }
  await chmod(dir, 0o700)
}

async function secureDatabaseFiles() {
  for (const path of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { await chmod(path, 0o600) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  try {
    for (const name of await readdir(BACKUP_DIR)) {
      if (/^knowledge-backup-.*\.db(?:\..*\.tmp)?$/.test(name)) await chmod(join(BACKUP_DIR, name), 0o600)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export function getDb() {
  if (!db) throw new Error('DB not initialized. Call initDb() first.')
  return db
}

export async function initDb() {
  if (!initPromise) {
    initPromise = initializeDb().catch(error => {
      try { db?.close() } catch {}
      db = null
      initPromise = null
      throw error
    })
  }
  return initPromise
}

async function initializeDb() {
  await ensureDir(DATA_DIR)
  await ensureDir(BACKUP_DIR)
  await ensureDir(REVIEW_IMAGES_DIR)

  db = new Database(DB_PATH)

  // 开启 WAL 模式，读写并发性能更好
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  await secureDatabaseFiles()

  // 建表
  db.exec(`
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      deviceModel TEXT DEFAULT '',
      symptoms TEXT DEFAULT '[]',
      crackShape TEXT DEFAULT '',
      crackLocation TEXT DEFAULT '',
      physicalFeature TEXT DEFAULT '',
      liquidState TEXT DEFAULT '',
      installStatus TEXT DEFAULT '',
      packageDamage TEXT DEFAULT '',
      crackStage TEXT DEFAULT '',
      result TEXT DEFAULT '',
      resultLabel TEXT DEFAULT '',
      confidence REAL DEFAULT 0,
      summary TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      images TEXT DEFAULT '[]',
      possibleCause TEXT DEFAULT '',
      warrantyTip TEXT DEFAULT '',
      corrections TEXT DEFAULT '[]',
      needsReview INTEGER DEFAULT 0,
      review_status TEXT DEFAULT 'approved',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pending_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feedback_id INTEGER DEFAULT 0,
      source_case_id TEXT DEFAULT '',
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
      image_path TEXT DEFAULT '',
      image_mime_type TEXT DEFAULT '',
      image_file_size INTEGER DEFAULT 0,
      image_archived_at TEXT DEFAULT '',
      image_expires_at TEXT DEFAULT '',
      image_deleted_at TEXT DEFAULT '',
      correction_payload TEXT DEFAULT '',
      source TEXT DEFAULT 'manual_correction',
      status TEXT DEFAULT 'pending',
      reviewed_by TEXT DEFAULT '',
      review_remark TEXT DEFAULT '',
      approved_case_id TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      reviewed_at TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS training (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      features TEXT DEFAULT '[]',
      location TEXT DEFAULT '',
      shape TEXT DEFAULT '',
      caseId TEXT DEFAULT '',
      originalLocation TEXT DEFAULT '',
      originalShape TEXT DEFAULT '',
      source TEXT DEFAULT 'manual',
      imageBase64 TEXT DEFAULT '',
      source_pending_id INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT NOT NULL UNIQUE,
      case_title TEXT DEFAULT '',
      image_name TEXT DEFAULT '',
      llm_location TEXT DEFAULT '',
      llm_shape TEXT DEFAULT '',
      llm_stage TEXT DEFAULT '',
      llm_conclusion TEXT DEFAULT '',
      llm_description TEXT DEFAULT '',
      llm_severity TEXT DEFAULT '',
      llm_status_obs TEXT DEFAULT '',
      llm_principle TEXT DEFAULT '',
      human_location TEXT DEFAULT '',
      human_shape TEXT DEFAULT '',
      human_stage TEXT DEFAULT '',
      human_conclusion TEXT DEFAULT '',
      human_status_obs TEXT DEFAULT '',
      human_principle TEXT DEFAULT '',
      match_location INTEGER DEFAULT -1,
      match_shape INTEGER DEFAULT -1,
      match_stage INTEGER DEFAULT -1,
      match_conclusion INTEGER DEFAULT -1,
      match_status_obs INTEGER DEFAULT -1,
      match_principle INTEGER DEFAULT -1,
      analyzed INTEGER DEFAULT 0,
      judged_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT DEFAULT '',
      conclusion TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'unconfirmed',
      remark TEXT DEFAULT '',
      source TEXT DEFAULT 'h5',
      capability_hash TEXT NOT NULL DEFAULT '',
      correction_pending_id INTEGER DEFAULT NULL,
      correction_consumed_at TEXT DEFAULT '',
      submission_id TEXT DEFAULT '',
      process_status TEXT NOT NULL DEFAULT 'completed',
      install_status TEXT DEFAULT '',
      auth_personnel TEXT DEFAULT '',
      package_damage TEXT DEFAULT '',
      fault_links TEXT DEFAULT '[]',
      analysis_mode TEXT DEFAULT '',
      analysis_payload TEXT DEFAULT '{}',
      decision_payload TEXT DEFAULT '{}',
      llm_conclusion TEXT DEFAULT '',
      final_result TEXT DEFAULT '',
      image_count INTEGER DEFAULT 0,
      error_message TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS expert_review (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT DEFAULT '',
      conclusion TEXT DEFAULT '',
      verdict TEXT NOT NULL DEFAULT 'expert_verified',
      remark TEXT DEFAULT '',
      reviewed_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS appeal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT DEFAULT '',
      conclusion TEXT DEFAULT '',
      result TEXT NOT NULL DEFAULT '',
      remark TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `)

  // == 迁移：为已有 evaluations 表补充新字段（忽略已存在的错误） ==
  const migrateEvalCol = (col, def) => {
    try { db.exec(`ALTER TABLE evaluations ADD COLUMN ${col} ${def}`) } catch {}
  }
  migrateEvalCol('llm_status_obs', "TEXT DEFAULT ''")
  migrateEvalCol('llm_principle', "TEXT DEFAULT ''")
  migrateEvalCol('match_stage', 'INTEGER DEFAULT -1')
  migrateEvalCol('match_status_obs', 'INTEGER DEFAULT -1')
  migrateEvalCol('match_principle', 'INTEGER DEFAULT -1')
  migrateEvalCol('judged_by', "TEXT DEFAULT ''")
  // RAG 分析结果字段
  migrateEvalCol('rag_location', "TEXT DEFAULT ''")
  migrateEvalCol('rag_shape', "TEXT DEFAULT ''")
  migrateEvalCol('match_rag_location', 'INTEGER DEFAULT -1')
  migrateEvalCol('match_rag_shape', 'INTEGER DEFAULT -1')
  // 添加 case_id 唯一约束（创建唯一索引）
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_case_id ON evaluations(case_id)') } catch {}

  // == 迁移：cases 表 + training 表补充新字段 ==
  const migrateCol = (table, col, def) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`) } catch {}
  }
  migrateCol('cases', 'crackPrinciple', "TEXT DEFAULT ''")
  migrateCol('training', 'statusObs', "TEXT DEFAULT ''")
  migrateCol('training', 'principle', "TEXT DEFAULT ''")
  migrateCol('training', 'stage', "TEXT DEFAULT ''")
  migrateCol('training', 'conclusion', "TEXT DEFAULT ''")
  migrateCol('training', 'originalStatusObs', "TEXT DEFAULT ''")
  migrateCol('training', 'originalPrinciple', "TEXT DEFAULT ''")
  migrateCol('training', 'originalStage', "TEXT DEFAULT ''")
  migrateCol('training', 'originalConclusion', "TEXT DEFAULT ''")
  migrateCol('cases', 'remark', "TEXT DEFAULT ''")
  migrateCol('training', 'remark', "TEXT DEFAULT ''")
  migrateCol('cases', 'review_status', "TEXT DEFAULT 'approved'")
  migrateCol('pending_cases', 'approved_case_id', "TEXT DEFAULT ''")
  migrateCol('pending_cases', 'feedback_id', 'INTEGER DEFAULT 0')
  migrateCol('pending_cases', 'source_case_id', "TEXT DEFAULT ''")
  migrateCol('pending_cases', 'correction_payload', "TEXT DEFAULT ''")
  migrateCol('pending_cases', 'image_path', "TEXT DEFAULT ''")
  migrateCol('pending_cases', 'image_mime_type', "TEXT DEFAULT ''")
  migrateCol('pending_cases', 'image_file_size', 'INTEGER DEFAULT 0')
  migrateCol('pending_cases', 'image_archived_at', "TEXT DEFAULT ''")
  migrateCol('pending_cases', 'image_expires_at', "TEXT DEFAULT ''")
  migrateCol('pending_cases', 'image_deleted_at', "TEXT DEFAULT ''")
  migrateCol('training', 'source_pending_id', 'INTEGER DEFAULT NULL')
  migrateCol('feedback', 'capability_hash', "TEXT NOT NULL DEFAULT ''")
  migrateCol('feedback', 'correction_pending_id', 'INTEGER DEFAULT NULL')
  migrateCol('feedback', 'correction_consumed_at', "TEXT DEFAULT ''")

  // == 迁移：feedback 表改造为四态 status 列（重建表，移除旧的 NOT NULL feedback 列） ==
  const feedbackCols = db.prepare('PRAGMA table_info(feedback)').all().map(c => c.name)
  if (feedbackCols.includes('feedback')) {
    db.transaction(() => {
      db.exec('ALTER TABLE feedback RENAME TO feedback_old')
      db.exec(`CREATE TABLE feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id TEXT DEFAULT '',
        conclusion TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'unconfirmed',
        remark TEXT DEFAULT '',
        source TEXT DEFAULT 'h5',
        capability_hash TEXT NOT NULL DEFAULT '',
        correction_pending_id INTEGER DEFAULT NULL,
        correction_consumed_at TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      )`)
      db.exec(`INSERT INTO feedback (id, case_id, conclusion, status, remark, source, created_at)
        SELECT id, case_id, conclusion,
          CASE feedback WHEN 'correct' THEN 'confirmed_correct' WHEN 'incorrect' THEN 'reported_incorrect' ELSE 'unconfirmed' END,
          remark, source, created_at
        FROM feedback_old`)
      db.exec('DROP TABLE feedback_old')
    })()
  }

  // == 迁移：feedback 升级为在线鉴定主记录，图片元数据单独存表 ==
  migrateCol('feedback', 'submission_id', "TEXT DEFAULT ''")
  migrateCol('feedback', 'process_status', "TEXT NOT NULL DEFAULT 'completed'")
  migrateCol('feedback', 'install_status', "TEXT DEFAULT ''")
  migrateCol('feedback', 'auth_personnel', "TEXT DEFAULT ''")
  migrateCol('feedback', 'package_damage', "TEXT DEFAULT ''")
  migrateCol('feedback', 'fault_links', "TEXT DEFAULT '[]'")
  migrateCol('feedback', 'analysis_mode', "TEXT DEFAULT ''")
  migrateCol('feedback', 'analysis_payload', "TEXT DEFAULT '{}'")
  migrateCol('feedback', 'decision_payload', "TEXT DEFAULT '{}'")
  migrateCol('feedback', 'llm_conclusion', "TEXT DEFAULT ''")
  migrateCol('feedback', 'final_result', "TEXT DEFAULT ''")
  migrateCol('feedback', 'image_count', 'INTEGER DEFAULT 0')
  migrateCol('feedback', 'error_message', "TEXT DEFAULT ''")
  migrateCol('feedback', 'updated_at', "TEXT DEFAULT ''")
  migrateCol('feedback', 'completed_at', "TEXT DEFAULT ''")
  db.exec(`CREATE TABLE IF NOT EXISTS feedback_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feedback_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    width INTEGER DEFAULT 0,
    height INTEGER DEFAULT 0,
    sha256 TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (feedback_id) REFERENCES feedback(id) ON DELETE CASCADE
  )`)
  db.prepare("UPDATE feedback SET updated_at = created_at WHERE updated_at = ''").run()

  // 旧版本终态行可能仍保存 Base64。先可靠写入磁盘，再清空大字段；失败时保留原数据供下次重试。
  const archiveMigration = await archiveTerminalPendingImages()
  if (archiveMigration.failed) {
    console.warn(`[knowledge-ai] ${archiveMigration.failed} 条历史纠错图片归档失败，Base64 已保留以便重试`)
  }

  // 每条报错反馈只能生成一个待审纠错，每个待审纠错也只能写入一条训练样本。
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_feedback_once
      ON pending_cases(feedback_id) WHERE feedback_id > 0;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_training_pending_once
      ON training(source_pending_id) WHERE source_pending_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_submission_id
      ON feedback(submission_id) WHERE submission_id <> '';
    CREATE INDEX IF NOT EXISTS idx_feedback_created_at
      ON feedback(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feedback_process_status
      ON feedback(process_status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feedback_images_feedback
      ON feedback_images(feedback_id, sort_order);
  `)

  // 预编译常用语句
  const stmts = {
    // cases CRUD
    allCases: db.prepare('SELECT * FROM cases ORDER BY created_at DESC'),
    approvedCases: db.prepare("SELECT * FROM cases WHERE review_status = 'approved' ORDER BY created_at DESC"),
    caseById: db.prepare('SELECT * FROM cases WHERE id = ?'),
    insertPending: db.prepare(`INSERT INTO pending_cases (
      feedback_id, source_case_id, title, deviceModel, statusObs, crackLocation,
      crackShape, crackPrinciple, crackStage, result, remark, imageBase64,
      correction_payload, source
    ) VALUES (
      @feedback_id, @source_case_id, @title, @deviceModel, @statusObs, @crackLocation,
      @crackShape, @crackPrinciple, @crackStage, @result, @remark, @imageBase64,
      @correction_payload, @source
    )`),
    pendingAll: db.prepare('SELECT * FROM pending_cases ORDER BY created_at DESC'),
    pendingById: db.prepare('SELECT * FROM pending_cases WHERE id = ?'),
    pendingUpdateStatus: db.prepare(`UPDATE pending_cases SET status = ?, reviewed_by = ?, review_remark = ?, reviewed_at = datetime('now') WHERE id = ?`),
    pendingClaimApproval: db.prepare(`UPDATE pending_cases SET
      status = 'approving', approved_case_id = ?, reviewed_by = ?, review_remark = ?, reviewed_at = datetime('now')
      WHERE id = ? AND status = 'pending'`),
    pendingFinalizeApproval: db.prepare(`UPDATE pending_cases SET
      status = 'approved', reviewed_by = ?, review_remark = ?, reviewed_at = datetime('now')
      WHERE id = ? AND status = 'approving' AND approved_case_id = ?`),
    pendingResetApproval: db.prepare(`UPDATE pending_cases SET
      status = 'pending', approved_case_id = '', reviewed_at = ''
      WHERE id = ? AND status = 'approving' AND approved_case_id = ?`),
    pendingReject: db.prepare(`UPDATE pending_cases SET
      status = 'rejected', reviewed_by = ?, review_remark = ?, reviewed_at = datetime('now')
      WHERE id = ? AND status = 'pending'`),
    pendingCount: db.prepare('SELECT COUNT(*) as total FROM pending_cases WHERE status = ?'),
    feedbackForCorrection: db.prepare(`SELECT id, case_id, status, capability_hash, correction_pending_id
      FROM feedback WHERE id = ?`),
    prepareFeedbackForCorrection: db.prepare(`UPDATE feedback SET
      status = 'reported_incorrect', remark = @remark
      WHERE id = @feedback_id
        AND case_id = @case_id
        AND capability_hash = @capability_hash
        AND status IN ('unconfirmed', 'reported_incorrect')
        AND correction_pending_id IS NULL`),
    consumeFeedbackForCorrection: db.prepare(`UPDATE feedback SET
      correction_pending_id = @pending_id, correction_consumed_at = datetime('now')
      WHERE id = @feedback_id
        AND case_id = @case_id
        AND capability_hash = @capability_hash
        AND status = 'reported_incorrect'
        AND correction_pending_id IS NULL`),
    insertCase: db.prepare(`INSERT INTO cases (
      id, title, deviceModel, symptoms, crackShape, crackLocation,
      physicalFeature, liquidState, installStatus, packageDamage,
      crackStage, crackPrinciple, result, resultLabel, summary, tags,
      images, possibleCause, warrantyTip, corrections, needsReview, remark, review_status
    ) VALUES (
      @id, @title, @deviceModel, @symptoms, @crackShape, @crackLocation,
      @physicalFeature, @liquidState, @installStatus, @packageDamage,
      @crackStage, @crackPrinciple, @result, @resultLabel, @summary, @tags,
      @images, @possibleCause, @warrantyTip, @corrections, @needsReview, @remark, @review_status
    )`),
    updateCase: db.prepare(`UPDATE cases SET
      title = @title, deviceModel = @deviceModel, symptoms = @symptoms,
      crackShape = @crackShape, crackLocation = @crackLocation,
      physicalFeature = @physicalFeature, liquidState = @liquidState,
      installStatus = @installStatus, packageDamage = @packageDamage,
      crackStage = @crackStage, crackPrinciple = @crackPrinciple,
      result = @result, resultLabel = @resultLabel,
      summary = @summary, tags = @tags,
      images = @images, possibleCause = @possibleCause,
      warrantyTip = @warrantyTip, corrections = @corrections,
      needsReview = @needsReview, remark = @remark, updated_at = datetime('now')
      WHERE id = @id`),
    deleteCase: db.prepare('DELETE FROM cases WHERE id = ?'),
    deleteCasesByIds: (ids) => {
      const placeholders = ids.map(() => '?').join(',')
      return db.prepare(`DELETE FROM cases WHERE id IN (${placeholders})`).run(...ids)
    },
    countCases: db.prepare('SELECT COUNT(*) as total FROM cases'),

    // training CRUD
    allTraining: db.prepare('SELECT * FROM training ORDER BY created_at DESC'),
    insertTraining: db.prepare(`INSERT INTO training (
      features, statusObs, location, shape, principle, stage, conclusion,
      caseId, originalStatusObs, originalLocation, originalShape, originalPrinciple, originalStage, originalConclusion,
      source, imageBase64, remark, source_pending_id
    ) VALUES (
      @features, @statusObs, @location, @shape, @principle, @stage, @conclusion,
      @caseId, @originalStatusObs, @originalLocation, @originalShape, @originalPrinciple, @originalStage, @originalConclusion,
      @source, @imageBase64, @remark, @source_pending_id
    )`),
    trainingByPendingId: db.prepare('SELECT * FROM training WHERE source_pending_id = ?'),
    countTraining: db.prepare('SELECT COUNT(*) as total FROM training'),
  }

  return stmts
}

/**
 * 从旧的 cases.json 迁移数据到 SQLite
 */
export async function migrateFromJson(stmts) {
  let migrated = 0
  const hasMigration = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
  const markMigration = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)')

  const readLegacyArray = async (path, label) => {
    let raw
    try { raw = await readFile(path, 'utf-8') }
    catch (error) {
      if (error?.code === 'ENOENT') return null
      throw new Error(`[db] ${label} 读取失败: ${error.message}`)
    }
    let parsed
    try { parsed = JSON.parse(raw) }
    catch (error) { throw new Error(`[db] ${label} JSON 损坏: ${error.message}`) }
    if (!Array.isArray(parsed)) throw new Error(`[db] ${label} 必须是 JSON 数组`)
    return parsed
  }

  if (!hasMigration.get('legacy_cases_json_v1')) {
    const cases = await readLegacyArray(CASES_FILE, 'cases.json')
    if (cases === null) {
      console.log('[db] cases.json 不存在，跳过')
    } else {
      let inserted = 0
      db.transaction(() => {
        for (const c of cases) {
          if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.id !== 'string' || !c.id) {
            throw new Error('cases.json 包含缺少 id 的无效案例')
          }
          if (stmts.caseById.get(c.id)) continue
          stmts.insertCase.run(serializeCase(c))
          inserted++
        }
        markMigration.run('legacy_cases_json_v1')
      })()
      migrated += inserted
      console.log(`[db] 已从 cases.json 迁移 ${inserted} 条案例（跳过 ${cases.length - inserted} 条重复项）`)
    }
  }

  if (!hasMigration.get('legacy_training_json_v1')) {
    const training = await readLegacyArray(TRAINING_FILE, 'training.json')
    if (training === null) {
      console.log('[db] training.json 不存在，跳过')
    } else {
      // 旧训练表无自然主键；以完整序列化内容去重，避免迁移中断或旧版本重复导入。
      const fingerprints = new Set(stmts.allTraining.all().map(row =>
        crypto.createHash('sha256').update(JSON.stringify(serializeTraining(deserializeTraining(row)))).digest('hex')
      ))
      let inserted = 0
      db.transaction(() => {
        for (const t of training) {
          if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('training.json 包含无效训练数据')
          const serialized = serializeTraining(t)
          const fingerprint = crypto.createHash('sha256').update(JSON.stringify(serialized)).digest('hex')
          if (fingerprints.has(fingerprint)) continue
          stmts.insertTraining.run(serialized)
          fingerprints.add(fingerprint)
          inserted++
        }
        markMigration.run('legacy_training_json_v1')
      })()
      migrated += inserted
      console.log(`[db] 已从 training.json 迁移 ${inserted} 条训练数据（跳过 ${training.length - inserted} 条重复项）`)
    }
  }

  return migrated
}

// ========== 序列化辅助函数 ==========

export function serializeCase(c) {
  return {
    id: c.id,
    title: c.title || '',
    deviceModel: c.deviceModel || '',
    symptoms: JSON.stringify(c.symptoms || []),
    crackShape: JSON.stringify(
      Array.isArray(c.crackShape) ? c.crackShape : (c.crackShape ? [c.crackShape] : [])
    ),
    crackLocation: c.crackLocation || '',
    physicalFeature: c.physicalFeature || '',
    liquidState: c.liquidState || '',
    installStatus: c.installStatus || '',
    packageDamage: c.packageDamage || '',
    crackStage: c.crackStage || '',
    crackPrinciple: c.crackPrinciple || '',
    result: c.result || '',
    resultLabel: c.resultLabel || '',
    summary: c.summary || '',
    tags: JSON.stringify(c.tags || []),
    images: JSON.stringify(c.images || []),
    possibleCause: c.possibleCause || '',
    warrantyTip: c.warrantyTip || '',
    corrections: JSON.stringify(c.corrections || []),
    needsReview: c.needsReview ? 1 : 0,
    remark: c.remark || '',
    review_status: c.review_status || 'approved',
  }
}

export function deserializeCase(row) {
  return {
    ...row,
    symptoms: safeJsonParse(row.symptoms, []),
    crackShape: (() => {
      if (Array.isArray(row.crackShape)) return row.crackShape
      try {
        const v = JSON.parse(row.crackShape || '[]')
        return Array.isArray(v) ? v : [row.crackShape]
      } catch {
        return row.crackShape ? [row.crackShape] : []
      }
    })(),
    tags: safeJsonParse(row.tags, []),
    images: safeJsonParse(row.images, []),
    corrections: safeJsonParse(row.corrections, []),
    needsReview: !!row.needsReview,
  }
}

export function serializeTraining(t) {
  return {
    features: JSON.stringify(t.features || []),
    statusObs: t.statusObs || '',
    location: t.location || '',
    shape: t.shape || '',
    principle: t.principle || '',
    stage: t.stage || '',
    conclusion: t.conclusion || '',
    caseId: t.caseId || '',
    originalStatusObs: t.originalStatusObs || '',
    originalLocation: t.originalLocation || '',
    originalShape: t.originalShape || '',
    originalPrinciple: t.originalPrinciple || '',
    originalStage: t.originalStage || '',
    originalConclusion: t.originalConclusion || '',
    source: t.source || 'manual',
    imageBase64: t.imageBase64 || '',
    remark: t.remark || '',
    source_pending_id: Number.isSafeInteger(Number(t.source_pending_id)) && Number(t.source_pending_id) > 0
      ? Number(t.source_pending_id)
      : null,
  }
}

export function deserializeTraining(row) {
  return {
    ...row,
    features: safeJsonParse(row.features, []),
  }
}

function safeJsonParse(val, fallback) {
  if (typeof val === 'object') return val
  try { return JSON.parse(val) } catch { return fallback }
}

/**
 * 执行 WAL checkpoint，回收 wal 文件占用空间
 * 建议在空闲时段定期调用
 */
export function checkpointWal() {
  if (!db) return
  try {
    db.pragma('wal_checkpoint(RESTART)')
  } catch (e) {
    console.warn('[db] WAL checkpoint 失败:', e.message)
  }
}

/**
 * 备份 SQLite 数据库到指定路径
 * @param {string} backupPath - 备份文件路径（默认 data/knowledge-backup-{日期}.db）
 * @returns {string} 备份文件路径
 */
export async function backupDb(backupPath) {
  if (!db) await initDb()
  const date = new Date().toISOString().slice(0, 10)
  const dest = backupPath || join(BACKUP_DIR, `knowledge-backup-${date}.db`)
  const tempDest = `${dest}.${process.pid}.${crypto.randomUUID()}.tmp`

  // 先 checkpoint 回收 WAL 空间
  checkpointWal()

  try {
    // 先生成完整私有临时文件，再原子替换旧备份，避免失败时丢失最后一份可用备份。
    db.exec(`VACUUM INTO '${tempDest.replace(/'/g, "''")}'`)
    await chmod(tempDest, 0o600)
    try {
      await rename(tempDest, dest)
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error
      await unlink(dest).catch(unlinkError => { if (unlinkError?.code !== 'ENOENT') throw unlinkError })
      await rename(tempDest, dest)
    }
    await chmod(dest, 0o600)
  } catch (error) {
    await unlink(tempDest).catch(() => {})
    throw error
  }
  const backupSize = await stat(dest).then(info => info.size).catch(() => 0)
  console.log(`[db] 数据库已备份到: ${dest} (${backupSize} bytes)`)

  // 清理旧备份（保留最近 7 天）
  try {
    const files = await readdir(BACKUP_DIR)
    const backupFiles = files
      .filter(f => f.startsWith('knowledge-backup-') && f.endsWith('.db'))
      .sort()
      .reverse()
    for (let i = 7; i < backupFiles.length; i++) {
      await unlink(join(BACKUP_DIR, backupFiles[i]))
        .catch(() => {})
    }
  } catch { /* 清理失败不影响主流程 */ }

  return dest
}

// ===== 鉴定评估 CRUD =====

export function getEvalDb() {
  if (!db) throw new Error('DB not initialized')
  return db
}

export function getAllEvals() {
  if (!db) return []
  const rows = db.prepare('SELECT * FROM evaluations ORDER BY id').all()
  return rows.map(r => ({ ...r, created_at: r.created_at, updated_at: r.updated_at }))
}

export function createEvalBatch(caseList) {
  if (!db) return []
  // 过滤掉已存在的 case_id
  const existing = new Set(db.prepare('SELECT case_id FROM evaluations').all().map(r => r.case_id))
  const newcomers = caseList.filter(c => !existing.has(c.case_id))
  if (newcomers.length === 0) return []

  const insert = db.prepare(`INSERT OR IGNORE INTO evaluations
    (case_id, case_title, image_name, analyzed)
    VALUES (?, ?, ?, 0)`)
  const results = []
  const tx = db.transaction((items) => {
    for (const c of items) {
      const info = insert.run(c.case_id, c.case_title, c.image_name || '')
      results.push({ id: info.lastInsertRowid, case_id: c.case_id, case_title: c.case_title })
    }
  })
  tx(newcomers)
  return results
}

export function saveEvalAnnotation(id, data) {
  if (!db) return null
  const sets = []
  const vals = []
  const fields = ['location', 'shape', 'stage', 'conclusion', 'status_obs', 'principle']
  // 先归一化人工值（location/shape/stage/conclusion），自由文本（status_obs/principle）保持原样
  const normed = {}
  for (const f of fields) {
    if (data['human_' + f] !== undefined) {
      const raw = data['human_' + f] || ''
      normed[f] = (f === 'status_obs' || f === 'principle') ? raw : normalizeEvalField(f, raw)
    }
  }
  for (const f of fields) {
    if (data['match_' + f] !== undefined) {
      sets.push(`match_${f} = ?`)
      vals.push(data['match_' + f] != null ? (data['match_' + f] ? 1 : 0) : -1)
    }
    if (data['human_' + f] !== undefined) {
      sets.push(`human_${f} = ?`)
      vals.push(normed[f])
    }
  }
  if (data.judged_by !== undefined) {
    sets.push('judged_by = ?')
    vals.push(data.judged_by || '')
  }
  sets.push("updated_at = datetime('now')")

  // 自动计算 RAG 匹配度：对比归一化后的 human 值与 rag 值
  const rec = db.prepare('SELECT rag_location, rag_shape FROM evaluations WHERE id = ?').get(id)
  if (rec && data.human_location !== undefined) {
    sets.push('match_rag_location = ?')
    vals.push((rec.rag_location && normed.location && rec.rag_location === normed.location) ? 1 : 0)
  }
  if (rec && data.human_shape !== undefined) {
    sets.push('match_rag_shape = ?')
    vals.push((rec.rag_shape && normed.shape && rec.rag_shape === normed.shape) ? 1 : 0)
  }

  vals.push(id)

  if (sets.length === 0) return { id, ...data }
  const stmt = db.prepare(`UPDATE evaluations SET ${sets.join(', ')} WHERE id = ?`)
  const result = stmt.run(...vals)
  return { id, ...data, changes: result.changes }
}

export function saveEvalLLMResult(id, result) {
  if (!db) return null
  const stmt = db.prepare(`UPDATE evaluations SET
    llm_location = ?, llm_shape = ?, llm_stage = ?, llm_conclusion = ?,
    llm_description = ?, llm_severity = ?, llm_status_obs = ?, llm_principle = ?,
    analyzed = 1, updated_at = datetime('now')
    WHERE id = ?`)
  stmt.run(
    result.llm_location || '', result.llm_shape || '', result.llm_stage || '',
    result.llm_conclusion || '', result.llm_description || '', result.llm_severity || '',
    result.llm_status_obs || '', result.llm_principle || '', id
  )
  return { id }
}

export function saveEvalRAGResult(id, result) {
  if (!db) return null
  const stmt = db.prepare(`UPDATE evaluations SET
    rag_location = ?, rag_shape = ?,
    updated_at = datetime('now')
    WHERE id = ?`)
  stmt.run(
    result.rag_location || '', result.rag_shape || '', id
  )
  return { id }
}

export function getEvalStats() {
  const defaults = { total: 0, location: { ok: 0, fail: 0 }, shape: { ok: 0, fail: 0 }, stage: { ok: 0, fail: 0 }, conclusion: { ok: 0, fail: 0 }, status_obs: { ok: 0, fail: 0 }, principle: { ok: 0, fail: 0 } }
  if (!db) return { total: 0, llm: defaults, rag: defaults }
  const total = db.prepare('SELECT COUNT(*) as c FROM evaluations').get().c
  const pick = (arr) => { let ok = 0, fail = 0; arr.forEach(r => { if (r.v === 1) ok = r.c; else fail = r.c }); return { ok, fail } }

  // LLM 准确率
  const llm = { total, ...defaults }
  const llmFields = ['location', 'shape', 'stage', 'conclusion', 'status_obs', 'principle']
  for (const f of llmFields) {
    const rows = db.prepare(`SELECT match_${f} as v, COUNT(*) as c FROM evaluations WHERE match_${f} >= 0 GROUP BY match_${f}`).all()
    llm[f] = pick(rows)
  }

  // RAG 准确率（仅有 location 和 shape 两个维度）
  const rag = { total, ...defaults }
  for (const f of ['location', 'shape']) {
    const rows = db.prepare(`SELECT match_rag_${f} as v, COUNT(*) as c FROM evaluations WHERE match_rag_${f} >= 0 GROUP BY match_rag_${f}`).all()
    rag[f] = pick(rows)
  }

  return { total, llm, rag }
}

export function deleteAllEvals() {
  if (!db) return
  db.prepare('DELETE FROM evaluations').run()
  // 重置自增计数器，避免 id 无限增长
  db.prepare("DELETE FROM sqlite_sequence WHERE name='evaluations'").run()
}

export function deleteEvalsByIds(ids) {
  if (!db || !Array.isArray(ids) || ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(`DELETE FROM evaluations WHERE id IN (${placeholders})`).run(...ids).changes
}

// ===== 在线判定反馈（四态：unconfirmed / confirmed_correct / reported_incorrect / expert_verified）=====
// 说明：用户反馈、专家复核、最终申诉分表记录，互不覆盖。
//  - feedback      用户反馈（unconfirmed / confirmed_correct / reported_incorrect）
//  - expert_review 专家抽检复核（expert_verified / expert_rejected）
//  - appeal        最终申诉结果

export function saveFeedback(data) {
  if (!db) throw new Error('DB not initialized')
  const capabilityToken = crypto.randomBytes(32).toString('base64url')
  const capabilityHash = crypto.createHash('sha256').update(capabilityToken).digest('hex')
  const info = db.prepare(`INSERT INTO feedback (case_id, conclusion, status, remark, source, capability_hash)
    VALUES (@case_id, @conclusion, 'unconfirmed', @remark, 'h5', @capability_hash)`).run({
    case_id: data.caseId || '',
    conclusion: data.conclusion || '',
    remark: data.remark || '',
    capability_hash: capabilityHash,
  })
  return { id: Number(info.lastInsertRowid), capabilityToken, ...getFeedbackStats() }
}

function setFeedbackStatus(id, status, remark, capabilityToken) {
  if (!db) throw new Error('DB not initialized')
  if (!id) throw new Error('缺少反馈记录 id')
  if (typeof capabilityToken !== 'string' || capabilityToken.length < 32 || capabilityToken.length > 128) {
    throw new Error('缺少有效的反馈凭证')
  }
  const allowed = ['confirmed_correct', 'reported_incorrect']
  if (!allowed.includes(status)) throw new Error('无效的反馈状态: ' + status)
  const capabilityHash = crypto.createHash('sha256').update(capabilityToken).digest('hex')
  const info = db.prepare(`UPDATE feedback SET status = @status, remark = @remark
    WHERE id = @id AND capability_hash = @capability_hash AND status = 'unconfirmed'`).run({
    id,
    status,
    remark: remark || '',
    capability_hash: capabilityHash,
  })
  return { updated: info.changes, ...getFeedbackStats() }
}

export function reportFeedback(id, remark, capabilityToken) {
  return setFeedbackStatus(id, 'reported_incorrect', remark, capabilityToken)
}

export function confirmFeedback(id, capabilityToken) {
  return setFeedbackStatus(id, 'confirmed_correct', '', capabilityToken)
}

export function getFeedbackStats() {
  if (!db) return { unconfirmed: 0, confirmed_correct: 0, reported_incorrect: 0, total: 0, reportRate: 0, unreportRate: 0 }
  const count = (status) => db.prepare("SELECT COUNT(*) as c FROM feedback WHERE status = ? AND process_status = 'completed'").get(status).c
  const unconfirmed = count('unconfirmed')
  const confirmed_correct = count('confirmed_correct')
  const reported_incorrect = count('reported_incorrect')
  const total = unconfirmed + confirmed_correct + reported_incorrect
  // 用户主动报错率 = 主动报错次数 / 完成判定次数；未报错率 = 1 - 主动报错率
  const reportRate = total > 0 ? Math.round((reported_incorrect / total) * 1000) / 10 : 0
  const unreportRate = total > 0 ? Math.round(((total - reported_incorrect) / total) * 1000) / 10 : 0
  return { unconfirmed, confirmed_correct, reported_incorrect, total, reportRate, unreportRate }
}

export function getExpertReviewStats() {
  if (!db) return { total: 0, expert_verified: 0, expert_rejected: 0 }
  const total = db.prepare('SELECT COUNT(*) as c FROM expert_review').get().c
  const expert_verified = db.prepare("SELECT COUNT(*) as c FROM expert_review WHERE verdict = 'expert_verified'").get().c
  const expert_rejected = db.prepare("SELECT COUNT(*) as c FROM expert_review WHERE verdict = 'expert_rejected'").get().c
  return { total, expert_verified, expert_rejected }
}

export function getAppealStats() {
  if (!db) return { total: 0 }
  const total = db.prepare('SELECT COUNT(*) as c FROM appeal').get().c
  return { total }
}

// ===== 集中式字段定义 =====
const FIELD_DEFS_PATH = join(DATA_DIR, 'field-defs.json')
let _cachedFieldDefs = null

export function loadFieldDefsSync() {
  if (_cachedFieldDefs) return _cachedFieldDefs
  try {
    const raw = readFileSync(FIELD_DEFS_PATH, 'utf8')
    _cachedFieldDefs = JSON.parse(raw).fields || {}
    return _cachedFieldDefs
  } catch (e) {
    console.warn('[db] 加载 field-defs.json 失败:', e.message)
    return {}
  }
}

export async function loadFieldDefs() {
  if (_cachedFieldDefs) return _cachedFieldDefs
  try {
    const raw = await readFile(FIELD_DEFS_PATH, 'utf8')
    _cachedFieldDefs = JSON.parse(raw).fields || {}
    return _cachedFieldDefs
  } catch (e) {
    console.error('[db] 加载 field-defs.json 失败:', e.message)
    return {}
  }
}
