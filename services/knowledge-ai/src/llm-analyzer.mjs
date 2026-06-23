import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(__dirname, '..', 'data', 'model-config.json')

// 默认配置
const DEFAULT_CONFIG = {
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: '',
  endpoint: 'https://api.openai.com/v1/chat/completions',
  temperature: 0.3,
  maxTokens: 4096,
  enabled: false,
  systemPrompt: '',
  kbEnabled: false,
  kbSearchQuery: '',
  kbMaxChunks: 5,
  showRagPanel: true,
  showAiPanel: true,
  annoFields: [
    { id: 'crackLocation', label: '屏损位置', type: 'tag-grid', required: true, options: ['天侧','地侧','左侧','右侧','四角区域','中央区域','全屏区域','局部不规则区域','__custom__'] },
    { id: 'crackShape', label: '屏损形态', type: 'tag-grid', required: true, options: ['单条线状屏裂','多条线状屏裂','点放射状屏裂','发散性线状屏裂','环状/圈状屏裂','网状(大面积无规则)屏裂','__custom__'] },
    { id: 'result', label: '鉴定结论', type: 'result-btns', required: false, options: [{value:'product_quality_issue',label:'产品质量问题',cls:'pq'},{value:'logistics_issue',label:'物流问题',cls:'logistics'},{value:'not_product_quality',label:'非产品质量问题',cls:'npq'},{value:'needs_further_review',label:'需进一步鉴定',cls:'review'}] },
    { id: 'installStatus', label: '安装状态', type: 'tag-grid', required: false, options: [{value:'installed',label:'已安装'},{value:'not_installed',label:'未安装'}] },
    { id: 'packageDamage', label: '包装状态', type: 'tag-grid', required: false, options: [{value:'none',label:'无损坏'},{value:'minor',label:'轻微损坏'},{value:'severe',label:'严重损坏'}] },
    { id: 'possibleCause', label: '可能原因', type: 'textarea', required: false },
    { id: 'warrantyTip', label: '鉴定结论', type: 'textarea', required: false },
    { id: 'title', label: '标题（可选）', type: 'input', required: false },
  ],
}

export async function loadModelConfig() {
  let config = { ...DEFAULT_CONFIG }
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8')
    config = { ...config, ...JSON.parse(raw) }
  } catch {
    // 配置文件不存在，使用默认值
  }
  // 优先使用配置文件中的 apiKey，为空时回退到环境变量
  if (!config.apiKey) {
    config.apiKey = process.env.LLM_API_KEY || ''
  }
  return config
}

export async function saveModelConfig(config) {
  const dir = dirname(CONFIG_PATH)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify({ ...DEFAULT_CONFIG, ...config }, null, 2), 'utf8')
}

// 构建分析 Prompt
function buildPrompt(config, imageCount = 1) {
  if (config.systemPrompt && config.systemPrompt.trim()) {
    return config.systemPrompt.trim()
  }
  const multiHint = imageCount > 1
    ? `请综合分析以下 ${imageCount} 张屏幕照片（这些照片来自同一台设备的不同角度或不同区域），识别屏损信息并以 JSON 格式返回：`
    : `你是一个专业的屏幕故障鉴定专家。请仔细分析这张屏幕照片，识别以下信息并以 JSON 格式返回：`

  return `${multiHint}

{
  "location": "屏损位置（从以下中选择一个：天侧、地侧、左侧右侧、四角区域、中央区域、全屏区域、局部不规则区域）",
  "locationConfidence": 0-100的置信度数字,
  "shape": "屏损形状（从以下中选择一个：单条线状屏裂、多条线状屏裂、点放射状屏裂、发散性线状屏裂、环状/圈状屏裂、网状(大面积无规则)屏裂）",
  "shapeConfidence": 0-100的置信度数字,
  "description": "用中文详细描述屏损情况。可使用 Markdown 格式：用 **粗体** 强调关键诊断结论，换行分段组织内容。包括：受力点位置、裂纹走向、损伤程度、可能的撞击痕迹等，150-300字",
  "severity": "轻微 | 中等 | 严重 | 极其严重"
}

请严格只返回 JSON，不要包含其他文字。`
}

