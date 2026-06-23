import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { searchByImage, indexCase as clipIndexCase, deleteIndex as clipDeleteIndex, rebuildIndex as clipRebuildIndex, clipHealth } from './clip-client.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', 'data')
const CASES_FILE = join(DATA_DIR, 'cases.json')
const TRAINING_FILE = join(DATA_DIR, 'training.json')
const IMAGES_DIR = join(DATA_DIR, 'images')
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

let caseDB = null

async function ensureDir(dir) {
  try { await access(dir) } catch { await mkdir(dir, { recursive: true }) }
}

async function loadCases() {
  if (caseDB) return caseDB
  await ensureDir(DATA_DIR)
  try {
    const raw = await readFile(CASES_FILE, 'utf-8')
    caseDB = JSON.parse(raw)
  } catch {
    caseDB = []
  }
  return caseDB
}

async function saveCases(cases) {
  caseDB = cases
  await ensureDir(DATA_DIR)
  await writeFile(CASES_FILE, JSON.stringify(cases, null, 2), 'utf-8')
}

export async function saveImage(id, base64DataUrl) {
  await ensureDir(IMAGES_DIR)
  const match = base64DataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
  if (!match) throw new Error('无效的 base64 图片格式')
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
  const data = Buffer.from(match[2], 'base64')
  if (data.length > MAX_IMAGE_BYTES) throw new Error(`图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 限制`)
  const filename = `${id}.${ext}`
  const filepath = join(IMAGES_DIR, filename)
  await writeFile(filepath, data)
  return filename
}

export function getImagePath(filename) {
  return join(IMAGES_DIR, filename)
}

