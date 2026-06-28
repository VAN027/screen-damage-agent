import { createServer, json } from './server-utils.mjs'
import { searchSimilar, getCaseById, getStats, listCases, createCase, updateCase, deleteCase, batchDeleteCases, batchImport, validateCase, getImagePath, batchImportFromImages, loadTraining, addTraining, getTrainingStats, searchSimilarVector, indexCaseVector, rebuildVectorIndex, isClipAvailable, saveCorrection } from './search-engine.mjs'
import { analyzeWithLLM, analyzeWithLLMStream, loadModelConfig, saveModelConfig, loadAnnotationConfig, saveAnnotationConfig, annotateSingle, annotateBatch } from './llm-analyzer.mjs'
import { uploadDocument, listDocuments, getDocument, deleteDocument, getKBStats, searchKB } from './knowledge-base.mjs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PORT = parseInt(process.env.KNOWLEDGE_PORT || '8083', 10)
const startTime = Date.now()

function normalizeQuery(q) {
  return {
    symptoms: q.symptoms || [],
    crackShape: q.crackShape || '',
    physicalFeature: q.physicalFeature || '',
    liquidState: q.liquidState || '',
    installStatus: q.installStatus || '',
    result: q.result || '',
    excludeId: q.excludeId || '',
    topK: Math.min(parseInt(q.topK) || 3, 10),
  }
}

