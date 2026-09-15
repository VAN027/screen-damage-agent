import { writeFile, mkdir, access, readFile, unlink, chmod, readdir } from 'node:fs/promises'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import sharp from 'sharp'
import {
  searchByImage,
  indexCase as clipIndexCase,
  indexBatch as clipIndexBatch,
  deleteIndex as clipDeleteIndex,
  deleteIndexes as clipDeleteIndexes,
  rebuildIndex as clipRebuildIndex,
  clipHealth,
} from './clip-client.mjs'
import { normalizeTVImageBuffer } from './orientation-normalizer.mjs'
import {
  initDb,
  getDb,
  serializeCase,
  deserializeCase,
  serializeTraining,
  deserializeTraining,
  migrateFromJson,
  archivePendingCaseImage,
  readPendingCaseImageDataUrl,
} from './db.mjs'
import { normalizeEvalField } from './field-normalize.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = resolve(process.env.KNOWLEDGE_DATA_DIR || join(__dirname, '..', 'data'))
const IMAGES_DIR = join(DATA_DIR, 'images')
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_DATA_URL_CHARS = 8 * 1024 * 1024
const MAX_CORRECTION_IMAGE_DATA_URL_CHARS = 3 * 1024 * 1024
const MAX_PENDING_CASES = 2000
const MAX_PENDING_IMAGE_CHARS = 512 * 1024 * 1024
const SAFE_IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpe?g|png|gif|webp|bmp|avif)$/i
const ALLOWED_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'])
const CORRECTION_ENUMS = {
  location: new Set(['天侧', '地侧', '左侧', '右侧', '四角区域', '中央区域', '全屏区域', '局部不规则区域']),
  shape: new Set(['单条线状屏裂', '多条线状屏裂', '点放射状屏裂', '发散性线状屏裂', '环状/圈状屏裂', '网状(大面积无规则)屏裂', '漏液', '熔屏']),
  stage: new Set(['产品因素', '物流运输搬运', '拆机验机安装', '使用保管不当']),
  conclusion: new Set(['product_quality_issue', 'not_product_quality', 'no_damage']),
}

let stmts = null
let dbReady = false
let dbInitPromise = null

function correctionError(message, code = 'INVALID_CORRECTION', statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  error.expose = true
  return error
}

function imageSignatureMatches(mime, data) {
  if (mime === 'jpeg' || mime === 'jpg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
  if (mime === 'png') return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (mime === 'webp') return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP'
  if (mime === 'gif') return data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))
  if (mime === 'bmp') return data.length >= 2 && data.subarray(0, 2).toString('ascii') === 'BM'
  if (mime === 'avif') return data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp' && ['avif', 'avis'].includes(data.subarray(8, 12).toString('ascii'))
  return false
}

/** 严格校验图片 data URL 的语法、大小与文件签名，拒绝 SVG/属性注入及伪造 MIME。 */
export function isValidImageDataUrl(value, maxChars = MAX_IMAGE_DATA_URL_CHARS) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) return false
  const match = value.match(/^data:image\/(jpeg|jpg|png|webp|gif|bmp|avif);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/i)
  if (!match || !match[2]) return false
  try {
    const decoded = Buffer.from(match[2], 'base64')
    return decoded.length > 0 && decoded.length <= MAX_IMAGE_BYTES && imageSignatureMatches(match[1].toLowerCase(), decoded)
  } catch {
    return false
  }
}

function boundedCorrectionText(value, field, maxLength, { required = false } = {}) {
  if (value === undefined || value === null) value = ''
  if (typeof value !== 'string') throw correctionError(`${field} 必须是字符串`)
  const normalized = value.trim()
  if (required && !normalized) throw correctionError(`缺少必填字段 ${field}`)
  if (normalized.length > maxLength) throw correctionError(`${field} 超过 ${maxLength} 个字符上限`)
  return normalized
}

function canonicalCorrectionField(field, value, { required = false } = {}) {
  const raw = boundedCorrectionText(value, field, 100, { required })
  if (!raw) return ''
  const normalized = normalizeEvalField(field, raw)
  if (!CORRECTION_ENUMS[field]?.has(normalized)) throw correctionError(`${field} 不是允许的选项`)
  return normalized
}

/** 在持久化层再次清洗，避免未来新增调用方绕过 HTTP 路由校验。 */
export function validateCorrectionEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw correctionError('纠错数据必须是对象')
  const feedbackId = Number(entry.feedbackId)
  if (!Number.isSafeInteger(feedbackId) || feedbackId <= 0) {
    throw correctionError('缺少有效的反馈记录 id', 'INVALID_CORRECTION_CAPABILITY', 403)
  }
  if (typeof entry.capabilityToken !== 'string') {
    throw correctionError('缺少有效的纠错凭证', 'INVALID_CORRECTION_CAPABILITY', 403)
  }
  const capabilityToken = entry.capabilityToken.trim()
  if (capabilityToken.length < 32 || capabilityToken.length > 128) {
    throw correctionError('缺少有效的纠错凭证', 'INVALID_CORRECTION_CAPABILITY', 403)
  }
  const sanitized = {
    feedbackId,
    capabilityToken,
    caseId: boundedCorrectionText(entry.caseId, 'caseId', 128),
    originalStatusObs: boundedCorrectionText(entry.originalStatusObs, 'originalStatusObs', 500),
    originalLocation: boundedCorrectionText(entry.originalLocation, 'originalLocation', 100),
    originalShape: boundedCorrectionText(entry.originalShape, 'originalShape', 100),
    originalPrinciple: boundedCorrectionText(entry.originalPrinciple, 'originalPrinciple', 2000),
    originalStage: boundedCorrectionText(entry.originalStage, 'originalStage', 100),
    originalConclusion: boundedCorrectionText(entry.originalConclusion, 'originalConclusion', 100),
    correctedStatusObs: boundedCorrectionText(entry.correctedStatusObs, 'correctedStatusObs', 500),
    correctedLocation: canonicalCorrectionField('location', entry.correctedLocation, { required: true }),
    correctedShape: canonicalCorrectionField('shape', entry.correctedShape, { required: true }),
    correctedPrinciple: boundedCorrectionText(entry.correctedPrinciple, 'correctedPrinciple', 2000),
    correctedStage: canonicalCorrectionField('stage', entry.correctedStage),
    correctedConclusion: canonicalCorrectionField('conclusion', entry.correctedConclusion, { required: true }),
    remark: boundedCorrectionText(entry.remark, 'remark', 2000, { required: true }),
    imageBase64: boundedCorrectionText(entry.imageBase64, 'imageBase64', MAX_CORRECTION_IMAGE_DATA_URL_CHARS, { required: true }),
  }
  if (!isValidImageDataUrl(sanitized.imageBase64, MAX_CORRECTION_IMAGE_DATA_URL_CHARS)) {
    throw correctionError('imageBase64 不是受支持的图片或超过大小限制')
  }
  return sanitized
}

