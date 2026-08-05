import { writeFile, mkdir, access, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import sharp from 'sharp'
import { searchByImage, indexCase as clipIndexCase, deleteIndex as clipDeleteIndex, rebuildIndex as clipRebuildIndex, clipHealth } from './clip-client.mjs'
import { initDb, getDb, serializeCase, deserializeCase, serializeTraining, deserializeTraining, migrateFromJson } from './db.mjs'
import { normalizeEvalField } from './field-normalize.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', 'data')
const IMAGES_DIR = join(DATA_DIR, 'images')
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

let stmts = null
let dbReady = false

async function ensureStmts() {
  if (dbReady) return
  stmts = await initDb()
  await migrateFromJson(stmts)
  dbReady = true
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

// 灰度边缘密度：统计像素行/列的梯度强度
function _rowEdgeDensity(pixels, w, h) {
  const scores = new Array(h).fill(0)
  for (let y = 0; y < h; y++) {
    const rowOff = y * w
    let sum = 0
    for (let x = 1; x < w; x++) sum += Math.abs(pixels[rowOff + x] - pixels[rowOff + x - 1])
    scores[y] = sum / w
  }
  return scores
}

function _colEdgeDensity(pixels, w, h) {
  const scores = new Array(w).fill(0)
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = 1; y < h; y++) sum += Math.abs(pixels[y * w + x] - pixels[(y - 1) * w + x])
    scores[x] = sum / h
  }
  return scores
}

// 找连续显著区域（带回缩 margin 排除边框杂讯）
function _peakRegion(scores, thresholdRatio = 0.35) {
  const max = Math.max(...scores)
  const th = max * thresholdRatio
  let start = 0, end = scores.length - 1
  for (; start < scores.length && scores[start] < th; start++) {}
  for (; end >= 0 && scores[end] < th; end--) {}
  if (start >= end) return { start: 0, end: scores.length - 1 }
  const margin = Math.floor((end - start) * 0.04)
  return { start: start + margin, end: end - margin }
}

// 智能 TV 屏幕方向检测：基于边框边缘密度 + 16:9 比例 + 顶部/底部边缘密度比较
async function autoOrientTV(buf) {
  let best = buf
  try {
    const rawW = 600
    const { data, info } = await sharp(buf).resize(rawW).grayscale().raw().toBuffer({ resolveWithObject: true })
    const w = info.width, h = info.height
    const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)

    // 1. 用列边缘密度定位 TV 左右边界 → 估算横竖
    const colScores = _colEdgeDensity(pixels, w, h)
    const cols = _peakRegion(colScores)
    const tvW = cols.end - cols.start
    const rowScores = _rowEdgeDensity(pixels, w, h)
    const rows = _peakRegion(rowScores)
    const tvH = rows.end - rows.start

    // 2. 如果 TV 区域明显是竖版（高 > 宽 × 1.1），说明照片被旋转了 90°
    if (tvH > tvW * 1.1) {
      best = await sharp(buf).rotate(90).toBuffer()
      // 对旋转后重做灰度分析
      const { data: d2, info: i2 } = await sharp(best).resize(rawW).grayscale().raw().toBuffer({ resolveWithObject: true })
      const p2 = new Uint8Array(d2.buffer, d2.byteOffset, d2.byteLength)
      return _autoOrient180(best, p2, i2.width, i2.height)
    }

    return _autoOrient180(best, pixels, w, h)
  } catch (_) { return buf }
}

// 旋转 90° 后对正 180° 方向：比较 TV 底部 vs 顶部的边缘密度
async function _autoOrient180(buf, pixels, w, h) {
  try {
    const rScores = _rowEdgeDensity(pixels, w, h)
    const rows = _peakRegion(rScores)
    const tvH = rows.end - rows.start
    if (tvH < 10) return buf  // TV 区域太小，放弃检测

    const bandH = Math.max(Math.floor(tvH * 0.12), 4)
    const topStart = rows.start, topEnd = rows.start + bandH
    const botEnd = rows.end, botStart = rows.end - bandH

    let topSum = 0, botSum = 0
    for (let y = topStart; y < topEnd; y++) topSum += rScores[y]
    for (let y = botStart; y < botEnd; y++) botSum += rScores[y]

    // 底部边缘密度更高（底座/支架/logo），如果顶部 > 底部 → 倒立
    if (topSum > botSum * 1.1) {
      return await sharp(buf).rotate(180).toBuffer()
    }
  } catch (_) {}
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
    let data = Buffer.from(match[2], 'base64')
    if (data.length > MAX_IMAGE_BYTES) continue

    // 两步方向纠正：EXIF 旋转 + TV 屏幕边框检测
    data = await autoOrientImage(data)
    data = await autoOrientTV(data)
    const suffix = i > 0 ? `_${i}` : ''
    const filename = `${caseId}${suffix}.${ext}`
    const filepath = join(IMAGES_DIR, filename)
    await writeFile(filepath, data)
    filenames.push(filename)
  }
  return filenames
}