// 构建安装/故障信息上下文文本
function buildContextFromForm(ctx) {
  if (!ctx) return ''
  const parts = []
  const statusMap = { not_installed: '未安装（开箱即发现）', installed: '已安装使用', unknown: '不确定' }
  const authMap = { yes: 'TCL 授权人员开箱', no: '非授权人员开箱', unknown: '不清楚' }
  const pkgMap = { none: '无破损', damaged: '有破损', unknown: '无法查看' }
  const linkMap = {
    product_factor: '产品因素', logistics_transport: '物流运输搬运',
    unboxing_install: '拆机验机安装', usage_mishandling: '使用保管不当', unknown: '不确定',
  }

  if (ctx.installStatus) parts.push(`- 安装状态：${statusMap[ctx.installStatus] || ctx.installStatus}`)
  if (ctx.authPersonnel) parts.push(`- 开箱人员：${authMap[ctx.authPersonnel] || ctx.authPersonnel}`)
  if (ctx.packageDamage) parts.push(`- 包装箱状态：${pkgMap[ctx.packageDamage] || ctx.packageDamage}`)
  if (ctx.faultLinks && ctx.faultLinks.length > 0) {
    parts.push(`- 故障涉及环节：${ctx.faultLinks.map(l => linkMap[l] || l).join('、')}`)
  }

  if (parts.length === 0) return ''
  return `\n\n【现场人工提供的信息】\n${parts.join('\n')}\n以上安装与故障信息仅供辅助参考，请优先依据图片本身进行专业分析。`
}

// 调用 OpenAI 兼容 API（GPT-4V / Qwen-VL / Ollama 等）
async function callOpenAI(config, imageBase64s, kbContext = '', caseContext = '', formContext = '') {
  const promptText = buildPrompt(config, imageBase64s.length) + caseContext + kbContext + formContext
  const imageBlocks = imageBase64s.map(img => ({ type: 'image_url', image_url: { url: img, detail: 'high' } }))
  const resp = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          ...imageBlocks,
        ],
      }],
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    }),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`API 调用失败 (${resp.status}): ${errText}`)
  }
  const data = await resp.json()
  const raw = data.choices?.[0]?.message?.content || ''
  return extractJSON(raw)
}

// OpenAI 流式调用，支持 token 级进度回调
async function callOpenAIStream(config, imageBase64s, kbContext, caseContext, onProgress, formContext = '') {
  const promptText = buildPrompt(config, imageBase64s.length) + caseContext + kbContext + formContext
  const imageBlocks = imageBase64s.map(img => ({ type: 'image_url', image_url: { url: img, detail: 'high' } }))
  const resp = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          ...imageBlocks,
        ],
      }],
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`API 调用失败 (${resp.status}): ${errText}`)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let tokenCount = 0
  const maxTokens = config.maxTokens || 4096
  let fullContent = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') continue

      try {
        const chunk = JSON.parse(data)
        const delta = chunk.choices?.[0]?.delta?.content
        if (delta) {
          tokenCount++
          fullContent += delta
          // token 进度: 25% ~ 88%，按已生成 token 占总上限比例映射
          if (tokenCount % 20 === 0) {
            const pct = Math.min(88, 25 + Math.round(tokenCount / maxTokens * 63))
            onProgress({ stage: 'llm', percent: pct, message: `大模型正在分析... 已生成 ${tokenCount} tokens` })
          }
        }
      } catch {
        // 跳过非 JSON 行
      }
    }
  }

  // 如果有剩余 buffer 未处理
  if (buffer.trim()) {
    const trimmed = buffer.trim()
    if (trimmed.startsWith('data: ')) {
      const data = trimmed.slice(6)
      if (data !== '[DONE]') {
        try {
          const chunk = JSON.parse(data)
          const delta = chunk.choices?.[0]?.delta?.content
          if (delta) fullContent += delta
        } catch { /* ignore */ }
      }
    }
  }

  return extractJSON(fullContent || '')
}