async function ensureStmts() {
  if (dbReady) return
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      const initialized = await initDb()
      await migrateFromJson(initialized)
      stmts = initialized
      await ensureDir(IMAGES_DIR)
      await chmod(IMAGES_DIR, 0o700)
      for (const name of await readdir(IMAGES_DIR)) {
        if (SAFE_IMAGE_NAME.test(name)) await chmod(join(IMAGES_DIR, name), 0o600)
      }
      dbReady = true

      // 审批的 SQLite 收口是一个事务。若进程在事务前（例如图片落盘后）退出，
      // 启动时必须重走完整审批，不能只因正式案例存在就跳过训练和原案例 corrections。
      for (const pending of initialized.pendingAll.all().filter(row => row.status === 'approving')) {
        try {
          await approvePendingCase(pending.id, pending.reviewed_by || '', pending.review_remark || '')
        } catch (error) {
          const caseId = pending.approved_case_id || `case-review-${pending.id}`
          if (!initialized.caseById.get(caseId)) {
            initialized.pendingResetApproval.run(pending.id, pending.approved_case_id || '')
          }
          console.warn(`[review] 待审案例 ${pending.id} 的审批恢复失败: ${error.message}`)
        }
      }
    })().catch(error => {
      dbInitPromise = null
      throw error
    })
  }
  await dbInitPromise
}

/** 启动就绪屏障：完成数据库迁移、审核恢复和图片目录权限收敛后才监听端口。 */
export async function initializeSearchEngine() {
  await ensureStmts()
}

async function ensureDir(dir) {
  try { await access(dir) } catch { await mkdir(dir, { recursive: true }) }
}

// 向后兼容：从案例对象读取图片列表
export function getCaseImages(c) {
  if (c.images && Array.isArray(c.images)) return c.images
  if (c.image) return [c.image]
  return []
}

// EXIF 自动旋转：根据照片中的 Orientation 标签纠正图片方向
async function autoOrientImage(buf) {
  try {
    const meta = await sharp(buf).metadata()
    // sharp 的 rotate() 会根据 EXIF orientation 自动旋转，之后剥离 EXIF 避免重复旋转
    if (meta.orientation && meta.orientation > 1) {
      return await sharp(buf).rotate().toBuffer()
    }
  } catch (_) { /* 非标准图片格式则跳过 */ }
  return buf
}

export async function saveImage(id, base64DataUrl) {
  const filenames = await saveImages(id, [base64DataUrl])
  return filenames[0] || ''
}

export async function saveImages(caseId, dataUrls) {
  await ensureDir(IMAGES_DIR)
  if (!dataUrls || !Array.isArray(dataUrls)) return []
  const filenames = []
  for (let i = 0; i < dataUrls.length; i++) {
    const dataUrl = dataUrls[i]
    if (!dataUrl || !dataUrl.startsWith('data:image/')) continue
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
    if (!match) continue
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
    if (!ALLOWED_IMAGE_EXTENSIONS.has(ext.toLowerCase())) continue
    let data = Buffer.from(match[2], 'base64')
    if (data.length > MAX_IMAGE_BYTES) continue

    // 复用常驻方向服务；案例导入没有交互界面，只在证据达到自动阈值时改写。
    try {
      const normalized = await normalizeTVImageBuffer(data, { allowModel: false, useOcr: true })
      if (normalized.orientation.requiresConfirmation) {
        console.warn(`[orientation] 案例 ${caseId} 第 ${i + 1} 张图片方向未自动改写: ${normalized.orientation.reason}`)
        data = await autoOrientImage(data)
      } else {
        data = normalized.buffer
      }
    } catch (error) {
      // 兼容历史导入中的非标准图片；方向失败被记录，但不改变原有落盘语义。
      console.warn(`[orientation] 案例 ${caseId} 第 ${i + 1} 张图片预处理失败: ${error.message}`)
      data = await autoOrientImage(data)
    }
    const suffix = i > 0 ? `_${i}` : ''
    const filename = `${caseId}${suffix}.${ext}`
    const filepath = getImagePath(filename)
    await writeFile(filepath, data, { mode: 0o600 })
    await chmod(filepath, 0o600)
    filenames.push(filename)
  }
  return filenames
}

export function getImagePath(filename) {
  if (typeof filename !== 'string' || !SAFE_IMAGE_NAME.test(filename) || basename(filename) !== filename) {
    throw new Error('无效的图片文件名')
  }
  const imageRoot = resolve(IMAGES_DIR) + sep
  const filepath = resolve(IMAGES_DIR, filename)
  if (!filepath.startsWith(imageRoot)) throw new Error('图片路径越界')
  return filepath
}

const IMAGE_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
}

async function readImageDataUrl(filename) {
  const filepath = getImagePath(filename)
  const data = await readFile(filepath)
  const ext = filename.split('.').pop().toLowerCase()
  return `data:${IMAGE_MIME[ext] || 'image/jpeg'};base64,${data.toString('base64')}`
}

async function removeImageFiles(filenames) {
  const removed = []
  const errors = []
  for (const filename of new Set((filenames || []).filter(Boolean))) {
    try {
      await unlink(getImagePath(filename))
      removed.push(filename)
    } catch (error) {
      if (error?.code !== 'ENOENT') errors.push({ filename, error: error.message })
    }
  }
  return { removed: removed.length, files: removed, errors }
}

// ========== 训练数据 ==========

export async function loadTraining() {
  await ensureStmts()
  return stmts.allTraining.all().map(deserializeTraining)
}

export async function addTraining(entry) {
  await ensureStmts()
  stmts.insertTraining.run(serializeTraining({
    features: entry.features,
    statusObs: entry.statusObs,
    location: entry.location,
    shape: entry.shape,
    principle: entry.principle,
    stage: entry.stage,
    conclusion: entry.conclusion,
    caseId: entry.caseId || '',
    originalStatusObs: entry.originalStatusObs || '',
    originalLocation: entry.originalLocation || '',
    originalShape: entry.originalShape || '',
    originalPrinciple: entry.originalPrinciple || '',
    originalStage: entry.originalStage || '',
    originalConclusion: entry.originalConclusion || '',
    source: entry.source || 'manual',
    imageBase64: entry.imageBase64 || '',
    remark: entry.remark || '',
  }))
  return stmts.countTraining.get().total
}

export async function getTrainingStats() {
  await ensureStmts()
  const data = stmts.allTraining.all().map(deserializeTraining)
  const locations = {}, shapes = {}
  for (const e of data) {
    locations[e.location] = (locations[e.location] || 0) + 1
    shapes[e.shape] = (shapes[e.shape] || 0) + 1
  }
  return { total: data.length, locations, shapes }
}

// ========== 标签匹配 ==========

const FEATURE_WEIGHTS = {
  symptoms: 0.30, crackShape: 0.18, physicalFeature: 0.18,
  liquidState: 0.15, installStatus: 0.10, result: 0.09,
}

function arrayOverlap(a, b) {
  const left = comparableValues(a)
  const right = comparableValues(b)
  if (left.length === 0 || right.length === 0) return 0
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  let matches = 0
  for (const value of leftSet) if (rightSet.has(value)) matches++
  return matches / Math.max(leftSet.size, rightSet.size, 1)
}

function comparableValues(value) {
  const values = Array.isArray(value) ? value.flat(Infinity) : [value]
  return values
    .map(item => String(item ?? '').trim())
    .filter(Boolean)
}

// 案例反序列化后 crackShape 是数组，而查询可能是字符串或数组；
// 只要任一标准化值相同即视为匹配。
export function exactMatch(a, b) {
  const left = new Set(comparableValues(a))
  if (left.size === 0) return 0
  return comparableValues(b).some(value => left.has(value)) ? 1 : 0
}