export function getImagePath(filename) {
  return join(IMAGES_DIR, filename)
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
    location: entry.location,
    shape: entry.shape,
    caseId: entry.caseId || '',
    originalLocation: entry.originalLocation || '',
    originalShape: entry.originalShape || '',
    source: entry.source || 'manual',
    imageBase64: entry.imageBase64 || '',
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
  if (!a || !b) return 0
  const set = new Set(a)
  return b.filter(x => set.has(x)).length / Math.max(a.length, b.length, 1)
}

function exactMatch(a, b) {
  return (!a || !b) ? 0 : (a === b ? 1 : 0)
}

const VALID_SYMPTOMS = ['linear_streak', 'dot_star', 'patch_leak', 'rainbow_melt', 'polarizer_scratch']
const VALID_RESULTS = ['product_quality_issue', 'logistics_issue', 'not_product_quality', 'needs_further_review']

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
  product_quality_issue: '产品质量问题',
  logistics_issue: '物流问题',
  not_product_quality: '非产品质量问题',
  needs_further_review: '需进一步综合判定',
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
  const cases = stmts.allCases.all().map(deserializeCase)
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
  return { total: cases.length, byResult, lastUpdated: '2026-06-02' }
}

export async function getResultStats(crackShape, crackStage) {
  await ensureStmts()
  const cases = stmts.allCases.all().map(deserializeCase)
  const counts = {}
  let total = 0
  for (const c of cases) {
    if (crackShape && c.crackShape !== crackShape) continue
    if (crackStage && c.crackStage !== crackStage) continue
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

export async function createCase(data) {
  await ensureStmts()
  const id = 'case-' + crypto.randomUUID().slice(0, 8)

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
  }

  // SQLite 单条 INSERT：天然原子，无需额外锁
  stmts.insertCase.run(serializeCase(newCase))

  // 如果有图片，索引第一张到向量库
  if (imageDataList.length > 0 && imageDataList[0]) {
    const imageBase64 = imageDataList[0]
    if (imageBase64 && imageBase64.startsWith('data:image/')) {
      indexCaseVector(id, imageBase64, {
        symptoms: newCase.symptoms,
        resultLabel: newCase.resultLabel,
        crackLocation: newCase.crackLocation,
        crackShape: newCase.crackShape,
      }).catch(() => {})
    }
  }

  return newCase
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
  for (const item of valid) {
    const id = 'case-' + crypto.randomUUID().slice(0, 8)
    const imageDataList = item.imageData ? [item.imageData] : []
    const imageNames = await saveImages(id, imageDataList)
    prepared.push({ id, imageNames, data: item })
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
    throw new Error(`批量导入事务失败: ${e.message}`)
  }

  // 异步索引向量（不影响事务结果）
  for (const p of prepared) {
    const imageBase64 = p.data.imageData
    if (imageBase64) {
      indexCaseVector(p.id, imageBase64, {
        symptoms: p.data.symptoms || [],
        resultLabel: RESULT_LABELS[p.data.result] || '',
        crackLocation: p.data.crackLocation || '',
        crackShape: p.data.crackShape || '',
      }).catch(() => {})
    }
  }

  return { total: images.length, imported: imported.length, failed: errors.length, errors, cases: imported }
}

export async function updateCase(id, data) {
  await ensureStmts()

  const existing = stmts.caseById.get(id)
  if (!existing) throw new Error(`案例 ${id} 不存在`)

  const imageDataList = data.imageDataList || []
  const merged = { ...deserializeCase(existing), ...data }

  if (imageDataList.length > 0) {
    const newNames = await saveImages(id, imageDataList)
    if (newNames.length > 0) merged.images = newNames
  }
  delete merged.imageDataList

  // SQLite UPDATE：单条原子操作
  stmts.updateCase.run(serializeCase(merged))

  return merged
}

export async function deleteCase(id) {
  await ensureStmts()
  const existing = stmts.caseById.get(id)
  if (!existing) return false

  stmts.deleteCase.run(id)

  // 从向量库删除
  deleteCaseVector(id).catch(() => {})

  return true
}

export async function batchDeleteCases(ids) {
  await ensureStmts()
  const total = stmts.countCases.get().total

  const db = getDb()
  const placeholders = ids.map(() => '?').join(',')
  const result = db.prepare(`DELETE FROM cases WHERE id IN (${placeholders})`).run(...ids)

  return { deleted: result.changes, total }
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
    const result = await searchByImage(imageBase64, topK + 5, excludeCaseId)
    if (!result.results || result.results.length === 0) return []

    await ensureStmts()
    const cases = stmts.allCases.all().map(deserializeCase)
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
      .slice(0, topK)

    return merged
  } catch {
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
  } catch {
    return false
  }
}

