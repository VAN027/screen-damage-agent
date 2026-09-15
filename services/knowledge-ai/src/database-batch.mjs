import { getDb, removePendingCaseImageFiles } from './db.mjs'
import { batchDeleteCases, deleteCase, getCaseById } from './search-engine.mjs'
import { deleteFeedbackRecords } from './assessment-records.mjs'

const TABLES = {
  cases: { key: 'id', type: 'text' },
  pending_cases: { key: 'id', type: 'integer' },
  training: { key: 'id', type: 'integer' },
  evaluations: { key: 'id', type: 'integer' },
  feedback: { key: 'id', type: 'integer' },
  feedback_images: { key: 'id', type: 'integer' },
  expert_review: { key: 'id', type: 'integer' },
  appeal: { key: 'id', type: 'integer' },
  schema_migrations: { key: 'name', type: 'text' },
}

function fail(statusCode, code, message) {
  throw Object.assign(new Error(message), { statusCode, code, expose: true })
}

function request(tableValue, keyValues) {
  const table = String(tableValue || '')
  const config = TABLES[table]
  if (!config) fail(400, 'INVALID_DATABASE_TABLE', '不支持批量操作该数据表')
  if (!Array.isArray(keyValues) || keyValues.length === 0 || keyValues.length > 500) {
    fail(400, 'INVALID_DATABASE_KEYS', '请选择 1-500 条记录')
  }
  const keys = [...new Set(keyValues.map(value => config.type === 'integer' ? Number(value) : String(value || '').trim()))]
  if (keys.some(value => config.type === 'integer'
    ? !Number.isSafeInteger(value) || value <= 0
    : !value || value.length > 160)) {
    fail(400, 'INVALID_DATABASE_KEYS', '记录主键无效')
  }
  return { table, config, keys }
}

function selectedRows(db, table, config, keys) {
  const placeholders = keys.map(() => '?').join(',')
  return db.prepare(`SELECT * FROM "${table}" WHERE "${config.key}" IN (${placeholders})`).all(...keys)
}

function placeholders(values) {
  return values.map(() => '?').join(',')
}

function feedbackProtectedIds(db, feedbackIds) {
  if (!feedbackIds.length) return new Set()
  const rows = db.prepare(`SELECT f.id FROM feedback f
    WHERE f.id IN (${placeholders(feedbackIds)})
      AND (f.correction_pending_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM pending_cases p WHERE p.feedback_id = f.id
      ))`).all(...feedbackIds)
  return new Set(rows.map(row => Number(row.id)))
}

export function previewDatabaseBatch(tableValue, keyValues) {
  const { table, config, keys } = request(tableValue, keyValues)
  const db = getDb()
  const rows = selectedRows(db, table, config, keys)
  const foundKeys = rows.map(row => row[config.key])
  let protectedKeys = []
  let deleteKeys = foundKeys
  let relatedImages = 0
  let affectedRecords = rows.length
  let warning = ''

  if (table === 'schema_migrations') {
    protectedKeys = foundKeys
    deleteKeys = []
    warning = '数据库迁移记录受系统保护，删除后可能导致迁移重复执行。'
  } else if (table === 'feedback') {
    const protectedIds = feedbackProtectedIds(db, rows.map(row => Number(row.id)))
    protectedKeys = rows.filter(row => protectedIds.has(Number(row.id))).map(row => Number(row.id))
    deleteKeys = rows.filter(row => !protectedIds.has(Number(row.id))).map(row => Number(row.id))
    if (deleteKeys.length) relatedImages = db.prepare(`SELECT COUNT(*) AS count FROM feedback_images WHERE feedback_id IN (${placeholders(deleteKeys)})`).get(...deleteKeys).count
    warning = '将删除鉴定记录、图片索引及对应磁盘图片。'
  } else if (table === 'feedback_images') {
    const parentIds = [...new Set(rows.map(row => Number(row.feedback_id)).filter(Number.isSafeInteger))]
    const protectedIds = feedbackProtectedIds(db, parentIds)
    protectedKeys = rows.filter(row => protectedIds.has(Number(row.feedback_id))).map(row => Number(row.id))
    deleteKeys = rows.filter(row => !protectedIds.has(Number(row.feedback_id))).map(row => Number(row.id))
    const deletableParents = parentIds.filter(id => !protectedIds.has(id))
    affectedRecords = deletableParents.length
    if (deletableParents.length) relatedImages = db.prepare(`SELECT COUNT(*) AS count FROM feedback_images WHERE feedback_id IN (${placeholders(deletableParents)})`).get(...deletableParents).count
    warning = '选中的图片将按所属关系归并，并删除整条鉴定记录及其全部图片。'
  } else if (table === 'pending_cases') {
    protectedKeys = rows.filter(row => ['approving', 'approved'].includes(row.status)).map(row => Number(row.id))
    const protectedSet = new Set(protectedKeys)
    deleteKeys = rows.filter(row => !protectedSet.has(Number(row.id))).map(row => Number(row.id))
    relatedImages = deleteKeys.filter(id => rows.some(row => Number(row.id) === id && row.image_path)).length
    warning = '审核中和已通过的纠错记录受保护；其余记录删除时会解除反馈关联，并清理对应归档图片。'
  } else if (table === 'cases') {
    warning = '将同步删除案例图片和向量索引；其他表中的历史引用不会自动删除。'
  } else if (table === 'evaluations') {
    warning = '由评估页上传图片自动创建的案例将一并删除。'
  } else if (table === 'training') {
    warning = '训练样本删除后不会从已通过的审核记录中自动重建。'
  }

  return {
    table,
    requested: keys.length,
    found: rows.length,
    deletable: deleteKeys.length,
    protected: protectedKeys.length,
    protectedKeys,
    notFound: keys.length - rows.length,
    affectedRecords,
    relatedImages: Number(relatedImages) || 0,
    warning,
  }
}