const VALID_SYMPTOMS = ['linear_streak', 'dot_star', 'patch_leak', 'rainbow_melt', 'polarizer_scratch']
const VALID_RESULTS = ['product_quality_issue', 'not_product_quality', 'no_damage']

// 从模型配置中动态读取必填字段
async function getRequiredFields() {
  try {
    const { loadModelConfig } = await import('./llm-analyzer.mjs')
    const config = await loadModelConfig()
    const annoFields = config.annoFields || []
    return annoFields.filter(f => f.required).map(f => f.id)
  } catch {
    return ['crackLocation', 'crackShape']
  }
}

const RESULT_LABELS = {
  product_quality_issue: '质量问题',
  not_product_quality: '非质量问题',
  no_damage: '屏幕完好',
}

function autoTitle(data) {
  if (data.title) return data.title
  const loc = data.crackLocation || ''
  const shape = data.crackShape || ''
  if (loc && shape) return `${loc}-${shape}`
  if (loc) return `${loc}屏损`
  return '未命名案例'
}

function autoSummary(data) {
  if (data.summary) return data.summary
  return `屏损位置: ${data.crackLocation || '未知'}, 形状: ${data.crackShape || '未知'}`
}

export async function validateCase(c, idx) {
  const errors = []
  const requiredFields = await getRequiredFields()
  // 过滤掉 result 字段（鉴定结论允许为空），剩下的才是真正的必填字段
  const realRequired = requiredFields.filter(f => f !== 'result')
  for (const f of realRequired) {
    if (!c[f]) errors.push(`第${idx + 1}条缺少必填字段: ${f}`)
  }
  return errors
}

// ========== 案例查询 ==========

export async function searchSimilar(query, topK = 3) {
  await ensureStmts()
  const cases = stmts.approvedCases.all().map(deserializeCase)
  const scored = cases
    .filter(c => c.id !== (query.excludeId || ''))
    .map(c => {
      let score = 0
      score += arrayOverlap(query.symptoms || [], c.symptoms) * FEATURE_WEIGHTS.symptoms
      score += exactMatch(query.crackShape, c.crackShape) * FEATURE_WEIGHTS.crackShape
      score += exactMatch(query.physicalFeature, c.physicalFeature) * FEATURE_WEIGHTS.physicalFeature
      score += exactMatch(query.liquidState, c.liquidState) * FEATURE_WEIGHTS.liquidState
      score += exactMatch(query.installStatus, c.installStatus) * FEATURE_WEIGHTS.installStatus
      score += exactMatch(query.result, c.result) * FEATURE_WEIGHTS.result
      return { ...c, similarity: Math.round(score * 100) }
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK)
  return scored
}

export async function getCaseById(id) {
  await ensureStmts()
  const row = stmts.caseById.get(id)
  return row ? deserializeCase(row) : null
}

export async function getStats() {
  await ensureStmts()
  const cases = stmts.allCases.all().map(deserializeCase)
  const byResult = {}
  for (const c of cases) {
    byResult[c.resultLabel] = (byResult[c.resultLabel] || 0) + 1
  }
  const lastUpdated = cases.reduce((latest, c) => {
    const value = c.updated_at || c.created_at || ''
    return value > latest ? value : latest
  }, '')
  return { total: cases.length, byResult, lastUpdated: lastUpdated || null }
}

export async function getResultStats(crackShape, crackStage) {
  await ensureStmts()
  const cases = stmts.approvedCases.all().map(deserializeCase)
  const counts = {}
  let total = 0
  for (const c of cases) {
    if (comparableValues(crackShape).length > 0 && !exactMatch(crackShape, c.crackShape)) continue
    if (comparableValues(crackStage).length > 0 && !exactMatch(crackStage, c.crackStage)) continue
    if (!c.result) continue
    total++
    counts[c.result] = (counts[c.result] || 0) + 1
  }
  const distribution = Object.entries(counts)
    .map(([result, count]) => ({ result, count, pct: Math.round(count / total * 100) }))
    .sort((a, b) => b.count - a.count)
  return {
    total,
    distribution,
    recommended: distribution.length > 0 ? distribution[0].result : null,
  }
}

export async function listCases(filter) {
  await ensureStmts()
  const cases = stmts.allCases.all().map(deserializeCase)
  let result = [...cases]
  if (filter?.result) result = result.filter(c => c.result === filter.result)
  if (filter?.keyword) {
    const kw = filter.keyword.toLowerCase()
    result = result.filter(c =>
      c.title.toLowerCase().includes(kw) ||
      c.deviceModel.toLowerCase().includes(kw) ||
      (c.tags || []).some(t => t.toLowerCase().includes(kw))
    )
  }
  return result
}

// loadCases 保留用于内部模块（如 llm-analyzer）按需读取全部案例
export async function loadCases() {
  await ensureStmts()
  return stmts.allCases.all().map(deserializeCase)
}

// ========== 案例 CRUD — SQLite 事务保证原子性 ==========

export async function createCase(data, options = {}) {
  await ensureStmts()
  const id = options.id || ('case-' + crypto.randomUUID().slice(0, 8))

  const imageDataList = data.imageDataList || (data.imageData ? [data.imageData] : data.images || [])
  const imageNames = await saveImages(id, imageDataList)

  const newCase = {
    id,
    title: autoTitle(data),
    deviceModel: data.deviceModel || '',
    symptoms: data.symptoms || [],
    crackShape: data.crackShape || '',
    crackLocation: data.crackLocation || '',
    physicalFeature: data.physicalFeature || '',
    liquidState: data.liquidState || '',
    installStatus: data.installStatus || '',
    packageDamage: data.packageDamage || '',
    crackStage: data.crackStage || '',
    result: data.result || '',
    resultLabel: data.resultLabel || RESULT_LABELS[data.result] || '',
    summary: autoSummary(data),
    tags: data.tags || [],
    images: imageNames.length > 0 ? imageNames : [],
    possibleCause: data.possibleCause || '',
    warrantyTip: data.warrantyTip || '',
    corrections: [],
    needsReview: false,
    review_status: data.reviewStatus || 'approved',
    remark: data.remark || '',
  }

  // SQLite 写入失败时补偿清理已保存的图片，避免产生孤儿文件。
  try {
    stmts.insertCase.run(serializeCase(newCase))
  } catch (error) {
    await removeImageFiles(imageNames)
    throw error
  }

  // 创建接口不因可选向量服务不可用而回滚 SQLite，但同步结果必须返回给调用方。
  const vectorSync = await syncCaseVector(newCase, { deleteMissing: false })
  if (!vectorSync.ok) {
    console.warn(`[vector] 案例 ${id} 创建后同步失败: ${(vectorSync.errors || []).join('; ')}`)
  }

  return { ...newCase, sync: { vector: vectorSync } }
}

export async function batchImportFromImages(images, defaults) {
  const errors = []
  const valid = []
  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    if (!img.data || !img.data.startsWith('data:image/')) {
      errors.push({ index: i, errors: ['缺少有效的图片数据'], item: img.filename || `图片${i + 1}` })
      continue
    }
    const merged = { ...defaults, ...img }
    delete merged.data
    delete merged.filename
    if (!merged.title && img.filename) {
      merged.title = img.filename.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim()
    }
    const errs = await validateCase(merged, valid.length)
    if (errs.length > 0) {
      errors.push({ index: i, errors: errs, item: img.filename || merged.title || `图片${i + 1}` })
    } else {
      merged.imageData = img.data
      valid.push(merged)
    }
  }

  // 预创建 ID 并保存图片（文件操作不支持事务）
  if (valid.length === 0) {
    return { total: images.length, imported: 0, failed: errors.length, errors, cases: [] }
  }
  const prepared = []
  try {
    for (const item of valid) {
      const id = 'case-' + crypto.randomUUID().slice(0, 8)
      const imageDataList = item.imageData ? [item.imageData] : []
      const imageNames = await saveImages(id, imageDataList)
      prepared.push({ id, imageNames, data: item })
    }
  } catch (error) {
    await removeImageFiles(prepared.flatMap(p => p.imageNames))
    throw error
  }

  // SQLite 事务写入
  const db = getDb()
  const insertMany = db.transaction((items) => {
    const imported = []
    for (const p of items) {
      const c = {
        id: p.id,
        title: autoTitle(p.data),
        deviceModel: p.data.deviceModel || '',
        symptoms: p.data.symptoms || [],
        crackShape: p.data.crackShape || '',
        crackLocation: p.data.crackLocation || '',
        physicalFeature: p.data.physicalFeature || '',
        liquidState: p.data.liquidState || '',
        installStatus: p.data.installStatus || '',
        packageDamage: p.data.packageDamage || '',
        crackStage: p.data.crackStage || '',
        result: p.data.result || '',
        resultLabel: p.data.resultLabel || RESULT_LABELS[p.data.result] || '',
        summary: autoSummary(p.data),
        tags: p.data.tags || [],
        images: p.imageNames,
        possibleCause: p.data.possibleCause || '',
        warrantyTip: p.data.warrantyTip || '',
        corrections: [],
        needsReview: false,
      }
      stmts.insertCase.run(serializeCase(c))
      imported.push(c)
    }
    return imported
  })

  let imported = []
  try {
    imported = insertMany(prepared)
  } catch (e) {
    await removeImageFiles(prepared.flatMap(p => p.imageNames))
    throw new Error(`批量导入事务失败: ${e.message}`)
  }

  // 等待向量批量写入并把部分失败显式返回，避免进程退出时丢失后台 Promise。
  const vectorItems = prepared.filter(p => p.data.imageData).map(p => ({
    case_id: p.id,
    image_base64: p.data.imageData,
    symptoms: (p.data.symptoms || []).join(','),
    result_label: RESULT_LABELS[p.data.result] || '',
    crack_location: p.data.crackLocation || '',
    crack_shape: Array.isArray(p.data.crackShape) ? p.data.crackShape.join(',') : (p.data.crackShape || ''),
  }))
  const vectorSync = { ok: true, requested: vectorItems.length, indexed: 0, failed: 0, errors: [] }
  for (let offset = 0; offset < vectorItems.length; offset += 4) {
    const chunk = vectorItems.slice(offset, offset + 4)
    try {
      const result = await clipIndexBatch(chunk)
      vectorSync.indexed += Number(result.indexed) || 0
      vectorSync.failed += Number(result.failed) || 0
      vectorSync.errors.push(...(result.errors || []))
    } catch (error) {
      vectorSync.failed += chunk.length
      vectorSync.errors.push(error.message)
    }
  }
  vectorSync.ok = vectorSync.failed === 0 && vectorSync.errors.length === 0

  return { total: images.length, imported: imported.length, failed: errors.length, errors, cases: imported, sync: { vector: vectorSync } }
}