export async function loadTraining() {
  await ensureDir(DATA_DIR)
  try {
    const raw = await readFile(TRAINING_FILE, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}

export async function addTraining(entry) {
  const data = await loadTraining()
  data.push({
    features: entry.features,
    location: entry.location,
    shape: entry.shape,
    caseId: entry.caseId || '',
    createdAt: new Date().toISOString(),
  })
  await writeFile(TRAINING_FILE, JSON.stringify(data, null, 2), 'utf-8')
  return data.length
}

export async function getTrainingStats() {
  const data = await loadTraining()
  const locations = {}, shapes = {}
  for (const e of data) { locations[e.location] = (locations[e.location] || 0) + 1; shapes[e.shape] = (shapes[e.shape] || 0) + 1 }
  return { total: data.length, locations, shapes }
}

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
const REQUIRED_FIELDS = ['crackLocation', 'crackShape']

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

export function validateCase(c, idx) {
  const errors = []
  for (const f of REQUIRED_FIELDS) {
    if (!c[f]) errors.push(`第${idx + 1}条缺少必填字段: ${f}`)
  }
  if (c.result && !VALID_RESULTS.includes(c.result)) {
    errors.push(`第${idx + 1}条无效结论: ${c.result}`)
  }
  if (c.confidence != null && (c.confidence < 0 || c.confidence > 100)) {
    errors.push(`第${idx + 1}条置信度超出范围(0-100): ${c.confidence}`)
  }
  return errors
}

export async function searchSimilar(query, topK = 3) {
  const cases = await loadCases()
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
  const cases = await loadCases()
  return cases.find(c => c.id === id) || null
}

export async function getStats() {
  const cases = await loadCases()
  const byResult = {}
  for (const c of cases) {
    byResult[c.resultLabel] = (byResult[c.resultLabel] || 0) + 1
  }
  return { total: cases.length, byResult, lastUpdated: '2026-06-02' }
}

export async function listCases(filter) {
  const cases = await loadCases()
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

export async function createCase(data) {
  const cases = await loadCases()
  const id = 'case-' + crypto.randomUUID().slice(0, 8)
  let imageName = ''
  if (data.imageData) {
    imageName = await saveImage(id, data.imageData)
  }
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
    result: data.result || '',
    resultLabel: data.resultLabel || RESULT_LABELS[data.result] || '',
    confidence: data.confidence || 0,
    summary: autoSummary(data),
    tags: data.tags || [],
    image: imageName || data.image || '',
    possibleCause: data.possibleCause || '',
    warrantyTip: data.warrantyTip || '',
  }
  cases.push(newCase)
  await saveCases(cases)

  // 如果有图片，自动索引到向量库
  if (imageName) {
    const imageBase64 = data.imageData || ''
    if (imageBase64) {
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
    const errs = validateCase(merged, valid.length)
    if (errs.length > 0) {
      errors.push({ index: i, errors: errs, item: img.filename || merged.title || `图片${i + 1}` })
    } else {
      merged.imageData = img.data
      valid.push(merged)
    }
  }
  const imported = []
  for (const item of valid) {
    const c = await createCase(item)
    const { imageData, ...safe } = c
    imported.push(safe)
  }
  return { total: images.length, imported: imported.length, failed: errors.length, errors, cases: imported }
}

export async function updateCase(id, data) {
  const cases = await loadCases()
  const idx = cases.findIndex(c => c.id === id)
  if (idx === -1) throw new Error(`案例 ${id} 不存在`)
  cases[idx] = { ...cases[idx], ...data, id }
  await saveCases(cases)
  return cases[idx]
}

export async function deleteCase(id) {
  const cases = await loadCases()
  const idx = cases.findIndex(c => c.id === id)
  if (idx === -1) return false
  cases.splice(idx, 1)
  await saveCases(cases)

  // 从向量库删除
  deleteCaseVector(id).catch(() => {})

  return true
}

export async function batchDeleteCases(ids) {
  const cases = await loadCases()
  const idSet = new Set(ids)
  const remaining = cases.filter(c => !idSet.has(c.id))
  const deleted = cases.length - remaining.length
  if (deleted > 0) {
    await saveCases(remaining)
  }
  return { deleted, total: cases.length }
}

export async function batchImport(items) {
  const errors = []
  const valid = []
  for (let i = 0; i < items.length; i++) {
    const errs = validateCase(items[i], i)
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

/**
 * 检查 CLIP 向量服务是否可用
 */
export async function isClipAvailable() {
  const health = await clipHealth()
  // 只要 Python 特征提取服务可达就算可用（Milvus 不是必须的，有内存回退）
  return health !== null && health.status === 'ok'
}

/**
 * 基于图片进行向量检索 + 标签加权融合
 * @param {string} imageBase64 - 查询图片 base64
 * @param {number} topK
 * @param {string} excludeCaseId
 * @param {object} queryLabels - 查询标签 { symptoms, crackShape, crackLocation, result }
 */
export async function searchSimilarVector(imageBase64, topK = 5, excludeCaseId = '', queryLabels = null) {
  try {
    const result = await searchByImage(imageBase64, topK + 5, excludeCaseId) // 多取一些用于融合后筛选
    if (!result.results || result.results.length === 0) return []

    const cases = await loadCases()
    const caseMap = new Map(cases.map(c => [c.id, c]))

    const merged = result.results.map(r => {
      const c = caseMap.get(r.case_id)
      if (!c) return null

      const vecSim = r.similarity // 余弦相似度，值域 [0, 1]

      // 计算标签匹配相似度（与 searchSimilar 相同的加权体系）
      let labelSim = 0
      if (queryLabels) {
        labelSim += arrayOverlap(queryLabels.symptoms || [], c.symptoms) * FEATURE_WEIGHTS.symptoms
        labelSim += exactMatch(queryLabels.crackShape, c.crackShape) * FEATURE_WEIGHTS.crackShape
        labelSim += exactMatch(queryLabels.physicalFeature || queryLabels.crackLocation, c.crackLocation || c.physicalFeature) * FEATURE_WEIGHTS.physicalFeature
        labelSim += exactMatch(queryLabels.liquidState, c.liquidState) * FEATURE_WEIGHTS.liquidState
        labelSim += exactMatch(queryLabels.installStatus, c.installStatus) * FEATURE_WEIGHTS.installStatus
        labelSim += exactMatch(queryLabels.result, c.result) * FEATURE_WEIGHTS.result
      }

      // 融合得分：向量 60% + 标签 40%
      const fusedSimilarity = queryLabels
        ? vecSim * 0.6 + labelSim * 0.4
        : vecSim

      return {
        id: r.case_id,
        title: c?.title || r.case_id,
        deviceModel: c?.deviceModel || '',
        resultLabel: c?.resultLabel || r.result_label || '',
        confidence: c?.confidence || 0,
        similarity: Math.round(fusedSimilarity * 10000) / 100, // 转为百分比，保留2位小数
        vecSimilarity: Math.round(vecSim * 10000) / 100,
        labelSimilarity: Math.round(labelSim * 10000) / 100,
        summary: c?.summary || '',
        tags: c?.tags || [],
        possibleCause: c?.possibleCause || '',
        warrantyTip: c?.warrantyTip || '',
        image: c?.image || '',
        crackLocation: c?.crackLocation || r.crack_location || '',
        crackShape: c?.crackShape || r.crack_shape || '',
      }
    }).filter(Boolean)
      .filter(m => m.similarity >= 50) // 融合后低于 50% 的不展示
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK)

    return merged
  } catch {
    return []
  }
}

/**
 * 将案例图片索引到 Milvus 向量库
 */
export async function indexCaseVector(caseId, imageBase64, meta = {}) {
  try {
    await clipIndexCase(caseId, imageBase64, meta)
    return true
  } catch {
    return false
  }
}

/**
 * 从 Milvus 向量库删除案例
 */
export async function deleteCaseVector(caseId) {
  try {
    await clipDeleteIndex(caseId)
    return true
  } catch {
    return false
  }
}

/**
 * 重建全部向量索引（从案例库中读取所有图片重新向量化）
 */
export async function rebuildVectorIndex() {
  const cases = await loadCases()
  const items = []

  for (const c of cases) {
    if (!c.image) continue
    try {
      const filepath = getImagePath(c.image)
      const data = await readFile(filepath)
      const ext = c.image.split('.').pop().toLowerCase()
      const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }
      const base64 = `data:${mime[ext] || 'image/jpeg'};base64,${data.toString('base64')}`
      items.push({
        case_id: c.id,
        image_base64: base64,
        symptoms: (c.symptoms || []).join(','),
        result_label: c.resultLabel || '',
        crack_location: c.crackLocation || '',
        crack_shape: c.crackShape || '',
      })
    } catch {
      // 图片读取失败，跳过
    }
  }

  if (items.length === 0) {
    return { indexed: 0, failed: 0, errors: ['没有可索引的案例图片'], total_vectors: 0 }
  }

  return clipRebuildIndex(items)
}
