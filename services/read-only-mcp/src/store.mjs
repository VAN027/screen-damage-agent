import Database from 'better-sqlite3'
import { resolve } from 'node:path'

const DEFAULT_DB_PATH = resolve(process.env.KNOWLEDGE_DB_PATH || new URL('../../knowledge-ai/data/knowledge.db', import.meta.url).pathname)
const MAX_LIMIT = 100

function boundedPage(input = {}) {
  const limit = Math.min(Math.max(Number.parseInt(input.limit, 10) || 20, 1), MAX_LIMIT)
  const offset = Math.min(Math.max(Number.parseInt(input.offset, 10) || 0, 0), 1_000_000)
  return { limit, offset }
}

function dateBoundary(value, endOfDay = false) {
  if (!value) return ''
  const text = String(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new Error('日期必须使用 YYYY-MM-DD 格式')
  }
  return `${text} ${endOfDay ? '23:59:59' : '00:00:00'}`
}

function addDateRange(clauses, params, column, from, to) {
  const start = dateBoundary(from)
  const end = dateBoundary(to, true)
  if (start) { clauses.push(`${column} >= ?`); params.push(start) }
  if (end) { clauses.push(`${column} <= ?`); params.push(end) }
}

function addKeyword(clauses, params, keyword, columns) {
  const text = String(keyword || '').trim()
  if (!text) return
  const pattern = `%${text}%`
  clauses.push(`(${columns.map(column => `${column} LIKE ?`).join(' OR ')})`)
  params.push(...columns.map(() => pattern))
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}

function pageQuery(db, { select, from, clauses, params, orderBy, limit, offset, mapRow = row => row }) {
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) AS total FROM ${from} ${where}`).get(...params).total
  const rows = db.prepare(`SELECT ${select} FROM ${from} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset).map(mapRow)
  return { rows, total, limit, offset }
}

function grouped(db, sql, params = []) {
  return Object.fromEntries(db.prepare(sql).all(...params).map(row => [String(row.label || '未填写'), Number(row.total) || 0]))
}

function accuracy(row, prefix) {
  const judged = Number(row[`${prefix}_judged`]) || 0
  const matched = Number(row[`${prefix}_matched`]) || 0
  return { judged, matched, rate: judged ? Number((matched / judged).toFixed(4)) : null }
}

