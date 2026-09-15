import { readFile, writeFile, mkdir, access, unlink, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { inflateRaw } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', 'data')
const KB_FILE = join(DATA_DIR, 'knowledge-base.json')
const KB_DOCS_DIR = join(DATA_DIR, 'kb-docs')

// 文档分块大小（字符数）
const CHUNK_SIZE = 800
const CHUNK_OVERLAP = 100
const MAX_TEXT_CHARS = 5 * 1024 * 1024
const MAX_DOCX_BYTES = 20 * 1024 * 1024
const MAX_ZIP_ENTRY_BYTES = 25 * 1024 * 1024
const MAX_MEDIA_BYTES = 10 * 1024 * 1024

let kbDB = null
let mutationTail = Promise.resolve()

function serializeMutation(operation) {
  const run = mutationTail.then(operation, operation)
  mutationTail = run.catch(() => {})
  return run
}

async function ensureDir(dir) {
  try { await access(dir) } catch { await mkdir(dir, { recursive: true }) }
}

async function loadKB() {
  if (kbDB) return kbDB
  await ensureDir(DATA_DIR)
  await ensureDir(KB_DOCS_DIR)
  try {
    const raw = await readFile(KB_FILE, 'utf-8')
    kbDB = JSON.parse(raw)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`知识库索引读取失败: ${error.message}`)
    kbDB = { documents: [], chunks: [] }
  }
  return kbDB
}