export async function updateCase(id, data) {
  await ensureStmts()

  const existing = stmts.caseById.get(id)
  if (!existing) throw new Error(`案例 ${id} 不存在`)

  const previous = deserializeCase(existing)
  const previousImages = getCaseImages(previous)
  const imageDataList = data.imageDataList || (data.imageData ? [data.imageData] : [])
  const merged = { ...deserializeCase(existing), ...data }
  merged.id = id
  if (data.reviewStatus !== undefined) merged.review_status = data.reviewStatus

  if (imageDataList.length > 0) {
    const newNames = await saveImages(id, imageDataList)
    if (newNames.length > 0) merged.images = newNames
  }
  delete merged.imageDataList
  delete merged.imageData

  // SQLite UPDATE：单条原子操作
  const updated = stmts.updateCase.run(serializeCase(merged))
  if (updated.changes !== 1) throw new Error(`案例 ${id} 更新失败`)

  const currentImages = new Set(getCaseImages(merged))
  const staleImages = previousImages.filter(filename => !currentImages.has(filename))
  const [imageCleanup, vectorSync] = await Promise.all([
    removeImageFiles(staleImages),
    syncCaseVector(merged),
  ])

  return { ...merged, sync: { vector: vectorSync, images: imageCleanup } }
}

export async function deleteCase(id) {
  await ensureStmts()
  const existing = stmts.caseById.get(id)
  if (!existing) return false

  const c = deserializeCase(existing)
  const deleted = stmts.deleteCase.run(id)
  if (deleted.changes !== 1) return false

  const [vectorSync, imageCleanup] = await Promise.all([
    deleteVectorWithStatus(id),
    removeImageFiles(getCaseImages(c)),
  ])

  return { deleted: true, id, vectorSync, imageCleanup }
}

export async function batchDeleteCases(ids) {
  await ensureStmts()
  const uniqueIds = [...new Set((ids || []).filter(id => typeof id === 'string' && id))]
  if (uniqueIds.length === 0) {
    return { deleted: 0, total: stmts.countCases.get().total, notFound: 0, vectorSync: null, imageCleanup: { removed: 0, files: [], errors: [] } }
  }
  const existingCases = uniqueIds
    .map(id => stmts.caseById.get(id))
    .filter(Boolean)
    .map(deserializeCase)
  const existingIds = existingCases.map(c => c.id)
  const db = getDb()
  const deleteMany = db.transaction((caseIds) => {
    let changes = 0
    for (let offset = 0; offset < caseIds.length; offset += 500) {
      changes += stmts.deleteCasesByIds(caseIds.slice(offset, offset + 500)).changes
    }
    return changes
  })
  const deleted = deleteMany(existingIds)

  let vectorSync = { ok: true, action: 'delete', requested: 0, deleted: 0, failed: 0, errors: [] }
  if (existingIds.length > 0) {
    try {
      const result = await clipDeleteIndexes(existingIds)
      vectorSync = {
        ok: !(result.errors?.length),
        action: 'delete',
        ...result,
      }
    } catch (error) {
      vectorSync = { ok: false, action: 'delete', requested: existingIds.length, deleted: 0, failed: existingIds.length, errors: [error.message] }
    }
  }
  const imageCleanup = await removeImageFiles(existingCases.flatMap(getCaseImages))

  return {
    deleted,
    total: stmts.countCases.get().total,
    notFound: uniqueIds.length - existingIds.length,
    vectorSync,
    imageCleanup,
  }
}

export async function batchImport(items) {
  const errors = []
  const valid = []
  for (let i = 0; i < items.length; i++) {
    const errs = await validateCase(items[i], i)
    if (errs.length > 0) {
      errors.push({ index: i, errors: errs, item: items[i].title || '(无标题)' })
    } else {
      valid.push(items[i])
    }
  }
  const imported = []
  for (const item of valid) {
    const c = await createCase(item)
    imported.push(c)
  }
  return { total: items.length, imported: imported.length, failed: errors.length, errors, cases: imported }
}

