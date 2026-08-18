import Database from 'better-sqlite3'
import { readFile, mkdir, access } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeEvalField } from './field-normalize.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', 'data')
const BACKUP_DIR = join(DATA_DIR, 'backup')
const DB_PATH = join(DATA_DIR, 'knowledge.db')
const CASES_FILE = join(DATA_DIR, 'cases.json')
const TRAINING_FILE = join(DATA_DIR, 'training.json')

let db = null

async function ensureDir(dir) {
  try { await access(dir) } catch { await mkdir(dir, { recursive: true }) }
}

export function getDb() {
  if (!db) throw new Error('DB not initialized. Call initDb() first.')
  return db
}

export async function initDb() {
  await ensureDir(DATA_DIR)
  await ensureDir(BACKUP_DIR)

  db = new Database(DB_PATH)

  // 开启 WAL 模式，读写并发性能更好
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

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
      feedback TEXT NOT NULL,
      remark TEXT DEFAULT '',
      source TEXT DEFAULT 'h5',
      created_at TEXT DEFAULT (datetime('now'))
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

  // 预编译常用语句
  const stmts = {
    // cases CRUD
    allCases: db.prepare('SELECT * FROM cases ORDER BY created_at DESC'),
    approvedCases: db.prepare("SELECT * FROM cases WHERE review_status = 'approved' ORDER BY created_at DESC"),
    caseById: db.prepare('SELECT * FROM cases WHERE id = ?'),
    insertPending: db.prepare(`INSERT INTO pending_cases (
      title, deviceModel, statusObs, crackLocation, crackShape, crackPrinciple,
      crackStage, result, remark, imageBase64, source
    ) VALUES (
      @title, @deviceModel, @statusObs, @crackLocation, @crackShape, @crackPrinciple,
      @crackStage, @result, @remark, @imageBase64, @source
    )`),
    pendingAll: db.prepare('SELECT * FROM pending_cases ORDER BY created_at DESC'),
    pendingById: db.prepare('SELECT * FROM pending_cases WHERE id = ?'),
    pendingUpdateStatus: db.prepare(`UPDATE pending_cases SET status = ?, reviewed_by = ?, review_remark = ?, reviewed_at = datetime('now') WHERE id = ?`),
    pendingCount: db.prepare('SELECT COUNT(*) as total FROM pending_cases WHERE status = ?'),
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
      source, imageBase64, remark
    ) VALUES (
      @features, @statusObs, @location, @shape, @principle, @stage, @conclusion,
      @caseId, @originalStatusObs, @originalLocation, @originalShape, @originalPrinciple, @originalStage, @originalConclusion,
      @source, @imageBase64, @remark
    )`),
    countTraining: db.prepare('SELECT COUNT(*) as total FROM training'),
  }

  return stmts
}

/**
 * 从旧的 cases.json 迁移数据到 SQLite
 */
export async function migrateFromJson(stmts) {
  let migrated = 0
  // 先检查是否已有数据
  if (stmts.countCases.get().total > 0) {
    console.log('[db] SQLite 已有数据，跳过迁移')
    return 0
  }

  // 迁移 cases.json
  try {
    const raw = await readFile(CASES_FILE, 'utf-8')
    const cases = JSON.parse(raw)
    if (Array.isArray(cases) && cases.length > 0) {
      const insertMany = db.transaction((items) => {
        for (const c of items) {
          stmts.insertCase.run(serializeCase(c))
        }
      })
      insertMany(cases)
      migrated += cases.length
      console.log(`[db] 已从 cases.json 迁移 ${cases.length} 条案例`)
    }
  } catch {
    console.log('[db] cases.json 不存在或为空，跳过')
  }

  // 迁移 training.json
  try {
    const raw = await readFile(TRAINING_FILE, 'utf-8')
    const training = JSON.parse(raw)
    if (Array.isArray(training) && training.length > 0) {
      const insertMany = db.transaction((items) => {
        for (const t of items) {
          stmts.insertTraining.run(serializeTraining(t))
        }
      })
      insertMany(training)
      migrated += training.length
      console.log(`[db] 已从 training.json 迁移 ${training.length} 条训练数据`)
    }
  } catch {
    console.log('[db] training.json 不存在或为空，跳过')
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
  const { copyFile, unlink } = await import('node:fs/promises')

  // 先 checkpoint 回收 WAL 空间
  checkpointWal()

  // 删除已有备份文件（VACUUM INTO 不覆盖）
  try { await unlink(dest) } catch { /* 不存在则忽略 */ }

  // VACUUM INTO 到备份文件（参数由内部生成，安全可靠）
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
  console.log(`[db] 数据库已备份到: ${dest} (${(await import('node:fs/promises')).stat(dest).then(s => s.size).catch(() => 0)} bytes)`)

  // 清理旧备份（保留最近 7 天）
  try {
    const { readdir, unlink } = await import('node:fs/promises')
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

// ===== 在线判定正确率反馈 =====

export function saveFeedback(data) {
  if (!db) throw new Error('DB not initialized')
  const info = db.prepare(`INSERT INTO feedback (case_id, conclusion, feedback, remark, source)
    VALUES (@case_id, @conclusion, @feedback, @remark, @source)`).run({
    case_id: data.caseId || '',
    conclusion: data.conclusion || '',
    feedback: data.feedback,
    remark: data.remark || '',
    source: data.source || 'h5',
  })
  return { id: Number(info.lastInsertRowid), ...getFeedbackStats() }
}

export function reportFeedback(id, remark) {
  if (!db) throw new Error('DB not initialized')
  if (!id) throw new Error('缺少反馈记录 id')
  const info = db.prepare("UPDATE feedback SET feedback = 'incorrect', remark = @remark WHERE id = @id").run({ id, remark: remark || '' })
  return { updated: info.changes, ...getFeedbackStats() }
}

export function getFeedbackStats() {
  if (!db) return { correct: 0, incorrect: 0, total: 0, accuracy: 0 }
  const correct = db.prepare("SELECT COUNT(*) as c FROM feedback WHERE feedback = 'correct'").get().c
  const incorrect = db.prepare("SELECT COUNT(*) as c FROM feedback WHERE feedback = 'incorrect'").get().c
  const total = correct + incorrect
  const accuracy = total > 0 ? Math.round((correct / total) * 1000) / 10 : 0
  return { correct, incorrect, total, accuracy }
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