// 调用 Anthropic API（Claude 3）
async function callAnthropic(config, imageBase64s, kbContext = '', caseContext = '', formContext = '') {
  const promptText = buildPrompt(config, imageBase64s.length) + caseContext + kbContext + formContext
  const imageBlocks = imageBase64s.map(img => {
    const mediaType = img.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/png'
    const base64Data = img.replace(/^data:image\/\w+;base64,/, '')
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } }
  })

  const resp = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      system: promptText,
      messages: [{
        role: 'user',
        content: [
          ...imageBlocks,
          { type: 'text', text: '请分析这些屏幕照片并返回 JSON 结果。' },
        ],
      }],
    }),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`API 调用失败 (${resp.status}): ${errText}`)
  }
  const data = await resp.json()
  const raw = data.content?.[0]?.text || ''
  return extractJSON(raw)
}

// 调用 Ollama（本地模型，如 llava）
async function callOllama(config, imageBase64s, kbContext = '', caseContext = '', formContext = '') {
  const resp = await fetch(config.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      messages: [{
        role: 'user',
        content: buildPrompt(config, imageBase64s.length) + caseContext + kbContext + formContext,
        images: imageBase64s.length <= 1 ? [imageBase64s[0]] : imageBase64s,
      }],
      options: { temperature: config.temperature, num_predict: config.maxTokens },
    }),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`API 调用失败 (${resp.status}): ${errText}`)
  }
  const data = await resp.json()
  const raw = data.message?.content || ''
  return extractJSON(raw)
}