// ===== 向量检索 (CLIP + Milvus) =====

export async function isClipAvailable() {
  const health = await clipHealth()
  return health !== null && health.status === 'ok'
}

export async function searchSimilarVector(imageBase64, topK = 5, excludeCaseId = '', queryLabels = null) {
  try {
    const safeTopK = Math.min(20, Math.max(1, Number.parseInt(topK, 10) || 5))
    const result = await searchByImage(imageBase64, safeTopK + 5, excludeCaseId)
    if (!result.results || result.results.length === 0) return []

    await ensureStmts()
    const cases = stmts.approvedCases.all().map(deserializeCase)
    const caseMap = new Map(cases.map(c => [c.id, c]))

    const merged = result.results.map(r => {
      const c = caseMap.get(r.case_id)
      if (!c) {
        // 向量库中有但本地 SQLite 已删除的案例，跳过
        return null
      }

      const vecSim = r.similarity

      let labelSim = 0
      if (queryLabels) {
        labelSim += arrayOverlap(queryLabels.symptoms || [], c.symptoms) * FEATURE_WEIGHTS.symptoms
        labelSim += exactMatch(queryLabels.crackShape, c.crackShape) * FEATURE_WEIGHTS.crackShape
        labelSim += exactMatch(queryLabels.physicalFeature || queryLabels.crackLocation, c.crackLocation || c.physicalFeature) * FEATURE_WEIGHTS.physicalFeature
        labelSim += exactMatch(queryLabels.liquidState, c.liquidState) * FEATURE_WEIGHTS.liquidState
        labelSim += exactMatch(queryLabels.installStatus, c.installStatus) * FEATURE_WEIGHTS.installStatus
        labelSim += exactMatch(queryLabels.result, c.result) * FEATURE_WEIGHTS.result
      }

      const fusedSimilarity = queryLabels
        ? vecSim * 0.6 + labelSim * 0.4
        : vecSim

      return {
        id: r.case_id,
        title: c?.title || r.case_id,
        deviceModel: c?.deviceModel || '',
        resultLabel: c?.resultLabel || r.result_label || '',
        similarity: Math.round(fusedSimilarity * 10000) / 100,
        vecSimilarity: Math.round(vecSim * 10000) / 100,
        labelSimilarity: Math.round(labelSim * 10000) / 100,
        summary: c?.summary || '',
        tags: c?.tags || [],
        possibleCause: c?.possibleCause || '',
        warrantyTip: c?.warrantyTip || '',
        image: getCaseImages(c)[0] || '',
        crackLocation: c?.crackLocation || r.crack_location || '',
        crackShape: c?.crackShape || r.crack_shape || '',
        crackStage: c?.crackStage || r.crack_stage || '',
        crackPrinciple: c?.crackPrinciple || '',
        result: c?.result || r.result_label || '',
      }
    }).filter(Boolean)
      .filter(m => m.similarity >= 50)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, safeTopK)

    return merged
  } catch (error) {
    console.warn(`[vector] 相似案例检索失败: ${error.message}`)
    return []
  }
}

// ===== 仅 RAG 识别：Top-K 相似度加权投票聚合 =====

// 从相似案例 Top-K 中按相似度加权投票，聚合出结构化识别结果（比取 Top-1 更稳）
export function aggregateRAGFields(results) {
  const FIELDS = [
    { key: 'crackLocation', norm: 'location' },
    { key: 'crackShape', norm: 'shape' },
    { key: 'crackStage', norm: 'stage' },
    { key: 'result', norm: 'conclusion' },
    { key: 'crackPrinciple', norm: null }, // 自由文本，不做枚举归一化
  ]

  const votes = {}
  let totalW = 0
  for (const r of results) {
    const w = Math.max(0, Number(r.similarity) || 0) / 100
    totalW += w
    for (const { key } of FIELDS) {
      let v = r[key]
      if (Array.isArray(v)) v = v.join('、')
      v = String(v || '').trim()
      if (!v || v === '未知') continue
      votes[key] = votes[key] || {}
      votes[key][v] = (votes[key][v] || 0) + w
    }
  }

  const winner = (key, normField) => {
    const m = votes[key]
    if (!m) return ''
    const best = Object.entries(m).sort((a, b) => b[1] - a[1])[0][0]
    return normField ? normalizeEvalField(normField, best) : best
  }

  const winnerShare = (key) => {
    const m = votes[key]
    if (!m || totalW <= 0) return 0
    return Math.round(Object.entries(m).sort((a, b) => b[1] - a[1])[0][1] / totalW * 100)
  }

  const agg = {}
  for (const { key, norm } of FIELDS) agg[key] = winner(key, norm)

  return {
    location: agg.crackLocation,
    shape: agg.crackShape,
    stage: agg.crackStage,
    conclusion: agg.result,
    principle: agg.crackPrinciple,
    // 投票一致度作为聚合置信度（0-100）
    aggregateConfidence: Math.max(...FIELDS.filter(f => f.norm === 'location' || f.norm === 'shape').map(f => winnerShare(f.key)), 0),
  }
}

// 仅 RAG 识别主入口：向量检索 + Top-K 聚合，不调用大模型
export async function analyzeWithRAG(imageBase64, topK = 5, excludeCaseId = '', queryLabels = null) {
  const results = await searchSimilarVector(imageBase64, topK, excludeCaseId, queryLabels)
  const agg = results.length > 0 ? aggregateRAGFields(results) : {}
  const top = results[0] || null
  return {
    location: agg.location || '',
    shape: agg.shape || '',
    stage: agg.stage || '',
    conclusion: agg.conclusion || '',
    principle: agg.principle || '',
    statusObs: '',
    severity: '',
    description: top?.summary || '',
    confidence: top ? Math.round(top.similarity) : 0,
    aggregateConfidence: agg.aggregateConfidence || 0,
    source: 'rag',
    matchedCase: top?.id || '',
    matchedCaseTitle: top?.title || '',
    totalHits: results.length,
    results,
  }
}

export async function indexCaseVector(caseId, imageBase64, meta = {}) {
  try {
    await clipIndexCase(caseId, imageBase64, meta)
    return true
  } catch (error) {
    console.warn(`[vector] 案例 ${caseId} 索引失败: ${error.message}`)
    return false
  }
}

async function deleteVectorWithStatus(caseId) {
  try {
    const result = await clipDeleteIndex(caseId)
    const errors = result.errors || []
    return {
      ok: errors.length === 0,
      action: 'delete',
      requested: result.requested ?? 1,
      deleted: result.deleted ?? 0,
      failed: result.failed ?? 0,
      errors,
    }
  } catch (error) {
    return { ok: false, action: 'delete', requested: 1, deleted: 0, failed: 1, errors: [error.message] }
  }
}