async function saveKB(db) {
  await ensureDir(DATA_DIR)
  const tempPath = `${KB_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(tempPath, JSON.stringify(db, null, 2), { encoding: 'utf-8', mode: 0o600 })
    await rename(tempPath, KB_FILE)
    kbDB = db
  } catch (error) {
    try { await unlink(tempPath) } catch {}
    throw error
  }
}

function inflateLimited(data, maxOutputLength) {
  return new Promise((resolve, reject) => {
    inflateRaw(data, { maxOutputLength }, (error, result) => error ? reject(error) : resolve(result))
  })
}

// 将文本按字符分块（含重叠），表格行不拆分
export function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (!text || text.trim().length === 0) return []
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw new Error('chunkSize 必须为正数')
  const safeOverlap = Number.isFinite(overlap)
    ? Math.min(Math.max(0, Math.floor(overlap)), Math.max(0, Math.floor(chunkSize) - 1))
    : 0
  const clean = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()

  // 标记表格行索引，供断点判断使用
  const lines = clean.split('\n')
  const tableLineIndices = new Set()
  let inTable = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('|') && line.endsWith('|') && line.includes(' | ')) {
      inTable = true
      tableLineIndices.add(i)
    } else if (inTable && !line.startsWith('|')) {
      inTable = false
    }
  }

  const chunks = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length)
    // 尽量在句号、换行处截断
    if (end < clean.length) {
      const breakChars = ['\n\n', '\n', '。', '；', '，', '. ', '; ', ', ', ' ']
      for (const ch of breakChars) {
        const lastBreak = clean.lastIndexOf(ch, end)
        if (lastBreak > start + chunkSize * 0.5) {
          // 计算 candidateEnd 落在第几行，如果该行是表格行则跳过此断点
          const candidateEnd = lastBreak + ch.length
          const linesUpToBreak = clean.substring(0, candidateEnd).split('\n')
          const breakLineIdx = linesUpToBreak.length - 1
          if (tableLineIndices.has(breakLineIdx)) {
            // 断点落在表格行内，向后退到表格行边界
            continue // 尝试下一个 breakChar
          }
          end = candidateEnd
          break
        }
      }
    }
    const chunk = clean.substring(start, end).trim()
    if (chunk) chunks.push(chunk)

    // 已消费到文档末尾时必须直接结束；否则 end-overlap 会把 start
    // 拉回到末尾之前，反复生成同一个尾块直至命中安全上限。
    if (end >= clean.length) break

    const nextStart = end - safeOverlap
    // 即使传入异常参数，也保证游标严格向前推进。
    start = nextStart > start ? nextStart : end
    if (chunks.length > 500) break // 安全上限
  }
  return chunks
}

// 中文 Bigram 分词 + 英文按词
// 单字切分语义丢失严重（如"漏液"和"进液"都只匹配"液"），
// 改用 Bigram 捕获相邻二字组合，大幅提升 Jaccard 检索精度。
function tokenize(text) {
  const tokens = []
  let buf = ''
  const chars = [...text.toLowerCase()] // 正确处理 Unicode 多字节字符

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]

    if (/[a-z0-9]/.test(ch)) {
      buf += ch
    } else if (/[\u4e00-\u9fff]/.test(ch)) {
      // 结束英文/数字缓冲区
      if (buf.length > 0) { tokens.push(buf); buf = '' }
      // 中文 Bigram：当前字 + 下一个字组成词
      if (i + 1 < chars.length && /[\u4e00-\u9fff]/.test(chars[i + 1])) {
        tokens.push(ch + chars[i + 1])
      } else {
        // 孤立中文字（行尾或后跟非中文），保留单字
        tokens.push(ch)
      }
    }
    // 标点符号、空格等忽略
  }
  if (buf.length > 0) tokens.push(buf)
  return tokens
}

// 计算两个词集的 Jaccard 相似度
function jaccardSimilarity(tokensA, tokensB) {
  const setA = new Set(tokensA)
  const setB = new Set(tokensB)
  let intersection = 0
  for (const t of setA) {
    if (setB.has(t)) intersection++
  }
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

// ===== DOCX 解析（不依赖外部库） =====

// 从 ZIP buffer 中提取指定文件的解压内容
async function extractZipEntry(zipBuf, entryPath) {
  let offset = 0
  const view = new DataView(zipBuf.buffer, zipBuf.byteOffset, zipBuf.byteLength)

  while (offset < zipBuf.length - 30) {
    const sig = view.getUint32(offset, true)
    if (sig !== 0x04034b50) { offset++; continue }

    const compression = view.getUint16(offset + 8, true)
    const compressedSize = view.getUint32(offset + 18, true)
    const uncompressedSize = view.getUint32(offset + 22, true)
    const nameLen = view.getUint16(offset + 26, true)
    const extraLen = view.getUint16(offset + 28, true)
    const nameBuf = zipBuf.subarray(offset + 30, offset + 30 + nameLen)
    const name = new TextDecoder().decode(nameBuf)

    const dataOffset = offset + 30 + nameLen + extraLen
    const compressedData = zipBuf.subarray(dataOffset, dataOffset + compressedSize)

    if (name === entryPath && uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
      throw new Error(`ZIP 条目 ${entryPath} 解压后超过大小限制`)
    }
    if (name === entryPath && compression === 8) {
      return inflateLimited(compressedData, MAX_ZIP_ENTRY_BYTES)
    }

    offset = dataOffset + compressedSize
    if (name === entryPath) return compressedData
  }

  throw new Error(`ZIP 中未找到文件: ${entryPath}`)
}

// 扫描 ZIP 中 word/media/ 下的所有图片文件
function listZipMediaFiles(zipBuf) {
  let offset = 0
  const view = new DataView(zipBuf.buffer, zipBuf.byteOffset, zipBuf.byteLength)
  const files = []

  while (offset < zipBuf.length - 30) {
    const sig = view.getUint32(offset, true)
    if (sig !== 0x04034b50) { offset++; continue }

    const compression = view.getUint16(offset + 8, true)
    const compressedSize = view.getUint32(offset + 18, true)
    const uncompressedSize = view.getUint32(offset + 22, true)
    const nameLen = view.getUint16(offset + 26, true)
    const extraLen = view.getUint16(offset + 28, true)
    const nameBuf = zipBuf.subarray(offset + 30, offset + 30 + nameLen)
    const name = new TextDecoder().decode(nameBuf)

    if (name.startsWith('word/media/') && /\.(png|jpe?g|gif|bmp|webp)$/i.test(name)
        && compressedSize <= MAX_MEDIA_BYTES && uncompressedSize <= MAX_MEDIA_BYTES && files.length < 50) {
      const dataOffset = offset + 30 + nameLen + extraLen
      const data = zipBuf.subarray(dataOffset, dataOffset + compressedSize)
      files.push({ name, compression, data, uncompressedSize })
    }

    const dataOffset = offset + 30 + nameLen + extraLen
    offset = dataOffset + compressedSize
    if (offset >= zipBuf.length) break
  }

  return files
}

// 从段落内容中提取所有 <w:t> 文本并拼接
function extractWtText(pContent) {
  const tRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/gi
  const texts = []
  let tMatch
  while ((tMatch = tRegex.exec(pContent)) !== null) {
    texts.push(tMatch[1])
  }
  return texts.join('').trim()
}

// 从 DOCX XML 中提取文本（解析 <w:p> 和 <w:tbl> 标签）
// 表格保留为 Markdown 表格格式，避免列关系丢失
function extractTextFromDocxXml(xml) {
  const blocks = []

  // 先按顶级块拆分：<w:p>(段落) 或 <w:tbl>(表格)
  const blockRegex = /<w:p[\s>][\s\S]*?<\/w:p>|<w:tbl[\s>][\s\S]*?<\/w:tbl>/gi
  let bMatch
  while ((bMatch = blockRegex.exec(xml)) !== null) {
    const block = bMatch[0]
    if (block.startsWith('<w:tbl')) {
      // 表格：提取行列，输出为 Markdown 表格
      const rows = []
      const trRegex = /<w:tr[\s>][\s\S]*?<\/w:tr>/gi
      let trMatch
      while ((trMatch = trRegex.exec(block)) !== null) {
        const cells = []
        const tcRegex = /<w:tc[\s>][\s\S]*?<\/w:tc>/gi
        let tcMatch
        while ((tcMatch = tcRegex.exec(trMatch[0])) !== null) {
          cells.push(extractWtText(tcMatch[0]))
        }
        if (cells.length > 0) rows.push(cells)
      }

      if (rows.length > 0) {
        const colCount = Math.max(...rows.map(r => r.length))
        const tableLines = []
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]
          // 补齐缺列
          while (row.length < colCount) row.push('')
          tableLines.push('| ' + row.join(' | ') + ' |')
          // 表头后加分隔线
          if (i === 0) {
            tableLines.push('| ' + row.map(() => '---').join(' | ') + ' |')
          }
        }
        blocks.push(tableLines.join('\n'))
      }
    } else {
      // 普通段落
      const text = extractWtText(block)
      if (text) blocks.push(text)
    }
  }

  return blocks.join('\n')
}

// 将 base64 还原为 Uint8Array
function base64ToBytes(base64) {
  if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_DOCX_BYTES * 4 / 3) + 16) {
    throw new Error('DOCX 文件超过大小限制')
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_DOCX_BYTES) throw new Error('DOCX 文件无效或超过大小限制')
  return bytes
}

// 解析 base64 编码的 .docx 文件，返回纯文本
export async function parseDocxFromBase64(base64Content) {
  const bytes = base64ToBytes(base64Content)
  const xml = await extractZipEntry(bytes, 'word/document.xml')
  const xmlStr = new TextDecoder().decode(xml)
  return extractTextFromDocxXml(xmlStr)
}

// 获取图片的 MIME 类型
function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase()
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' }
  return map[ext] || 'image/png'
}

// 用 LLM 描述图片（复用模型配置）
async function describeImageWithLLM(imageBytes, mimeType) {
  try {
    const { loadModelConfig, validateModelEndpoint } = await import('./llm-analyzer.mjs')
    const config = await loadModelConfig()
    if (!config.enabled || !config.apiKey) return null
    validateModelEndpoint(config.endpoint, config.provider)

    const base64 = Buffer.from(imageBytes).toString('base64')
    const dataUri = `data:${mimeType};base64,${base64}`

    // 根据 provider 调用不同 API
    if (config.provider === 'anthropic') {
      return await describeWithAnthropic(config, dataUri, mimeType)
    }
    if (config.provider === 'ollama') {
      return await describeWithOllama(config, dataUri)
    }
    return await describeWithOpenAI(config, dataUri)
  } catch (e) {
    console.warn('[knowledge-base] 图片描述失败:', e.message)
    return null
  }
}

// 自动拼接 /chat/completions — 兼容用户只填 base URL 的情况
function normalizeEndpoint(endpoint) {
  let trimmed = (endpoint || '').replace(/\/+$/, '')
  // 兼容误填的 OpenAI Responses API 路径（豆包等仅支持 chat/completions）
  trimmed = trimmed.replace(/\/responses(\/v1)?$/, '')
  if (trimmed.endsWith('/chat/completions')) return trimmed
  // 已带 API 版本段（/v1、/v3 等）时直接拼 /chat/completions
  if (/\/v\d+$/.test(trimmed)) return trimmed + '/chat/completions'
  return trimmed + '/v1/chat/completions'
}

function normalizeAnthropicEndpoint(endpoint) {
  const trimmed = (endpoint || '').replace(/\/+$/, '')
  if (trimmed.endsWith('/v1/messages') || trimmed.endsWith('/messages')) return trimmed
  if (trimmed.endsWith('/v1')) return trimmed + '/messages'
  return trimmed + '/v1/messages'
}

async function describeWithOpenAI(config, dataUri) {
  const endpoint = normalizeEndpoint(config.endpoint)
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '请用中文简要描述这张图片的内容，重点说明图片展示的屏幕状态、故障特征、位置、形状、颜色异常等信息。100字以内，只返回描述文字。' },
          { type: 'image_url', image_url: { url: dataUri, detail: 'low' } },
        ],
      }],
      temperature: 0.2,
      max_tokens: 256,
    }),
    signal: AbortSignal.timeout(120000),
    redirect: 'error',
  })
  if (!resp.ok) throw new Error(`API ${resp.status}`)
  const data = await resp.json()
  return (data.choices?.[0]?.message?.content || '').trim()
}

async function describeWithAnthropic(config, dataUri, mimeType) {
  const base64Data = dataUri.replace(/^data:image\/\w+;base64,/, '')
  const endpoint = normalizeAnthropicEndpoint(config.endpoint)
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 256,
      temperature: 0.2,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
          { type: 'text', text: '请用中文简要描述这张图片的内容，重点说明图片展示的屏幕状态、故障特征、位置、形状、颜色异常等信息。100字以内，只返回描述文字。' },
        ],
      }],
    }),
    signal: AbortSignal.timeout(120000),
    redirect: 'error',
  })
  if (!resp.ok) throw new Error(`API ${resp.status}`)
  const data = await resp.json()
  return (data.content?.[0]?.text || '').trim()
}

async function describeWithOllama(config, dataUri) {
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      messages: [{
        role: 'user',
        content: '请用中文简要描述这张图片的屏幕状态、故障位置与形状。100字以内。',
        images: [dataUri.replace(/^data:image\/\w+;base64,/, '')],
      }],
      options: { temperature: 0.2, num_predict: 256 },
    }),
    signal: AbortSignal.timeout(120000),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`API ${response.status}`)
  const data = await response.json()
  return (data.message?.content || '').trim()
}

// 提取 DOCX 中的图片并用 LLM 描述（并发控制）
async function extractAndDescribeImages(bytes) {
  const mediaFiles = listZipMediaFiles(bytes)
  if (mediaFiles.length === 0) return []

  const results = []
  const CONCURRENCY = 2

  for (let i = 0; i < mediaFiles.length; i += CONCURRENCY) {
    const batch = mediaFiles.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.allSettled(
      batch.map(async mf => {
        let data = mf.data
        if (mf.compression === 8) {
          data = await inflateLimited(mf.data, MAX_MEDIA_BYTES)
        }
        const mimeType = getMimeType(mf.name)
        const desc = await describeImageWithLLM(data, mimeType)
        return { name: mf.name, description: desc }
      })
    )
    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value.description) {
        results.push(r.value)
      }
    }
  }

  return results
}

// 构建增强文本（原始文字 + 图片描述）
function buildEnhancedText(docText, imageDescs) {
  if (!imageDescs || imageDescs.length === 0) return docText

  let enhanced = docText + '\n\n---\n【文档内图片描述】\n'
  for (let i = 0; i < imageDescs.length; i++) {
    const d = imageDescs[i]
    enhanced += `图片${i + 1} (${d.name}): ${d.description}\n`
  }
  return enhanced
}

// 解析上传的文档内容
function parseDocumentContent(raw, filename) {
  const ext = (filename || '').split('.').pop().toLowerCase()
  // .txt / .md - 纯文本
  if (ext === 'txt' || ext === 'md' || ext === 'text') {
    return { content: raw, type: 'text' }
  }
  // .json - 结构化数据
  if (ext === 'json') {
    try {
      const parsed = JSON.parse(raw)
      return { content: JSON.stringify(parsed, null, 2), type: 'json' }
    } catch {
      return { content: raw, type: 'text' }
    }
  }
  // .docx - raw 应为 base64 字符串（由调用方确保）
  if (ext === 'docx') {
    return { content: raw, type: 'docx', needsBase64Parse: true }
  }
  // 其他格式按纯文本处理
  return { content: raw, type: 'text' }
}

// 上传文档
export function uploadDocument(filename, rawContent) {
  return serializeMutation(() => uploadDocumentImpl(filename, rawContent))
}

async function uploadDocumentImpl(filename, rawContent) {
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 255 || !/\.(?:txt|md|json|docx)$/i.test(filename)) {
    throw new Error('文档名称无效，仅支持 txt、md、json、docx')
  }
  if (typeof rawContent !== 'string' || rawContent.length === 0) throw new Error('文档内容为空')
  if (!/\.docx$/i.test(filename) && rawContent.length > MAX_TEXT_CHARS) throw new Error('文本文档超过 5MB 限制')
  const db = await loadKB()
  const id = 'kb-' + crypto.randomUUID().slice(0, 8)
  let { content, type, needsBase64Parse } = parseDocumentContent(rawContent, filename)
  let imageCount = 0

  // 对 .docx 文件进行 ZIP 解压 + XML 解析 + 图片提取描述
  if (needsBase64Parse && type === 'docx') {
    const bytes = base64ToBytes(rawContent)
    const xml = await extractZipEntry(bytes, 'word/document.xml')
    const xmlStr = new TextDecoder().decode(xml)
    content = extractTextFromDocxXml(xmlStr)

    // 提取图片并用 LLM 描述
    const imageDescs = await extractAndDescribeImages(bytes)
    if (imageDescs.length > 0) {
      content = buildEnhancedText(content, imageDescs)
      imageCount = imageDescs.length
    }
  }

  // 保存原始文档
  const docFilename = `${id}.txt`
  const docPath = join(KB_DOCS_DIR, docFilename)
  await writeFile(docPath, content, { encoding: 'utf-8', mode: 0o600 })

  // 分块
  const rawChunks = chunkText(content)
  const chunks = rawChunks.map((text, i) => {
    const chunkId = `${id}-chunk-${i}`
    const tokens = tokenize(text)
    return {
      id: chunkId,
      docId: id,
      docName: filename,
      index: i,
      text,
      tokens,
    }
  })

  const doc = {
    id,
    name: filename,
    type,
    chunkCount: chunks.length,
    size: content.length,
    imageCount,
    createdAt: new Date().toISOString(),
  }

  db.documents.push(doc)
  db.chunks.push(...chunks)
  try {
    await saveKB(db)
  } catch (error) {
    db.documents = db.documents.filter(item => item.id !== id)
    db.chunks = db.chunks.filter(item => item.docId !== id)
    try { await unlink(docPath) } catch {}
    throw error
  }
  return doc
}

// 列出所有文档
export async function listDocuments() {
  const db = await loadKB()
  return db.documents.map(d => ({
    ...d,
    chunks: db.chunks.filter(c => c.docId === d.id).length,
  }))
}

// 获取单个文档详情
export async function getDocument(id) {
  const db = await loadKB()
  const doc = db.documents.find(d => d.id === id)
  if (!doc) return null
  const chunks = db.chunks.filter(c => c.docId === id).map(c => ({ id: c.id, index: c.index, text: c.text }))
  return { ...doc, chunks }
}

// 删除文档
export function deleteDocument(id) {
  return serializeMutation(() => deleteDocumentImpl(id))
}

async function deleteDocumentImpl(id) {
  const db = await loadKB()
  const idx = db.documents.findIndex(d => d.id === id)
  if (idx === -1) return false

  const previousDocuments = db.documents
  const previousChunks = db.chunks
  db.documents = db.documents.filter(d => d.id !== id)
  db.chunks = db.chunks.filter(c => c.docId !== id)
  try {
    await saveKB(db)
  } catch (error) {
    db.documents = previousDocuments
    db.chunks = previousChunks
    throw error
  }
  // 元数据成功提交后再清理正文；失败只会留下可安全回收的孤儿文件。
  const docPath = join(KB_DOCS_DIR, `${id}.txt`)
  try { await unlink(docPath) } catch {}
  return true
}

// 获取知识库统计
export async function getKBStats() {
  const db = await loadKB()
  return {
    documents: db.documents.length,
    chunks: db.chunks.length,
    totalChars: db.documents.reduce((sum, d) => sum + d.size, 0),
  }
}

// 搜索知识库
export async function searchKB(query, topK = 5) {
  if (!query || query.trim().length === 0) return []

  const db = await loadKB()
  if (db.chunks.length === 0) return []

  const queryTokens = tokenize(query)

  // 为每个分块计算相似度分数
  const scored = db.chunks.map(chunk => {
    // Jaccard 相似度
    const jaccard = jaccardSimilarity(queryTokens, chunk.tokens)

    // 关键词命中加分
    let keywordBonus = 0
    for (const qt of queryTokens) {
      if (chunk.text.includes(qt)) keywordBonus += 0.05
    }

    return {
      ...chunk,
      score: jaccard + Math.min(keywordBonus, 0.3),
    }
  })

  // 排序去重（同文档只取最高分的一块）
  const seenDocs = new Set()
  const results = []
  scored.sort((a, b) => b.score - a.score)

  for (const item of scored) {
    if (item.score <= 0) continue
    if (!seenDocs.has(item.docId)) {
      seenDocs.add(item.docId)
      results.push({
        docId: item.docId,
        docName: item.docName,
        chunkIndex: item.index,
        text: item.text,
        score: Math.round(item.score * 100),
      })
    }
    if (results.length >= topK) break
  }

  return results
}

// 构建知识库上下文文本（用于拼接到 LLM prompt 中）
export async function buildKBContext(query, maxChunks = 5) {
  const results = await searchKB(query, maxChunks)
  if (results.length === 0) return ''

  let context = '\n\n---\n【知识库参考资料】\n以下是从知识库中检索到的相关内容，请在分析时参考：\n\n'
  for (const r of results) {
    context += `[来源: ${r.docName}，相关度: ${r.score}%]\n${r.text}\n\n`
  }
  context += '---\n'
  return context
}