export async function deleteCaseVector(caseId) {
  try {
    await clipDeleteIndex(caseId)
    return true
  } catch {
    return false
  }
}

export async function rebuildVectorIndex() {
  await ensureStmts()
  const cases = stmts.allCases.all().map(deserializeCase)
  const BATCH_SIZE = 20 // 分批处理，避免 OOM

  const results = []
  let batch = []

  for (const c of cases) {
    const imgs = getCaseImages(c)
    if (imgs.length === 0) continue
    const imageName = imgs[0]
    try {
      const filepath = getImagePath(imageName)
      const data = await readFile(filepath)
      const ext = imageName.split('.').pop().toLowerCase()
      const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }
      const base64 = `data:${mime[ext] || 'image/jpeg'};base64,${data.toString('base64')}`
      batch.push({
        case_id: c.id,
        image_base64: base64,
        symptoms: (c.symptoms || []).join(','),
        result_label: c.resultLabel || '',
        crack_location: c.crackLocation || '',
        crack_shape: Array.isArray(c.crackShape) ? c.crackShape.join(',') : (c.crackShape || ''),
      })

      // 达到批次上限时发送
      if (batch.length >= BATCH_SIZE) {
        try {
          const result = await clipRebuildIndex(batch)
          results.push(result)
        } catch (e) {
          results.push({ indexed: 0, failed: batch.length, errors: [e.message] })
        }
        batch = [] // 释放内存
      }
    } catch {
      // 图片读取失败，跳过
    }
  }

  // 处理剩余不足一批的
  if (batch.length > 0) {
    try {
      const result = await clipRebuildIndex(batch)
      results.push(result)
    } catch (e) {
      results.push({ indexed: 0, failed: batch.length, errors: [e.message] })
    }
    batch = [] // 释放内存
  }

  if (results.length === 0) {
    return { indexed: 0, failed: 0, errors: ['没有可索引的案例图片'], total_vectors: 0 }
  }

  // 汇总结果
  const total = results.reduce((acc, r) => ({
    indexed: acc.indexed + (r.indexed || 0),
    failed: acc.failed + (r.failed || 0),
  }), { indexed: 0, failed: 0 })
  const allErrors = results.flatMap(r => r.errors || [])

  return { ...total, total_vectors: total.indexed, errors: allErrors.length > 0 ? allErrors : undefined }
}

// ===== 纠正反馈闭环 =====

export async function saveCorrection(entry) {
  await ensureStmts()
  const { caseId, originalLocation, originalShape, correctedLocation, correctedShape, imageBase64 } = entry || {}

  // 1. 写入训练数据
  const trainingEntry = {
    location: correctedLocation || '',
    shape: correctedShape || '',
    originalLocation: originalLocation || '',
    originalShape: originalShape || '',
    caseId: caseId || '',
    source: 'manual_correction',
    createdAt: new Date().toISOString(),
  }
  if (imageBase64) trainingEntry.imageBase64 = imageBase64

  stmts.insertTraining.run(serializeTraining(trainingEntry))
  const totalTraining = stmts.countTraining.get().total

  // 2. 如果关联了具体案例，更新案例的 corrections 数组
  let caseUpdated = false
  if (caseId) {
    const existing = stmts.caseById.get(caseId)
    if (existing) {
      const c = deserializeCase(existing)
      if (!Array.isArray(c.corrections)) c.corrections = []
      c.corrections.push({
        originalLocation: originalLocation || '',
        originalShape: originalShape || '',
        correctedLocation: correctedLocation || '',
        correctedShape: correctedShape || '',
        createdAt: new Date().toISOString(),
      })
      if (c.corrections.length >= 3 && !c.needsReview) {
        c.needsReview = true
      }
      stmts.updateCase.run(serializeCase(c))
      caseUpdated = true
    }
  }

  return { success: true, totalTraining, caseUpdated }
}