async function syncCaseVector(c, { deleteMissing = true } = {}) {
  if (c.review_status && c.review_status !== 'approved') {
    return deleteVectorWithStatus(c.id)
  }

  const imageName = getCaseImages(c)[0]
  if (!imageName) {
    return deleteMissing
      ? deleteVectorWithStatus(c.id)
      : { ok: true, action: 'skip', reason: 'no-image', errors: [] }
  }

  try {
    const imageBase64 = await readImageDataUrl(imageName)
    const result = await clipIndexCase(c.id, imageBase64, {
      symptoms: c.symptoms || [],
      resultLabel: c.resultLabel || '',
      crackLocation: c.crackLocation || '',
      crackShape: c.crackShape || '',
    })
    return { ok: true, action: 'upsert', indexed: result.indexed ?? 1, errors: [] }
  } catch (error) {
    return { ok: false, action: 'upsert', indexed: 0, errors: [error.message], error: error.message }
  }
}

export async function deleteCaseVector(caseId) {
  const result = await deleteVectorWithStatus(caseId)
  return result.ok
}

export async function rebuildVectorIndex() {
  await ensureStmts()
  const cases = stmts.approvedCases.all().map(deserializeCase)
  const BATCH_SIZE = 4 // 单图最大约 14MB Base64，确保批请求保持在 Python 64MB 上限内
  const candidates = cases.filter(c => getCaseImages(c).length > 0)
  const errors = []
  let indexed = 0
  let failed = 0
  let totalVectors = null
  let resetComplete = false
  let batch = []

  const flushBatch = async () => {
    if (batch.length === 0) return true
    const pending = batch
    batch = []
    try {
      // 仅首批调用 rebuild（清空）；后续批次使用追加/更新接口。
      const result = resetComplete
        ? await clipIndexBatch(pending)
        : await clipRebuildIndex(pending)
      resetComplete = true
      indexed += Number(result.indexed) || 0
      failed += Number(result.failed) || 0
      totalVectors = Number.isFinite(Number(result.total_vectors))
        ? Number(result.total_vectors)
        : indexed
      for (const error of result.errors || []) {
        errors.push(typeof error === 'string' ? error : JSON.stringify(error))
      }
      return true
    } catch (error) {
      failed += pending.length
      errors.push(error.message)
      // 首批未能清空时，绝不能继续向旧索引追加，避免新旧数据混杂。
      return resetComplete
    }
  }

  // 即使当前没有可索引图片，也要发一次空重建以清除陈旧向量。
  if (candidates.length === 0) {
    try {
      const result = await clipRebuildIndex([])
      return {
        indexed: Number(result.indexed) || 0,
        failed: Number(result.failed) || 0,
        total_vectors: Number(result.total_vectors) || 0,
        cleared: true,
        errors: result.errors?.length ? result.errors : undefined,
      }
    } catch (error) {
      return { indexed: 0, failed: 0, total_vectors: null, cleared: false, errors: [error.message] }
    }
  }

  for (const c of candidates) {
    const imageName = getCaseImages(c)[0]
    try {
      const base64 = await readImageDataUrl(imageName)
      batch.push({
        case_id: c.id,
        image_base64: base64,
        symptoms: (c.symptoms || []).join(','),
        result_label: c.resultLabel || '',
        crack_location: c.crackLocation || '',
        crack_shape: Array.isArray(c.crackShape) ? c.crackShape.join(',') : (c.crackShape || ''),
      })

      if (batch.length >= BATCH_SIZE) {
        const canContinue = await flushBatch()
        if (!canContinue) {
          failed += Math.max(0, candidates.length - indexed - failed)
          return { indexed, failed, total_vectors: totalVectors, cleared: false, errors }
        }
      }
    } catch (error) {
      failed++
      errors.push(`${c.id}: 图片读取失败 (${error.message})`)
    }
  }

  if (batch.length > 0) {
    const canContinue = await flushBatch()
    if (!canContinue) failed += Math.max(0, candidates.length - indexed - failed)
  } else if (!resetComplete) {
    // 所有候选图片均读取失败时仍需清空旧索引，否则会留下全部脏向量。
    try {
      const result = await clipRebuildIndex([])
      resetComplete = true
      totalVectors = Number(result.total_vectors) || 0
      failed += Number(result.failed) || 0
      for (const error of result.errors || []) {
        errors.push(typeof error === 'string' ? error : JSON.stringify(error))
      }
    } catch (error) {
      errors.push(error.message)
    }
  }

  return { indexed, failed, total_vectors: totalVectors, cleared: resetComplete, errors: errors.length > 0 ? errors : undefined }
}

// ===== 纠正反馈闭环 =====

function correctionPayloadForStorage(sanitized) {
  const {
    feedbackId: _feedbackId,
    capabilityToken: _capabilityToken,
    caseId: _caseId,
    imageBase64: _imageBase64,
    ...payload
  } = sanitized
  return payload
}

function safeHashEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftBuffer = Buffer.from(left, 'utf8')
  const rightBuffer = Buffer.from(right, 'utf8')
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function parsePendingCorrection(pending) {
  let payload = {}
  if (pending.correction_payload) {
    try {
      payload = JSON.parse(pending.correction_payload)
    } catch {
      throw correctionError('待审核纠错载荷损坏', 'INVALID_PENDING_CORRECTION')
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw correctionError('待审核纠错载荷损坏', 'INVALID_PENDING_CORRECTION')
    }
  }

  // 兼容升级前已进入队列的记录；新记录以 correction_payload 为准。
  return validateCorrectionEntry({
    feedbackId: Number(pending.feedback_id) > 0 ? Number(pending.feedback_id) : 1,
    capabilityToken: 'legacy-pending-record-no-user-token',
    caseId: pending.source_case_id || '',
    originalStatusObs: payload.originalStatusObs || '',
    originalLocation: payload.originalLocation || '',
    originalShape: payload.originalShape || '',
    originalPrinciple: payload.originalPrinciple || '',
    originalStage: payload.originalStage || '',
    originalConclusion: payload.originalConclusion || '',
    correctedStatusObs: payload.correctedStatusObs ?? pending.statusObs,
    correctedLocation: payload.correctedLocation ?? pending.crackLocation,
    correctedShape: payload.correctedShape ?? pending.crackShape,
    correctedPrinciple: payload.correctedPrinciple ?? pending.crackPrinciple,
    correctedStage: payload.correctedStage ?? pending.crackStage,
    correctedConclusion: payload.correctedConclusion ?? pending.result,
    remark: payload.remark ?? pending.remark,
    imageBase64: pending.imageBase64,
  })
}

