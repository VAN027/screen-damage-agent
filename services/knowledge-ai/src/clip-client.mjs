/**
 * CLIP + Milvus 向量检索客户端
 * 封装对 Python CLIP 微服务 (端口 8084) 的 HTTP 调用
 */

const CLIP_SERVICE_URL = (process.env.CLIP_SERVICE_URL || 'http://localhost:8084').replace(/\/$/, '')
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || ''
const DEFAULT_TIMEOUT_MS = Number(process.env.CLIP_REQUEST_TIMEOUT_MS) || 60_000
const INFERENCE_TIMEOUT_MS = Number(process.env.CLIP_INFERENCE_TIMEOUT_MS) || 180_000
const REBUILD_TIMEOUT_MS = Number(process.env.CLIP_REBUILD_TIMEOUT_MS) || 900_000

async function clipApi(path, options = {}) {
  const url = `${CLIP_SERVICE_URL}${path}`
  const requiresAuth = path !== '/api/health'
  if (requiresAuth && !INTERNAL_SERVICE_TOKEN) {
    throw new Error('缺少 INTERNAL_SERVICE_TOKEN，已拒绝调用向量服务')
  }
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers = {},
    signal: externalSignal,
    ...fetchOptions
  } = options
  const controller = new AbortController()
  const onExternalAbort = () => controller.abort(externalSignal?.reason)
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))

  try {
    const res = await fetch(url, {
      ...fetchOptions,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(INTERNAL_SERVICE_TOKEN ? { 'X-Internal-Token': INTERNAL_SERVICE_TOKEN } : {}),
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }))
      throw new Error(err.detail || err.message || `CLIP 服务错误: ${res.status}`)
    }
    return await res.json()
  } catch (error) {
    if (controller.signal.aborted && !externalSignal?.aborted) {
      throw new Error(`CLIP 服务请求超时 (${timeoutMs}ms): ${path}`, { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * 健康检查 - 检测 CLIP 服务是否可用
 */
export async function clipHealth() {
  try {
    const result = await clipApi('/api/health', { timeoutMs: 3_000 })
    // 健康端点可公开探活，但 Node 若没有内部凭据仍不能把向量能力标为可用。
    return INTERNAL_SERVICE_TOKEN ? result : null
  } catch {
    return null
  }
}

/**
 * 获取向量库统计信息
 */
export async function clipStats() {
  return clipApi('/api/knowledge/stats')
}

/**
 * 提取图片特征向量 (base64)
 * @param {string} imageBase64 - base64 编码的图片 (可带 data:image/...;base64, 前缀)
 * @returns {{ embedding_id: string, vector: number[], model: string, dim: number }}
 */
export async function extractFeatures(imageBase64) {
  return clipApi('/api/knowledge/extract-base64', {
    method: 'POST',
    body: JSON.stringify({ image_base64: imageBase64 }),
    timeoutMs: INFERENCE_TIMEOUT_MS,
  })
}

/**
 * 检测电视机方向。Python 服务常驻，OpenCV/Paddle 模型按进程复用。
 * 失败会抛出异常，由上层明确标记为需要人工确认，禁止静默当作 0°。
 */
export async function detectTVOrientation(imageBase64, { useOcr = false, debug = false, signal } = {}) {
  return clipApi('/api/knowledge/orientation', {
    method: 'POST',
    body: JSON.stringify({ image_base64: imageBase64, use_ocr: useOcr, debug }),
    timeoutMs: INFERENCE_TIMEOUT_MS,
    signal,
  })
}

export async function compareTVOrientationOcr(imageBase64, points, { signal } = {}) {
  return clipApi('/api/knowledge/orientation-ocr', {
    method: 'POST',
    body: JSON.stringify({ image_base64: imageBase64, points }),
    timeoutMs: INFERENCE_TIMEOUT_MS,
    signal,
  })
}

/**
 * 以图搜图 - CLIP + Milvus 向量检索
 * @param {string} imageBase64 - base64 编码的查询图片
 * @param {number} topK - 返回 Top-K 结果
 * @param {string} excludeCaseId - 排除的案例 ID
 * @returns {{ results: Array, total_hits: number }}
 */
export async function searchByImage(imageBase64, topK = 5, excludeCaseId = '') {
  return clipApi('/api/knowledge/search', {
    method: 'POST',
    body: JSON.stringify({
      image_base64: imageBase64,
      top_k: topK,
      exclude_case_id: excludeCaseId,
    }),
    timeoutMs: INFERENCE_TIMEOUT_MS,
  })
}

/**
 * 将案例图片特征向量入库
 * @param {string} caseId - 案例 ID
 * @param {string} imageBase64 - base64 编码的图片
 * @param {object} meta - 附加元数据
 */
export async function indexCase(caseId, imageBase64, meta = {}) {
  return clipApi('/api/knowledge/index-base64', {
    method: 'POST',
    body: JSON.stringify({
      case_id: caseId,
      image_base64: imageBase64,
      symptoms: (meta.symptoms || []).join(','),
      result_label: meta.resultLabel || '',
      crack_location: meta.crackLocation || '',
      crack_shape: Array.isArray(meta.crackShape) ? meta.crackShape.join(',') : (meta.crackShape || ''),
    }),
    timeoutMs: INFERENCE_TIMEOUT_MS,
  })
}

/**
 * 批量向量入库
 * @param {Array} items - [{ case_id, image_base64, symptoms, result_label, crack_location, crack_shape }]
 */
export async function indexBatch(items) {
  return clipApi('/api/knowledge/index-batch', {
    method: 'POST',
    // Python 端点的请求模型是 List[BatchIndexItem]，顶层必须直接是数组。
    body: JSON.stringify(items),
    timeoutMs: REBUILD_TIMEOUT_MS,
  })
}

/**
 * 删除案例向量
 * @param {string} caseId
 */
export async function deleteIndex(caseId) {
  return clipApi(`/api/knowledge/index/${encodeURIComponent(caseId)}`, {
    method: 'DELETE',
  })
}

/**
 * 批量删除案例向量，避免逐条请求和回退索引逐条全量写盘。
 * @param {string[]} caseIds
 */
export async function deleteIndexes(caseIds) {
  return clipApi('/api/knowledge/delete-batch', {
    method: 'POST',
    body: JSON.stringify({ case_ids: caseIds }),
  })
}

/**
 * 清空并重建全部向量索引
 * @param {Array} items - 同 indexBatch 的 items 格式
 */
export async function rebuildIndex(items) {
  return clipApi('/api/knowledge/rebuild-index', {
    method: 'POST',
    body: JSON.stringify({ items }),
    timeoutMs: REBUILD_TIMEOUT_MS,
  })
}