const routes = [
  {
    method: 'GET',
    path: '/api/health',
    handler: async (_req, res) => {
      const clipOk = await isClipAvailable()
      json(res, 200, {
        service: 'knowledge-ai',
        status: 'ok',
        uptime: Date.now() - startTime,
        version: '2.0.0',
        engine: clipOk ? 'CLIP-ViT-B/32 + Milvus' : 'label-match (CLIP unavailable)',
      })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/stats',
    handler: async (_req, res) => {
      const stats = await getStats()
      json(res, 200, { success: true, data: stats })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/case',
    handler: async (_req, res, { query }) => {
      const c = await getCaseById(query.id)
      if (!c) return json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: '案例不存在' } })
      json(res, 200, { success: true, data: c })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/search',
    handler: async (_req, res, { body }) => {
      // 优先使用向量检索（融合标签加权）
      if (body.imageBase64) {
        try {
          const queryLabels = {
            symptoms: body.symptoms || [],
            crackShape: body.crackShape || '',
            crackLocation: body.crackLocation || '',
            physicalFeature: body.physicalFeature || '',
            liquidState: body.liquidState || '',
            installStatus: body.installStatus || '',
            result: body.result || '',
          }
          const results = await searchSimilarVector(body.imageBase64, body.topK || 5, body.excludeId || '', queryLabels)
          if (results.length > 0) {
            return json(res, 200, {
              success: true,
              data: {
                query: body,
                totalHits: results.length,
                engine: 'vector+label-fusion (PIL+Numpy 512-dim)',
                results: results.map(r => ({
                  id: r.id,
                  title: r.title,
                  deviceModel: r.deviceModel,
                  resultLabel: r.resultLabel,
                  confidence: r.confidence,
                  similarity: r.similarity,
                  vecSimilarity: r.vecSimilarity,
                  labelSimilarity: r.labelSimilarity,
                  summary: r.summary,
                  tags: r.tags,
                  possibleCause: r.possibleCause || '',
                  warrantyTip: r.warrantyTip || '',
                  image: r.image,
                })),
              },
            })
          }
        } catch {
          // 向量检索失败，回退到标签匹配
        }
      }

      // 回退：标签加权匹配
      const q = normalizeQuery(body)
      const { getCaseImages } = await import('./search-engine.mjs')
      const results = await searchSimilar(q, q.topK)
      json(res, 200, {
        success: true,
        data: {
          query: body,
          totalHits: results.length,
          engine: 'multi-label-weighted-match (fallback)',
          results: results.map(r => ({
            id: r.id,
            title: r.title,
            deviceModel: r.deviceModel,
            resultLabel: r.resultLabel,
            confidence: r.confidence,
            similarity: r.similarity,
            summary: r.summary,
            tags: r.tags,
            possibleCause: r.possibleCause || '',
            warrantyTip: r.warrantyTip || '',
            image: getCaseImages(r)[0] || r.image || '',
          })),
        },
      })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/search-vector',
    handler: async (_req, res, { body }) => {
      if (!body.imageBase64) return json(res, 400, { success: false, error: { code: 'MISSING_IMAGE', message: '缺少图片数据 imageBase64' } })
      try {
        const queryLabels = body.labels || null
        const results = await searchSimilarVector(body.imageBase64, body.topK || 5, body.excludeId || '', queryLabels)
        json(res, 200, {
          success: true,
          data: {
            query: { imageSize: body.imageBase64.length },
            totalHits: results.length,
            engine: 'vector+label-fusion (PIL+Numpy 512-dim)',
            results,
          },
        })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'VECTOR_SEARCH_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/vector-stats',
    handler: async (_req, res) => {
      try {
        const clipOk = await isClipAvailable()
        json(res, 200, { success: true, data: { clipAvailable: clipOk } })
      } catch (e) {
        json(res, 200, { success: true, data: { clipAvailable: false, error: e.message } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/rebuild-index',
    handler: async (_req, res) => {
      try {
        const result = await rebuildVectorIndex()
        json(res, 200, { success: true, data: result })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'REBUILD_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/extract',
    handler: async (_req, res, { body }) => {
      // 如果提供了 base64 图片，通过 CLIP 服务提取特征
      if (body && body.imageBase64) {
        try {
          const { extractFeatures } = await import('./clip-client.mjs')
          const result = await extractFeatures(body.imageBase64)
          return json(res, 200, {
            success: true,
            data: {
              embeddingId: result.embedding_id,
              vector: result.vector,
              model: result.model,
              dim: result.dim,
            },
          })
        } catch (e) {
          return json(res, 503, {
            success: false,
            error: { code: 'CLIP_UNAVAILABLE', message: 'CLIP 服务不可用: ' + e.message },
          })
        }
      }

      // 无图片时的信息响应
      json(res, 200, {
        success: true,
        data: {
          message: '请提供 imageBase64 进行 CLIP 特征提取。CLIP ViT-B/32 提取 512 维向量。',
          modelInfo: {
            name: 'CLIP ViT-B/32',
            dim: 512,
            status: 'ready',
          },
        },
      })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/cases',
    handler: async (_req, res, { query }) => {
      const filter = {}
      if (query.result) filter.result = query.result
      if (query.keyword) filter.keyword = query.keyword
      const cases = await listCases(filter)
      json(res, 200, { success: true, data: cases })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/cases',
    handler: async (_req, res, { body }) => {
      const errs = await validateCase(body, 0)
      if (errs.length > 0) return json(res, 400, { success: false, error: { code: 'VALIDATION_ERROR', message: errs.join('; ') } })
      const c = await createCase(body)
      json(res, 201, { success: true, data: c })
    },
  },
  {
    method: 'PUT',
    path: '/api/knowledge/cases',
    handler: async (_req, res, { body }) => {
      if (!body.id) return json(res, 400, { success: false, error: { code: 'MISSING_ID', message: '缺少案例 id' } })
      try {
        const c = await updateCase(body.id, body)
        json(res, 200, { success: true, data: c })
      } catch (e) {
        json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: e.message } })
      }
    },
  },
  {
    method: 'DELETE',
    path: '/api/knowledge/cases',
    handler: async (_req, res, { query }) => {
      if (!query.id) return json(res, 400, { success: false, error: { code: 'MISSING_ID', message: '缺少案例 id' } })
      const ok = await deleteCase(query.id)
      if (!ok) return json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: '案例不存在' } })
      json(res, 200, { success: true, data: { id: query.id, deleted: true } })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/cases/batch-delete',
    handler: async (_req, res, { body }) => {
      if (!body.ids || !Array.isArray(body.ids) || body.ids.length === 0) return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '请提供 ids 数组' } })
      const result = await batchDeleteCases(body.ids)
      json(res, 200, { success: true, data: result })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/cases/batch',
    handler: async (_req, res, { body }) => {
      if (!body.items || !Array.isArray(body.items)) return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '请提供 items 数组' } })
      const result = await batchImport(body.items)
      const status = result.failed === 0 ? 200 : (result.imported === 0 ? 400 : 207)
      json(res, status, { success: result.failed === 0, data: result })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/images',
    handler: async (_req, res, { query }) => {
      if (!query.name) return json(res, 400, { success: false, error: { code: 'MISSING_NAME', message: '缺少图片文件名' } })
      try {
        const filepath = getImagePath(query.name)
        const data = await readFile(filepath)
        const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }
        const ct = mime[extname(query.name).toLowerCase()] || 'image/jpeg'
        res.writeHead(200, { 'Content-Type': ct, 'Content-Length': data.length, 'Cache-Control': 'public, max-age=86400' })
        res.end(data)
      } catch {
        json(res, 404, { success: false, error: { code: 'IMAGE_NOT_FOUND', message: '图片不存在' } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/cases/from-images',
    handler: async (_req, res, { body }) => {
      if (!body.images || !Array.isArray(body.images)) return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '请提供 images 数组' } })
      if (body.images.length > 100) return json(res, 400, { success: false, error: { code: 'TOO_MANY', message: '单次最多导入 100 张图片' } })
      const defaults = body.defaults || {}
      const result = await batchImportFromImages(body.images, defaults)
      const status = result.failed === 0 ? 200 : (result.imported === 0 ? 400 : 207)
      json(res, status, { success: result.failed === 0, data: result })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/training',
    handler: async (_req, res) => {
      const data = await loadTraining()
      const stats = await getTrainingStats()
      json(res, 200, { success: true, data: { entries: data, stats } })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/training',
    handler: async (_req, res, { body }) => {
      if (!body.features || !Array.isArray(body.features)) return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '缺少特征向量 features' } })
      if (!body.location || !body.shape) return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '缺少 location 或 shape 标签' } })
      if (body.features.length !== 35) return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '特征向量必须为 35 维' } })
      const count = await addTraining(body)
      json(res, 201, { success: true, data: { total: count, message: `训练数据已添加，当前共 ${count} 条` } })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/correction',
    handler: async (_req, res, { body }) => {
      if (!body.correctedLocation || !body.correctedShape) {
        return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '缺少 correctedLocation 或 correctedShape' } })
      }
      try {
        const result = await saveCorrection(body)
        json(res, 201, { success: true, data: result })
      } catch (err) {
        json(res, 500, { success: false, error: { code: 'SAVE_FAILED', message: err.message } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/analyze-llm',
    handler: async (_req, res, { body }) => {
      const images = body.images || (body.image ? [body.image] : null)
      if (!images || !images.length) return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '缺少图片数据 image 或 images (base64 数组)' } })
      try {
        const result = await analyzeWithLLM(images, body.context)
        json(res, 200, { success: true, data: result })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'LLM_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/analyze-llm-stream',
    handler: async (_req, res, { body }) => {
      const images = body.images || (body.image ? [body.image] : null)
      if (!images || !images.length) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ success: false, error: { code: 'INVALID_FORMAT', message: '缺少图片数据 image 或 images (base64 数组)' } }))
        return
      }

      // SSE 响应头
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })

      const send = (event) => {
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`)
        } catch {
          // 客户端已断开
        }
      }

      try {
        const result = await analyzeWithLLMStream(images, send, body.context)
        send({ stage: 'done', percent: 100, message: '分析完成！', result })
      } catch (e) {
        send({ stage: 'error', message: e.message || '分析失败' })
      } finally {
        res.end()
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/annotate-single',
    handler: async (_req, res, { body }) => {
      if (!body.image || !body.image.startsWith('data:image/')) {
        return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '缺少有效的 base64 图片' } })
      }
      try {
        const result = await annotateSingle(body.image)
        json(res, 200, { success: true, data: result })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'LLM_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/annotate-batch',
    handler: async (_req, res, { body }) => {
      if (!body.images || !Array.isArray(body.images) || body.images.length === 0) {
        return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '缺少有效的图片数组' } })
      }
      try {
        const result = await annotateBatch(body.images)
        json(res, 200, { success: true, data: result })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'LLM_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/model-config',
    handler: async (_req, res) => {
      const config = await loadModelConfig()
      // 隐藏部分 API Key
      const masked = { ...config, apiKey: config.apiKey ? config.apiKey.substring(0, 8) + '****' + config.apiKey.substring(config.apiKey.length - 4) : '' }
      json(res, 200, { success: true, data: masked })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/model-config',
    handler: async (_req, res, { body }) => {
      const config = await loadModelConfig()
      const updated = { ...config, ...body }
      // 如果 API Key 包含 **** 说明是脱敏后的值，保留原来的 Key
      if (body.apiKey && body.apiKey.includes('****')) {
        delete updated.apiKey
        updated.apiKey = config.apiKey
      }
      await saveModelConfig(updated)
      json(res, 200, { success: true, data: { message: '模型配置已保存' } })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/annotation-config',
    handler: async (_req, res) => {
      const config = await loadAnnotationConfig()
      const masked = { ...config, apiKey: config.apiKey ? config.apiKey.substring(0, 8) + '****' + config.apiKey.substring(config.apiKey.length - 4) : '' }
      json(res, 200, { success: true, data: masked })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/annotation-config',
    handler: async (_req, res, { body }) => {
      const config = await loadAnnotationConfig()
      const updated = { ...config, ...body }
      if (body.apiKey && body.apiKey.includes('****')) {
        delete updated.apiKey
        updated.apiKey = config.apiKey
      }
      await saveAnnotationConfig(updated)
      json(res, 200, { success: true, data: { message: '标注模型配置已保存' } })
    },
  },
  // ===== 知识库管理 =====
  {
    method: 'GET',
    path: '/api/knowledge/kb/stats',
    handler: async (_req, res) => {
      const stats = await getKBStats()
      json(res, 200, { success: true, data: stats })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/kb/documents',
    handler: async (_req, res) => {
      const docs = await listDocuments()
      json(res, 200, { success: true, data: docs })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/kb/document',
    handler: async (_req, res, { query }) => {
      if (!query.id) return json(res, 400, { success: false, error: { code: 'MISSING_ID', message: '缺少文档 id' } })
      const doc = await getDocument(query.id)
      if (!doc) return json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: '文档不存在' } })
      json(res, 200, { success: true, data: doc })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/kb/upload',
    handler: async (_req, res, { body }) => {
      if (!body.filename || !body.content) return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '请提供 filename 和 content' } })
      try {
        const doc = await uploadDocument(body.filename, body.content)
        json(res, 201, { success: true, data: doc })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'UPLOAD_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'DELETE',
    path: '/api/knowledge/kb/document',
    handler: async (_req, res, { query }) => {
      if (!query.id) return json(res, 400, { success: false, error: { code: 'MISSING_ID', message: '缺少文档 id' } })
      const ok = await deleteDocument(query.id)
      if (!ok) return json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: '文档不存在' } })
      json(res, 200, { success: true, data: { id: query.id, deleted: true } })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/kb/search',
    handler: async (_req, res, { body }) => {
      if (!body.query) return json(res, 400, { success: false, error: { code: 'MISSING_QUERY', message: '请提供查询内容 query' } })
      const results = await searchKB(body.query, body.topK || 5)
      json(res, 200, { success: true, data: { query: body.query, results } })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/dashboard',
    handler: async (_req, res) => {
      try {
        const DATA_DIR = join(__dirname, '..', 'data')
        const IMAGES_DIR = join(DATA_DIR, 'images')
        const CASES_FILE = join(DATA_DIR, 'cases.json')
        const TRAINING_FILE = join(DATA_DIR, 'training.json')
        const KB_FILE = join(DATA_DIR, 'knowledge-base.json')

        // 并发获取所有统计
        const [caseStats, trainingStats, kbStats, clipOk] = await Promise.all([
          getStats(),
          getTrainingStats(),
          getKBStats(),
          isClipAvailable(),
        ])

        // 获取文件大小和图片数
        const getFileSize = async (f) => { try { const s = await stat(f); return s.size } catch { return 0 } }
        const countImageFiles = async () => {
          try {
            const { readdir } = await import('node:fs/promises')
            const files = await readdir(IMAGES_DIR)
            return files.filter(f => /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(f)).length
          } catch { return 0 }
        }

        const [casesSize, trainingSize, kbSize, imageCount] = await Promise.all([
          getFileSize(CASES_FILE),
          getFileSize(TRAINING_FILE),
          getFileSize(KB_FILE),
          countImageFiles(),
        ])

        // 获取 Python 向量服务状态
        let vectorStats = null
        try {
          const { clipStats } = await import('./clip-client.mjs')
          vectorStats = await clipStats()
        } catch { vectorStats = null }

        json(res, 200, {
          success: true,
          data: {
            uptime: Date.now() - startTime,
            cases: { ...caseStats, fileSize: casesSize, filePath: CASES_FILE },
            training: { ...trainingStats, fileSize: trainingSize, filePath: TRAINING_FILE },
            knowledgeBase: { ...kbStats, fileSize: kbSize, filePath: KB_FILE },
            images: { count: imageCount, dir: IMAGES_DIR },
            vector: { clipAvailable: clipOk, ...(vectorStats || {}) },
          },
        })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'DASHBOARD_ERROR', message: e.message } })
      }
    },
  },
]

createServer(routes, PORT, 'knowledge-ai')
console.log(`[knowledge-ai] 相似案例检索 → POST http://localhost:${PORT}/api/knowledge/search`)
console.log(`[knowledge-ai] 案例库统计 → GET  http://localhost:${PORT}/api/knowledge/stats`)