export async function saveCorrection(entry) {
  await ensureStmts()
  const sanitized = validateCorrectionEntry(entry)
  const {
    feedbackId, capabilityToken,
    caseId, correctedLocation, correctedShape,
    correctedStatusObs, correctedPrinciple, correctedStage, correctedConclusion,
    imageBase64, remark,
  } = sanitized

  const pendingEntry = {
    feedback_id: feedbackId,
    source_case_id: caseId,
    title: `人工校正 - ${correctedLocation} - ${correctedShape}`,
    deviceModel: '',
    statusObs: correctedStatusObs || '',
    crackLocation: correctedLocation,
    crackShape: correctedShape,
    crackPrinciple: correctedPrinciple || '',
    crackStage: correctedStage || '',
    result: correctedConclusion || '',
    remark: remark || '',
    imageBase64,
    correction_payload: JSON.stringify(correctionPayloadForStorage(sanitized)),
    source: 'manual_correction',
  }

  const db = getDb()
  const capabilityHash = crypto.createHash('sha256').update(capabilityToken).digest('hex')
  const insertPendingCorrection = db.transaction(() => {
    const feedback = stmts.feedbackForCorrection.get(feedbackId)
    if (!feedback || !safeHashEquals(feedback.capability_hash, capabilityHash) || feedback.case_id !== caseId) {
      throw correctionError('反馈记录、纠错凭证或案例不匹配', 'INVALID_CORRECTION_CAPABILITY', 403)
    }
    if (!['unconfirmed', 'reported_incorrect'].includes(feedback.status)) {
      throw correctionError('该反馈状态不允许提交纠错', 'CORRECTION_NOT_ALLOWED', 409)
    }
    if (feedback.correction_pending_id !== null) {
      throw correctionError('纠错凭证已被使用，请勿重复提交', 'CORRECTION_CAPABILITY_USED', 409)
    }

    const usage = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(LENGTH(imageBase64)), 0) AS imageChars
      FROM pending_cases WHERE status IN ('pending', 'approving')`).get()
    if (usage.total >= MAX_PENDING_CASES || usage.imageChars + imageBase64.length > MAX_PENDING_IMAGE_CHARS) {
      throw correctionError('待审核队列已达容量上限，请联系管理员处理后重试', 'REVIEW_QUEUE_FULL', 429)
    }

    // 用户点击最终提交时，反馈状态、备注和待审核纠错必须在同一事务内写入。
    // 仍兼容旧前端已经先标记 reported_incorrect、尚未提交纠错的会话。
    const prepared = stmts.prepareFeedbackForCorrection.run({
      feedback_id: feedbackId,
      case_id: caseId,
      capability_hash: capabilityHash,
      remark,
    })
    if (prepared.changes !== 1) {
      throw correctionError('反馈记录已被处理，请勿重复提交', 'CORRECTION_CAPABILITY_USED', 409)
    }

    const inserted = stmts.insertPending.run(pendingEntry)
    const pendingId = Number(inserted.lastInsertRowid)
    const consumed = stmts.consumeFeedbackForCorrection.run({
      pending_id: pendingId,
      feedback_id: feedbackId,
      case_id: caseId,
      capability_hash: capabilityHash,
    })
    if (consumed.changes !== 1) {
      throw correctionError('纠错凭证已被使用，请勿重复提交', 'CORRECTION_CAPABILITY_USED', 409)
    }
    return pendingId
  })

  let pendingId
  try {
    pendingId = insertPendingCorrection()
  } catch (error) {
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw correctionError('纠错凭证已被使用，请勿重复提交', 'CORRECTION_CAPABILITY_USED', 409)
    }
    throw error
  }

  return { success: true, pendingId, pendingCreated: true }
}

// ===== 人工审核工作台 =====

export async function listPendingCases(status = 'pending', { limit = 24, offset = 0 } = {}) {
  await ensureStmts()
  const allowedStatuses = new Set(['pending', 'approving', 'approved', 'rejected'])
  if (status && !allowedStatuses.has(status)) throw correctionError('审核状态不合法')
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 24, 1), 100)
  const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0)
  const db = getDb()
  const where = status ? 'WHERE status = ?' : ''
  const params = status ? [status] : []
  const list = db.prepare(`SELECT
      id, feedback_id, source_case_id, title, deviceModel, statusObs, crackLocation, crackShape, crackPrinciple,
      crackStage, result, remark, source, status, reviewed_by, review_remark,
      reviewed_at, approved_case_id, created_at, image_archived_at, image_expires_at, image_deleted_at,
      CASE WHEN LENGTH(imageBase64) > 0 OR LENGTH(image_path) > 0 THEN 1 ELSE 0 END AS hasImage
    FROM pending_cases ${where}
    ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, safeLimit, safeOffset)
  const total = db.prepare(`SELECT COUNT(*) AS total FROM pending_cases ${where}`).get(...params).total
  return { list, total, limit: safeLimit, offset: safeOffset }
}

export async function getPendingCaseImage(id) {
  await ensureStmts()
  const safeId = Number.parseInt(id, 10)
  if (!Number.isSafeInteger(safeId) || safeId <= 0) throw correctionError('待审核案例 id 不合法')
  const imageDataUrl = await readPendingCaseImageDataUrl(safeId)
  if (imageDataUrl === null) return null
  if (!imageDataUrl || !isValidImageDataUrl(imageDataUrl, MAX_CORRECTION_IMAGE_DATA_URL_CHARS)) {
    throw correctionError('待审核案例图片无效')
  }
  return imageDataUrl
}

export async function getPendingStats() {
  await ensureStmts()
  return {
    pending: stmts.pendingCount.get('pending').total,
    approving: stmts.pendingCount.get('approving').total,
    approved: stmts.pendingCount.get('approved').total,
    rejected: stmts.pendingCount.get('rejected').total,
  }
}

async function approvedPendingResult(pending) {
  const caseId = pending.approved_case_id || ''
  const formalRow = caseId ? stmts.caseById.get(caseId) : null
  if (!formalRow) throw new Error('审核状态为已通过，但正式案例不存在')
  const formal = deserializeCase(formalRow)
  // SQLite 提交和外部向量服务无法组成同一事务；幂等审批必须重试同步，
  // 以修复进程在 DB 提交后、向量请求完成前退出的窗口。
  const vectorSync = await syncCaseVector(formal, { deleteMissing: false })
  const imageArchive = await archiveReviewedPendingImage(pending.id)
  return {
    caseId: formal.id,
    title: formal.title,
    status: 'approved',
    idempotent: true,
    totalTraining: stmts.countTraining.get().total,
    sync: { vector: vectorSync },
    imageArchive,
  }
}

async function archiveReviewedPendingImage(id) {
  try {
    return await archivePendingCaseImage(id)
  } catch (error) {
    // 审核状态已可靠提交，归档失败时保留 Base64，并在下次启动或幂等审核时重试。
    console.warn(`[review] 纠错审核记录 ${id} 图片归档失败，已保留 Base64: ${error.message}`)
    return { id: Number(id), archived: false, retryable: true, error: error.message }
  }
}