export class ReadOnlyKnowledgeStore {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.dbPath = resolve(dbPath)
    this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true })
    this.db.pragma('query_only = ON')
    this.db.pragma('trusted_schema = OFF')
    this.db.pragma('busy_timeout = 5000')
  }

  close() {
    if (this.db?.open) this.db.close()
  }

  queryAssessments(input = {}) {
    const { limit, offset } = boundedPage(input)
    const clauses = []
    const params = []
    if (input.id !== undefined) { clauses.push('id = ?'); params.push(Number(input.id)) }
    if (input.submissionId) { clauses.push('submission_id = ?'); params.push(String(input.submissionId)) }
    if (input.processStatus) { clauses.push('process_status = ?'); params.push(String(input.processStatus)) }
    if (input.feedbackStatus) { clauses.push('status = ?'); params.push(String(input.feedbackStatus)) }
    addKeyword(clauses, params, input.keyword, ['submission_id', 'case_id', 'conclusion', 'final_result', 'remark'])
    addDateRange(clauses, params, 'created_at', input.dateFrom, input.dateTo)
    return pageQuery(this.db, {
      select: `id, submission_id, case_id, conclusion, status, remark, source, process_status,
        install_status, auth_personnel, package_damage, fault_links, analysis_mode,
        llm_conclusion, final_result, image_count, error_message, created_at, updated_at, completed_at`,
      from: 'feedback', clauses, params, orderBy: 'created_at DESC, id DESC', limit, offset,
      mapRow: row => ({ ...row, fault_links: parseJson(row.fault_links, []) }),
    })
  }

  queryCorrectionReviews(input = {}) {
    const { limit, offset } = boundedPage(input)
    const clauses = []
    const params = []
    if (input.id !== undefined) { clauses.push('id = ?'); params.push(Number(input.id)) }
    if (input.status) { clauses.push('status = ?'); params.push(String(input.status)) }
    addKeyword(clauses, params, input.keyword, ['title', 'deviceModel', 'source_case_id', 'result', 'remark'])
    addDateRange(clauses, params, 'created_at', input.dateFrom, input.dateTo)
    return pageQuery(this.db, {
      select: `id, feedback_id, source_case_id, title, deviceModel, statusObs, crackLocation,
        crackShape, crackPrinciple, crackStage, result, remark, source, status, reviewed_by,
        review_remark, approved_case_id, created_at, reviewed_at, image_archived_at,
        image_expires_at, image_deleted_at,
        CASE
          WHEN image_path <> '' THEN 'disk'
          WHEN imageBase64 <> '' THEN 'database-temporary'
          WHEN image_deleted_at <> '' THEN 'expired-and-deleted'
          ELSE 'unavailable'
        END AS image_storage`,
      from: 'pending_cases', clauses, params, orderBy: 'created_at DESC, id DESC', limit, offset,
    })
  }

  queryCases(input = {}) {
    const { limit, offset } = boundedPage(input)
    const clauses = []
    const params = []
    if (input.id) { clauses.push('id = ?'); params.push(String(input.id)) }
    if (input.result) { clauses.push('result = ?'); params.push(String(input.result)) }
    if (input.reviewStatus) { clauses.push('review_status = ?'); params.push(String(input.reviewStatus)) }
    addKeyword(clauses, params, input.keyword, ['id', 'title', 'deviceModel', 'summary', 'remark'])
    addDateRange(clauses, params, 'created_at', input.dateFrom, input.dateTo)
    return pageQuery(this.db, {
      select: `id, title, deviceModel, symptoms, crackShape, crackLocation, crackPrinciple,
        physicalFeature, liquidState, installStatus, packageDamage, crackStage, result,
        resultLabel, confidence, summary, tags, possibleCause, warrantyTip, remark,
        needsReview, review_status, created_at, updated_at`,
      from: 'cases', clauses, params, orderBy: 'created_at DESC, id DESC', limit, offset,
      mapRow: row => ({ ...row, symptoms: parseJson(row.symptoms, []), tags: parseJson(row.tags, []) }),
    })
  }

  queryEvaluations(input = {}) {
    const { limit, offset } = boundedPage(input)
    const clauses = []
    const params = []
    if (input.id !== undefined) { clauses.push('id = ?'); params.push(Number(input.id)) }
    if (input.caseId) { clauses.push('case_id = ?'); params.push(String(input.caseId)) }
    if (input.analyzed !== undefined) { clauses.push('analyzed = ?'); params.push(input.analyzed ? 1 : 0) }
    addKeyword(clauses, params, input.keyword, ['case_id', 'case_title', 'image_name', 'llm_conclusion', 'human_conclusion'])
    addDateRange(clauses, params, 'created_at', input.dateFrom, input.dateTo)
    return pageQuery(this.db, {
      select: `id, case_id, case_title, image_name, llm_location, llm_shape, llm_stage,
        llm_conclusion, llm_description, llm_severity, llm_status_obs, llm_principle,
        rag_location, rag_shape, human_location, human_shape, human_stage, human_conclusion,
        human_status_obs, human_principle, match_location, match_shape, match_stage,
        match_conclusion, match_status_obs, match_principle, match_rag_location,
        match_rag_shape, analyzed, judged_by, created_at, updated_at`,
      from: 'evaluations', clauses, params, orderBy: 'created_at DESC, id DESC', limit, offset,
    })
  }

  getStatistics(scope = 'overview') {
    if (scope === 'assessments') {
      return {
        total: this.db.prepare('SELECT COUNT(*) AS total FROM feedback').get().total,
        byProcessStatus: grouped(this.db, `SELECT process_status AS label, COUNT(*) AS total FROM feedback GROUP BY process_status`),
        byFeedbackStatus: grouped(this.db, `SELECT status AS label, COUNT(*) AS total FROM feedback GROUP BY status`),
        withImages: this.db.prepare('SELECT COUNT(*) AS total FROM feedback WHERE image_count > 0').get().total,
        imageRows: this.db.prepare('SELECT COUNT(*) AS total FROM feedback_images').get().total,
      }
    }
    if (scope === 'corrections') {
      return {
        total: this.db.prepare('SELECT COUNT(*) AS total FROM pending_cases').get().total,
        byStatus: grouped(this.db, `SELECT status AS label, COUNT(*) AS total FROM pending_cases GROUP BY status`),
        imageStorage: grouped(this.db, `SELECT CASE
            WHEN image_path <> '' THEN 'disk'
            WHEN imageBase64 <> '' THEN 'database-temporary'
            WHEN image_deleted_at <> '' THEN 'expired-and-deleted'
            ELSE 'unavailable'
          END AS label, COUNT(*) AS total FROM pending_cases GROUP BY label`),
      }
    }
    if (scope === 'cases') {
      return {
        total: this.db.prepare('SELECT COUNT(*) AS total FROM cases').get().total,
        byResult: grouped(this.db, `SELECT result AS label, COUNT(*) AS total FROM cases GROUP BY result`),
        byReviewStatus: grouped(this.db, `SELECT review_status AS label, COUNT(*) AS total FROM cases GROUP BY review_status`),
      }
    }
    if (scope === 'evaluations') {
      const row = this.db.prepare(`SELECT COUNT(*) AS total,
          SUM(CASE WHEN analyzed = 1 THEN 1 ELSE 0 END) AS analyzed,
          SUM(CASE WHEN match_location IN (0,1) THEN 1 ELSE 0 END) AS location_judged,
          SUM(CASE WHEN match_location = 1 THEN 1 ELSE 0 END) AS location_matched,
          SUM(CASE WHEN match_shape IN (0,1) THEN 1 ELSE 0 END) AS shape_judged,
          SUM(CASE WHEN match_shape = 1 THEN 1 ELSE 0 END) AS shape_matched,
          SUM(CASE WHEN match_conclusion IN (0,1) THEN 1 ELSE 0 END) AS conclusion_judged,
          SUM(CASE WHEN match_conclusion = 1 THEN 1 ELSE 0 END) AS conclusion_matched
        FROM evaluations`).get()
      return {
        total: Number(row.total) || 0,
        analyzed: Number(row.analyzed) || 0,
        accuracy: {
          location: accuracy(row, 'location'),
          shape: accuracy(row, 'shape'),
          conclusion: accuracy(row, 'conclusion'),
        },
      }
    }
    if (scope !== 'overview') throw new Error('不支持的统计范围')
    const counts = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM cases) AS cases,
      (SELECT COUNT(*) FROM feedback) AS assessments,
      (SELECT COUNT(*) FROM feedback_images) AS assessmentImages,
      (SELECT COUNT(*) FROM pending_cases) AS correctionReviews,
      (SELECT COUNT(*) FROM training) AS trainingSamples,
      (SELECT COUNT(*) FROM evaluations) AS evaluations,
      (SELECT COUNT(*) FROM expert_review) AS expertReviews,
      (SELECT COUNT(*) FROM appeal) AS appeals`).get()
    return {
      counts,
      assessmentProcessStatus: grouped(this.db, `SELECT process_status AS label, COUNT(*) AS total FROM feedback GROUP BY process_status`),
      correctionStatus: grouped(this.db, `SELECT status AS label, COUNT(*) AS total FROM pending_cases GROUP BY status`),
      caseResults: grouped(this.db, `SELECT result AS label, COUNT(*) AS total FROM cases GROUP BY result`),
    }
  }
}

export function createReadOnlyKnowledgeStore(dbPath = DEFAULT_DB_PATH) {
  return new ReadOnlyKnowledgeStore(dbPath)
}
