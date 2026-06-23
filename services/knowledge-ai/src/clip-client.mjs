/**
 * CLIP + Milvus 向量检索客户端
 * 封装对 Python CLIP 微服务 (端口 8084) 的 HTTP 调用
 */

const CLIP_SERVICE_URL = process.env.CLIP_SERVICE_URL || 'http://localhost:8084'

async function clipApi(path, options = {}) {
  const url = `${CLIP_SERVICE_URL}${path}`
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }))
    throw new Error(err.detail || err.message || `CLIP 服务错误: ${res.status}`)
  }
  return res.json()
}

/**
 * 健康检查 - 检测 CLIP 服务是否可用
 */
export async function clipHealth() {
  try {
    return await clipApi('/api/health')
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
      crack_shape: meta.crackShape || '',
    }),
  })
}

/**
 * 批量向量入库
 * @param {Array} items - [{ case_id, image_base64, symptoms, result_label, crack_location, crack_shape }]
 */
export async function indexBatch(items) {
  return clipApi('/api/knowledge/index-batch', {
    method: 'POST',
    body: JSON.stringify({ items }),
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
 * 清空并重建全部向量索引
 * @param {Array} items - 同 indexBatch 的 items 格式
 */
export async function rebuildIndex(items) {
  return clipApi('/api/knowledge/rebuild-index', {
    method: 'POST',
    body: JSON.stringify({ items }),
  })
}