// 从 LLM 返回的文本中提取 JSON
function extractJSON(raw) {
  let text = raw.trim()

  // 去掉 markdown 代码块
  text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()

  // 尝试多次找到 JSON
  let result = null
  const tries = [
    text,                                                     // 原始
    text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1), // 提取花括号范围
  ]

  for (const t of tries) {
    if (!t || !t.includes('{')) continue
    try {
      result = JSON.parse(t)
      break
    } catch {
      // 尝试修复常见问题：未转义换行、尾部逗号
      try {
        const fixed = t
          .replace(/,\s*}/g, '}')
          .replace(/,\s*]/g, ']')
          .replace(/[\u0000-\u001F]/g, ' ')
        result = JSON.parse(fixed)
        break
      } catch {
        continue
      }
    }
  }

  // 如果 JSON 解析成功
  if (result) {
    return {
      location: result.location || '未知',
      locationConfidence: Math.min(100, Math.max(0, parseInt(result.locationConfidence) || 60)),
      shape: result.shape || '未知',
      shapeConfidence: Math.min(100, Math.max(0, parseInt(result.shapeConfidence) || 60)),
      description: result.description || '',
      severity: result.severity || '中等',
      source: 'llm',
    }
  }

  // JSON 解析全失败，尝试从纯文本中提取信息
  const locList = ['天侧', '地侧', '左侧右侧', '四角区域', '中央区域', '全屏区域', '局部不规则区域']
  const shapeList = ['单条线状屏裂', '多条线状屏裂', '点放射状屏裂', '发散性线状屏裂', '环状/圈状屏裂', '网状(大面积无规则)屏裂']

  let location = '未知', shape = '未知'
  for (const l of locList) {
    if (text.includes(l)) { location = l; break }
  }
  for (const s of shapeList) {
    if (text.includes(s)) { shape = s; break }
  }

  // 尝试从文本中提取置信度数字
  const locConfMatch = text.match(/(?:位置|location).*?(\d{1,3})/)
  const shapeConfMatch = text.match(/(?:形状|shape).*?(\d{1,3})/)
  const locConf = locConfMatch ? Math.min(100, parseInt(locConfMatch[1])) : 50
  const shapeConf = shapeConfMatch ? Math.min(100, parseInt(shapeConfMatch[1])) : 50

  // 提取严重程度
  let severity = '中等'
  if (text.includes('极其严重')) severity = '极其严重'
  else if (text.includes('严重')) severity = '严重'
  else if (text.includes('轻微')) severity = '轻微'

  // 清理描述（去除代码块标记等）
  const desc = text.replace(/[{}[\]"]/g, '').replace(/location|shape|confidence|severity|description/gi, '').trim().substring(0, 2000)

  return {
    location, locationConfidence: locConf,
    shape, shapeConfidence: shapeConf,
    description: desc || text.substring(0, 2000),
    severity,
    source: 'llm',
  }
}

/**
 * 基于图片向量检索获取相似案例，同时返回：
 * 1. 动态知识库查询词（用于 KB 文本检索）
 * 2. 相似案例参考上下文（注入 LLM prompt，让 LLM 参考案例库标注）
 *
 * 一次向量检索同时服务两个目的，避免重复 API 调用。
 */
async function buildSimilarCaseContext(imageBase64, config) {
  const result = {
    kbQuery: config.kbSearchQuery?.trim() || '屏损故障 鉴定 判定 屏裂 漏液 偏光片',
    caseContext: '',
  }

  try {
    const { searchByImage } = await import('./clip-client.mjs')
    const vecResult = await searchByImage(imageBase64, 5)

    if (!vecResult.results || vecResult.results.length === 0) {
      return result
    }

    // 构造动态 KB 查询词（Top-1 案例标签）
    if (!config.kbSearchQuery || !config.kbSearchQuery.trim()) {
      const top = vecResult.results[0]
      const meta = top.meta || {}
      const terms = [
        meta.crack_location || '',
        meta.crack_shape || '',
        meta.result_label || '',
      ].filter(Boolean)
      if (terms.length > 0) {
        result.kbQuery = terms.join(' ')
      }
    }

    // 构造相似案例参考上下文
    const { loadCases } = await import('./search-engine.mjs')
    const allCases = await loadCases()
    const caseMap = new Map(allCases.map(c => [c.id, c]))

    const similarCases = []
    for (const r of vecResult.results) {
      const c = caseMap.get(r.case_id)
      if (!c) continue
      similarCases.push({
        similarity: r.similarity,
        crackLocation: c.crackLocation || r.meta?.crack_location || '',
        crackShape: c.crackShape || r.meta?.crack_shape || '',
        possibleCause: c.possibleCause || '',
        warrantyTip: c.warrantyTip || '',
        resultLabel: c.resultLabel || r.meta?.result_label || '',
      })
    }

    if (similarCases.length > 0) {
      result.caseContext = '\n\n---\n【案例库相似案例参考（向量检索）】\n'
      result.caseContext += '以下是从案例库中检索到与当前图片视觉上最相似的案例标注信息，'
      result.caseContext += '请优先参考这些标注来分析当前图片：\n\n'

      for (let i = 0; i < similarCases.length; i++) {
        const c = similarCases[i]
        const simPct = (c.similarity * 100).toFixed(1)
        result.caseContext += `案例${i + 1}（图像相似度: ${simPct}%）:\n`
        if (c.crackLocation) result.caseContext += `  - 屏损位置: ${c.crackLocation}\n`
        if (c.crackShape) result.caseContext += `  - 屏损形态: ${c.crackShape}\n`
        if (c.possibleCause) result.caseContext += `  - 屏损原理: ${c.possibleCause}\n`
        if (c.warrantyTip) result.caseContext += `  - 保修提示: ${c.warrantyTip}\n`
        if (c.resultLabel) result.caseContext += `  - 鉴定结论: ${c.resultLabel}\n`
      }

      result.caseContext += '\n请综合案例库标注与图片实际观察进行判断。若案例标注与图片视觉特征存在明显差异，以图片为准。\n'
      result.caseContext += '---\n'
    }
  } catch (e) {
    console.warn('[llm-analyzer] 相似案例检索失败:', e.message)
  }

  return result
}

// 主入口：使用大模型分析图片
export async function analyzeWithLLM(imageBase64s, contextObj) {
  // 兼容单张图片（字符串）
  const images = Array.isArray(imageBase64s) ? imageBase64s : [imageBase64s]
  const context = buildContextFromForm(contextObj)
  const config = await loadModelConfig()
  if (!config.enabled || !config.apiKey) {
    throw new Error('大模型分析未启用或未配置 API Key，请在管理后台设置')
  }

  // 检索知识库 + 相似案例
  let kbContext = ''
  let caseContext = ''
  if (config.kbEnabled) {
    try {
      const { buildKBContext } = await import('./knowledge-base.mjs')
      const { kbQuery, caseContext: cCtx } = await buildSimilarCaseContext(images[0], config)
      caseContext = cCtx
      kbContext = await buildKBContext(kbQuery, config.kbMaxChunks || 5)
    } catch (e) {
      console.warn('[llm-analyzer] 知识库检索失败:', e.message)
    }
  }

  const start = Date.now()

  switch (config.provider) {
    case 'anthropic':
      return { ...await callAnthropic(config, images, kbContext, caseContext, context), elapsed: Date.now() - start, model: config.model }
    case 'ollama':
      return { ...await callOllama(config, images, kbContext, caseContext, context), elapsed: Date.now() - start, model: config.model }
    case 'openai':
    default:
      return { ...await callOpenAI(config, images, kbContext, caseContext, context), elapsed: Date.now() - start, model: config.model }
  }
}

// 流式分析（带真实进度回调），用于 SSE 推送
export async function analyzeWithLLMStream(imageBase64s, onProgress, contextObj) {
  // 兼容单张图片（字符串）
  const images = Array.isArray(imageBase64s) ? imageBase64s : [imageBase64s]
  const config = await loadModelConfig()
  const context = buildContextFromForm(contextObj)
  if (!config.enabled || !config.apiKey) {
    throw new Error('大模型分析未启用或未配置 API Key，请在管理后台设置')
  }

  onProgress({ stage: 'init', percent: 5, message: '正在加载模型配置...' })

  // 检索知识库 + 相似案例
  let kbContext = ''
  let caseContext = ''
  if (config.kbEnabled) {
    onProgress({ stage: 'kb', percent: 10, message: '正在检索知识库与相似案例...' })
    try {
      const { buildKBContext } = await import('./knowledge-base.mjs')
      const { kbQuery, caseContext: cCtx } = await buildSimilarCaseContext(images[0], config)
      caseContext = cCtx
      kbContext = await buildKBContext(kbQuery, config.kbMaxChunks || 5)
      onProgress({ stage: 'kb_done', percent: 15, message: `知识库检索完成，命中 ${kbContext ? '相关' : '0 条'}内容，${caseContext ? '已获取相似案例' : '无相似案例'}` })
    } catch (e) {
      console.warn('[llm-analyzer] 知识库检索失败:', e.message)
      onProgress({ stage: 'kb_done', percent: 15, message: '知识库检索跳过' })
    }
  } else {
    onProgress({ stage: 'init', percent: 10, message: '模型配置已就绪...' })
  }

  onProgress({ stage: 'sending', percent: 20, message: '正在发送图片到大模型...' })

  const start = Date.now()

  // OpenAI 走流式 API，可获得真实 token 生成进度
  if (config.provider === 'openai') {
    const result = await callOpenAIStream(config, images, kbContext, caseContext, onProgress, context)
    onProgress({ stage: 'parse', percent: 92, message: '正在解析分析结果...' })
    return { ...result, elapsed: Date.now() - start, model: config.model }
  }

  // Anthropic / Ollama 等非流式，报告等待状态
  onProgress({ stage: 'llm', percent: 30, message: '大模型正在分析图片...' })

  let result
  switch (config.provider) {
    case 'anthropic':
      result = await callAnthropic(config, images, kbContext, caseContext, context)
      break
    case 'ollama':
      result = await callOllama(config, images, kbContext, caseContext, context)
      break
    default:
      result = await callOpenAI(config, images, kbContext, caseContext, context)
  }

  onProgress({ stage: 'parse', percent: 92, message: '正在解析分析结果...' })
  return { ...result, elapsed: Date.now() - start, model: config.model }
}