export async function deleteDatabaseBatch(tableValue, keyValues) {
  const { table, config, keys } = request(tableValue, keyValues)
  const db = getDb()
  const preview = previewDatabaseBatch(table, keys)
  if (!preview.deletable) return { ...preview, deleted: 0 }
  const rows = selectedRows(db, table, config, keys)
  const protectedSet = new Set(preview.protectedKeys.map(String))
  const deletableRows = rows.filter(row => !protectedSet.has(String(row[config.key])))
  const deleteKeys = deletableRows.map(row => row[config.key])

  if (table === 'feedback') {
    const result = await deleteFeedbackRecords(deleteKeys)
    return { ...preview, ...result }
  }
  if (table === 'feedback_images') {
    const parentIds = [...new Set(deletableRows.map(row => Number(row.feedback_id)).filter(Number.isSafeInteger))]
    const result = await deleteFeedbackRecords(parentIds)
    return {
      ...preview,
      deleted: result.deleted,
      deletedImages: result.deletedImages,
      deletedSelectedImages: deleteKeys.length,
      skippedProtected: result.skippedProtected,
      fileErrors: result.fileErrors,
    }
  }
  if (table === 'cases') {
    const result = await batchDeleteCases(deleteKeys.map(String))
    return { ...preview, ...result }
  }
  if (table === 'evaluations') {
    let deletedCases = 0
    for (const row of deletableRows) {
      if (!row.case_id) continue
      try {
        const c = await getCaseById(row.case_id)
        if (c && typeof c.title === 'string' && c.title.startsWith('评估图片')) {
          const deletedCase = await deleteCase(c.id)
          if (deletedCase) deletedCases++
        }
      } catch {}
    }
    const deleted = db.prepare(`DELETE FROM evaluations WHERE id IN (${placeholders(deleteKeys)})`).run(...deleteKeys).changes
    return { ...preview, deleted, deletedCases }
  }
  if (table === 'pending_cases') {
    const imagePaths = deletableRows.map(row => row.image_path).filter(Boolean)
    const deleted = db.transaction(targetIds => {
      const marks = placeholders(targetIds)
      db.prepare(`UPDATE feedback SET correction_pending_id = NULL, correction_consumed_at = '' WHERE correction_pending_id IN (${marks})`).run(...targetIds)
      db.prepare(`DELETE FROM training WHERE source_pending_id IN (${marks})`).run(...targetIds)
      return db.prepare(`DELETE FROM pending_cases WHERE id IN (${marks})`).run(...targetIds).changes
    })(deleteKeys)
    const files = await removePendingCaseImageFiles(imagePaths)
    return { ...preview, deleted, deletedImages: files.deletedFiles, fileErrors: files.fileErrors }
  }

  const deleted = db.prepare(`DELETE FROM "${table}" WHERE "${config.key}" IN (${placeholders(deleteKeys)})`).run(...deleteKeys).changes
  return { ...preview, deleted }
}

export const DATABASE_BATCH_TABLES = Object.freeze(Object.keys(TABLES))