export async function approvePendingCase(id, reviewedBy = '', reviewRemark = '') {
  await ensureStmts()
  const safeReviewedBy = boundedCorrectionText(reviewedBy, 'reviewedBy', 200)
  const safeReviewRemark = boundedCorrectionText(reviewRemark, 'reviewRemark', 2000)
  let p = stmts.pendingById.get(id)
  if (!p) throw new Error('待审核案例不存在')
  if (p.status === 'approved') {
    return approvedPendingResult(p)
  }
  if (p.status === 'rejected') throw new Error('该案例已驳回，不能直接通过审核')

  let caseId = p.approved_case_id || `case-review-${p.id}-${crypto.randomUUID().slice(0, 8)}`
  let claimed = false
  if (p.status === 'pending') {
    const claim = stmts.pendingClaimApproval.run(caseId, safeReviewedBy, safeReviewRemark, id)
    claimed = claim.changes === 1
    p = stmts.pendingById.get(id)
    caseId = p?.approved_case_id || caseId
  }
  if (!p || !['approving', 'approved'].includes(p.status)) {
    throw new Error('待审核案例状态已变化，请刷新后重试')
  }
  if (p.status === 'approved') {
    return approvedPendingResult(p)
  }

  const existingFormalRow = stmts.caseById.get(caseId)
  let imageNames = existingFormalRow ? getCaseImages(deserializeCase(existingFormalRow)) : []
  try {
    // 先完整验证待审载荷，再执行图片文件写入。SQLite 收口失败时会补偿删除新文件。
    parsePendingCorrection(p)
    if (!existingFormalRow) {
      imageNames = await saveImages(caseId, [p.imageBase64])
      if (imageNames.length !== 1) throw correctionError('待审核案例图片保存失败', 'INVALID_PENDING_IMAGE')
    }
  } catch (error) {
    if (claimed && !stmts.caseById.get(caseId)) stmts.pendingResetApproval.run(id, caseId)
    if (!existingFormalRow && imageNames.length > 0) await removeImageFiles(imageNames)
    throw error
  }

  const db = getDb()
  const closeApproval = db.transaction(() => {
    const current = stmts.pendingById.get(id)
    if (!current) throw new Error('待审核案例不存在')
    if (current.status === 'approved') {
      const formal = stmts.caseById.get(current.approved_case_id || caseId)
      return { formal: formal ? deserializeCase(formal) : null, idempotent: true, caseUpdated: false }
    }
    if (current.status !== 'approving' || current.approved_case_id !== caseId) {
      throw new Error('待审核案例状态已变化，请刷新后重试')
    }

    const correction = parsePendingCorrection(current)
    const createdAt = new Date().toISOString()
    let formalRow = stmts.caseById.get(caseId)
    let formal
    if (formalRow) {
      formal = deserializeCase(formalRow)
    } else {
      formal = {
        id: caseId,
        title: current.title || `人工校正 - ${correction.correctedLocation} - ${correction.correctedShape}`,
        deviceModel: current.deviceModel || '',
        symptoms: [],
        crackShape: correction.correctedShape,
        crackLocation: correction.correctedLocation,
        physicalFeature: '',
        liquidState: '',
        installStatus: '',
        packageDamage: '',
        crackStage: correction.correctedStage || '',
        crackPrinciple: correction.correctedPrinciple || '',
        result: correction.correctedConclusion,
        resultLabel: RESULT_LABELS[correction.correctedConclusion] || '',
        summary: `人工审核纠错：${correction.remark}`,
        tags: ['人工审核', '纠错案例'],
        images: imageNames,
        possibleCause: correction.correctedPrinciple || '',
        warrantyTip: '',
        corrections: [],
        needsReview: false,
        review_status: 'approved',
        remark: correction.remark,
      }
      stmts.insertCase.run(serializeCase(formal))
    }

    if (!stmts.trainingByPendingId.get(current.id)) {
      stmts.insertTraining.run(serializeTraining({
        statusObs: correction.correctedStatusObs,
        location: correction.correctedLocation,
        shape: correction.correctedShape,
        principle: correction.correctedPrinciple,
        stage: correction.correctedStage,
        conclusion: correction.correctedConclusion,
        originalStatusObs: correction.originalStatusObs,
        originalLocation: correction.originalLocation,
        originalShape: correction.originalShape,
        originalPrinciple: correction.originalPrinciple,
        originalStage: correction.originalStage,
        originalConclusion: correction.originalConclusion,
        caseId: current.source_case_id || '',
        source: 'manual_correction',
        remark: correction.remark,
        source_pending_id: current.id,
      }))
    }

    let caseUpdated = false
    if (current.source_case_id && current.source_case_id !== caseId) {
      const sourceRow = stmts.caseById.get(current.source_case_id)
      if (sourceRow) {
        const sourceCase = deserializeCase(sourceRow)
        if (!Array.isArray(sourceCase.corrections)) sourceCase.corrections = []
        if (!sourceCase.corrections.some(item => Number(item?.pendingId) === Number(current.id))) {
          sourceCase.corrections.push({
            pendingId: Number(current.id),
            feedbackId: Number(current.feedback_id) || undefined,
            originalStatusObs: correction.originalStatusObs,
            originalLocation: correction.originalLocation,
            originalShape: correction.originalShape,
            originalPrinciple: correction.originalPrinciple,
            originalStage: correction.originalStage,
            originalConclusion: correction.originalConclusion,
            correctedStatusObs: correction.correctedStatusObs,
            correctedLocation: correction.correctedLocation,
            correctedShape: correction.correctedShape,
            correctedPrinciple: correction.correctedPrinciple,
            correctedStage: correction.correctedStage,
            correctedConclusion: correction.correctedConclusion,
            remark: correction.remark,
            reviewedBy: safeReviewedBy,
            reviewRemark: safeReviewRemark,
            createdAt,
          })
          if (sourceCase.corrections.length > 50) sourceCase.corrections = sourceCase.corrections.slice(-50)
          if (sourceCase.corrections.length >= 3) sourceCase.needsReview = true
          stmts.updateCase.run(serializeCase(sourceCase))
          caseUpdated = true
        }
      }
    }

    const finalized = stmts.pendingFinalizeApproval.run(safeReviewedBy, safeReviewRemark, id, caseId)
    if (finalized.changes !== 1) throw new Error('审核状态收口失败，请重试')
    return { formal, idempotent: false, caseUpdated }
  })

  let closed
  try {
    closed = closeApproval()
  } catch (error) {
    const current = stmts.pendingById.get(id)
    const formalExists = !!stmts.caseById.get(caseId)
    if (claimed && current?.status === 'approving' && !formalExists) {
      stmts.pendingResetApproval.run(id, caseId)
    }
    if (!existingFormalRow && !formalExists && imageNames.length > 0) await removeImageFiles(imageNames)
    throw error
  }

  if (!closed.formal) throw new Error('审核已完成但正式案例不存在')
  const vectorSync = await syncCaseVector(closed.formal, { deleteMissing: false })
  const imageArchive = await archiveReviewedPendingImage(id)
  return {
    caseId: closed.formal.id,
    title: closed.formal.title,
    status: 'approved',
    idempotent: closed.idempotent,
    caseUpdated: closed.caseUpdated || undefined,
    totalTraining: stmts.countTraining.get().total,
    sync: { vector: vectorSync },
    imageArchive,
  }
}

export async function rejectPendingCase(id, reviewedBy = '', reviewRemark = '') {
  await ensureStmts()
  const safeReviewedBy = boundedCorrectionText(reviewedBy, 'reviewedBy', 200)
  const safeReviewRemark = boundedCorrectionText(reviewRemark, 'reviewRemark', 2000)
  const p = stmts.pendingById.get(id)
  if (!p) throw new Error('待审核案例不存在')
  if (p.status === 'approved' || p.status === 'approving') throw new Error('该案例已通过或正在通过审核，不能驳回')
  if (p.status === 'rejected') {
    return { id, status: 'rejected', idempotent: true, imageArchive: await archiveReviewedPendingImage(id) }
  }
  if (p.approved_case_id && stmts.caseById.get(p.approved_case_id)) {
    throw new Error('正式案例已创建，必须先完成审批收口，不能驳回')
  }
  const result = stmts.pendingReject.run(safeReviewedBy, safeReviewRemark, id)
  if (result.changes !== 1) throw new Error('待审核案例状态已变化，请刷新后重试')
  return { id, status: 'rejected', idempotent: false, imageArchive: await archiveReviewedPendingImage(id) }
}
