import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeEvalField } from './field-normalize.mjs'

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
  kbEnabled: true,
  kbSearchQuery: '',
  kbMaxChunks: 5,
  showRagPanel: true,
  showAiPanel: true,
  analysisMode: 'hybrid', // 默认分析模式: hybrid=RAG+LLM 混合 | rag=仅RAG识别 | llm=仅LLM识别
  annoFields: [
    { id: 'title', label: '标题（可选）', type: 'input', required: false },
    { id: 'crackLocation', label: '屏损位置', type: 'tag-grid', required: true, options: ['天侧','地侧','左侧','右侧','四角区域','中央区域','全屏区域','局部不规则区域','__custom__'] },
    { id: 'crackShape', label: '屏损形态', type: 'tag-grid', required: true, options: ['单条线状屏裂','多条线状屏裂','点放射状屏裂','发散性线状屏裂','环状/圈状屏裂','网状(大面积无规则)屏裂','__custom__'] },
    { id: 'crackStage', label: '屏损环节', type: 'tag-grid', required: false, options: ['产品因素','物流运输搬运','拆机验机安装','使用保管不当','__custom__'] },
    { id: 'result', label: '鉴定结论', type: 'result-btns', required: false, options: [{value:'product_quality_issue',label:'质量问题',cls:'pq'},{value:'not_product_quality',label:'非质量问题',cls:'npq'},{value:'no_damage',label:'屏幕完好',cls:''}] },
    { id: 'installStatus', label: '安装状态', type: 'tag-grid', required: false, options: [{value:'installed',label:'已安装'},{value:'not_installed',label:'未安装'}] },
    { id: 'packageDamage', label: '包装状态', type: 'tag-grid', required: false, options: [{value:'none',label:'无损坏'},{value:'minor',label:'轻微损坏'},{value:'severe',label:'严重损坏'}] },
    { id: 'crackPrinciple', label: '屏损原理', type: 'textarea', required: false },
    { id: 'remark', label: '问题备注', type: 'textarea', required: false },
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

// ===== 标注模型独立配置 =====

const ANNO_CONFIG_PATH = join(__dirname, '..', 'data', 'annotation-config.json')

const DEFAULT_ANNO_CONFIG = {
  provider: 'openai',
  model: 'deepseek-chat',
  apiKey: '',
  endpoint: 'https://api.deepseek.com',
  temperature: 0.3,
  maxTokens: 1024,
  enabled: true,
  systemPrompt: '',
  analysisMode: 'hybrid', // 标注分析模式: hybrid=RAG+LLM 混合 | llm=仅LLM标注 | rag=仅RAG识别
}

export async function loadAnnotationConfig() {
  let config = { ...DEFAULT_ANNO_CONFIG }
  try {
    const raw = await readFile(ANNO_CONFIG_PATH, 'utf8')
    config = { ...config, ...JSON.parse(raw) }
  } catch {
    // 配置文件不存在，使用默认值
  }
  // apiKey 为空时回退到环境变量
  if (!config.apiKey) {
    config.apiKey = process.env.LLM_ANNO_API_KEY || process.env.LLM_API_KEY || ''
  }
  return config
}

export async function saveAnnotationConfig(config) {
  const dir = dirname(ANNO_CONFIG_PATH)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  await writeFile(ANNO_CONFIG_PATH, JSON.stringify({ ...DEFAULT_ANNO_CONFIG, ...config }, null, 2), 'utf8')
}

// 构建分析 Prompt（始终输出 JSON 格式提示，确保后端能解析）
function buildPrompt(config, imageCount = 1) {
  if (config.systemPrompt && config.systemPrompt.trim()) {
    // 有自定义 systemPrompt → 模型按 system 角色的分析框架来，但输出用 JSON 格式
    return `请严格按照系统提示词中的角色定位、知识体系和工作流程进行分析。

将分析结果以 JSON 格式返回，所有详细分析内容（状态观察、屏损现象、屏损原理、屏损环节、鉴定结论等）合并放入 description 字段，同时按以下结构单独给出结构化字段供系统解析：

{
  "location": "屏损位置（从以下中选择一个：天侧、地侧、左侧、右侧、四角区域、中央区域、全屏区域、局部不规则区域）",
  "locationConfidence": 0-100的置信度数字,
  "shape": "屏损形态（从以下中选择一个：单条线状屏裂、多条线状屏裂、点放射状屏裂、发散性线状屏裂、环状/圈状屏裂、网状(大面积无规则)屏裂、漏液、熔屏）",
  "shapeConfidence": 0-100的置信度数字,
  "stage": "故障环节（从以下中选择一个：产品因素、物流运输搬运、拆机验机安装、使用保管不当；无法判断填\"无\"）",
  "conclusion": "鉴定结论（从以下中选择一个：质量问题、非质量问题、屏幕完好）",
  "statusObs": "状态观察（屏幕安装状态、保护膜情况、有无外部损伤痕迹等，一句话）",
  "principle": "故障原理（简要描述损伤的形成机理和原因，一句话）",
  "description": "请按系统提示词要求的格式输出详细分析（状态观察、屏损现象、屏损原理、屏损环节、鉴定结论），可使用 Markdown 格式",
  "severity": "轻微 | 中等 | 严重 | 极其严重"
}

请严格只返回 JSON，不要包含其他文字。`
  }
  const multiHint = imageCount > 1
    ? `请综合分析以下 ${imageCount} 张屏幕照片（这些照片来自同一台设备的不同角度或不同区域），识别屏损信息并以 JSON 格式返回：`
    : `你是一个专业的屏幕故障鉴定专家。请仔细分析这张屏幕照片，识别以下信息并以 JSON 格式返回：`

  return `${multiHint}

**重要：请先根据电视机边框、品牌 logo、底座/支架位置判断屏幕正方向（哪边是"天侧/上方"），照片可能倒置或旋转。所有位置判断必须基于屏幕正方向。**

{
  "location": "屏损位置（从以下中选择一个：天侧、地侧、左侧、右侧、四角区域、中央区域、全屏区域、局部不规则区域）",
  "locationConfidence": 0-100的置信度数字,
  "shape": "屏损形状（从以下中选择一个：单条线状屏裂、多条线状屏裂、点放射状屏裂、发散性线状屏裂、环状/圈状屏裂、网状(大面积无规则)屏裂、漏液、熔屏）",
  "shapeConfidence": 0-100的置信度数字,
  "stage": "故障环节（从以下中选择一个：产品因素、物流运输搬运、拆机验机安装、使用保管不当；无法判断填\"无\"）",
  "conclusion": "鉴定结论（从以下中选择一个：质量问题、非质量问题、屏幕完好）",
  "statusObs": "状态观察（屏幕安装状态、保护膜情况、有无外部损伤痕迹等，一句话）",
  "principle": "故障原理（简要描述损伤的形成机理和原因，一句话）",
  "description": "用中文详细描述屏损情况。可使用 Markdown 格式：用 **粗体** 强调关键诊断结论，换行分段组织内容。包括：受力点位置、裂纹走向、损伤程度、可能的撞击痕迹等，150-300字",
  "severity": "轻微 | 中等 | 严重 | 极其严重"
}

请严格只返回 JSON，不要包含其他文字。`
}

// 获取 system 角色提示词（如果有自定义配置）
function buildSystemPrompt(config) {
  if (config.systemPrompt && config.systemPrompt.trim()) {
    return config.systemPrompt.trim()
  }
  return null
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

// 调用 OpenAI 兼容 API（GPT-4V / Qwen-VL / Ollama 等）
async function callOpenAI(config, imageBase64s, kbContext = '', caseContext = '', formContext = '', signal = null) {
  const promptText = buildPrompt(config, imageBase64s.length) + caseContext + kbContext + formContext
  const imageBlocks = imageBase64s.map(img => ({ type: 'image_url', image_url: { url: img, detail: 'high' } }))
  const messages = []
  const sysPrompt = buildSystemPrompt(config)
  if (sysPrompt) messages.push({ role: 'system', content: sysPrompt })
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: promptText },
      ...imageBlocks,
    ],
  })
  // 120 秒超时（已关闭深度思考）
  const timeoutSignal = AbortSignal.timeout(120000)
  const effectiveSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal
  const resp = await fetch(normalizeEndpoint(config.endpoint), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      thinking: { type: 'disabled' },
    }),
    signal: effectiveSignal,
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
  const messages = []
  const sysPrompt = buildSystemPrompt(config)
  if (sysPrompt) messages.push({ role: 'system', content: sysPrompt })
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: promptText },
      ...imageBlocks,
    ],
  })
  // 120 秒超时（已关闭深度思考，速度快很多）
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(new Error('LLM 流式请求超时 (120s)')), 120000)
  const resp = await fetch(normalizeEndpoint(config.endpoint), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      stream_options: { include_usage: true },
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      thinking: { type: 'disabled' },
    }),
    signal: controller.signal,
  })

  clearTimeout(timeoutId)

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
          // 每 10 tokens 推送一次 token 流 + 进度
          if (tokenCount % 10 === 0) {
            const pct = Math.min(88, 25 + Math.round(tokenCount / maxTokens * 63))
            onProgress({ stage: 'token', percent: pct, token: fullContent.slice(-200), message: `大模型正在分析... 已生成 ${tokenCount} tokens` })
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

  const resp = await fetch(normalizeEndpoint(config.endpoint), {
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

// 从纯文本中按标签提取字段值（如 "**故障环节**：产品因素"）
function extractLabeledText(text, label) {
  const re = new RegExp(`\\*{0,2}${label}\\*{0,2}[：:]\\s*([^\\n]{0,120})`)
  const m = text.match(re)
  if (!m) return ''
  return m[1].replace(/\*+/g, '').trim()
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
      location: normalizeEvalField('location', result.location) || '未知',
      locationConfidence: Math.min(100, Math.max(0, parseInt(result.locationConfidence) || 60)),
      shape: normalizeEvalField('shape', result.shape) || '未知',
      shapeConfidence: Math.min(100, Math.max(0, parseInt(result.shapeConfidence) || 60)),
      stage: normalizeEvalField('stage', result.stage),
      conclusion: normalizeEvalField('conclusion', result.conclusion),
      statusObs: typeof result.statusObs === 'string' ? result.statusObs.trim() : '',
      principle: typeof result.principle === 'string' ? result.principle.trim() : '',
      description: result.description || '',
      severity: result.severity || '中等',
      source: 'llm',
    }
  }

  // JSON 解析全失败，尝试从纯文本中提取信息
  const locList = ['天侧', '地侧', '左侧', '右侧', '四角区域', '中央区域', '全屏区域', '局部不规则区域']
  const shapeList = ['单条线状屏裂', '多条线状屏裂', '点放射状屏裂', '发散性线状屏裂', '环状/圈状屏裂', '网状(大面积无规则)屏裂', '漏液', '熔屏']

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

  // 提取结构化字段（状态观察/故障原理/故障环节/鉴定结论）
  const stage = normalizeEvalField('stage', extractLabeledText(text, '故障环节'))
  const conclusion = normalizeEvalField('conclusion', extractLabeledText(text, '鉴定结论'))
  const statusObs = extractLabeledText(text, '状态观察')
  const principle = extractLabeledText(text, '故障原理')

  // 清理描述（去除代码块标记等）
  const desc = text.replace(/[{}[\]"]/g, '').replace(/location|shape|severity|description/gi, '').trim().substring(0, 2000)

  return {
    location: normalizeEvalField('location', location) || '未知',
    locationConfidence: locConf,
    shape: normalizeEvalField('shape', shape) || '未知',
    shapeConfidence: shapeConf,
    stage,
    conclusion,
    statusObs,
    principle,
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
        crackPrinciple: c.crackPrinciple || '',
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
        if (c.crackPrinciple) result.caseContext += `  - 屏损原理: ${c.crackPrinciple}\n`
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
export async function analyzeWithLLM(imageBase64s, contextObj, signal = null, options = {}) {
  // 兼容单张图片（字符串）
  const images = Array.isArray(imageBase64s) ? imageBase64s : [imageBase64s]
  const context = buildContextFromForm(contextObj)
  const config = await loadModelConfig()
  if (!config.enabled || !config.apiKey) {
    throw new Error('大模型分析未启用或未配置 API Key，请在管理后台设置')
  }

  // 检查是否已被中断
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  // 检索知识库 + 相似案例（仅LLM模式跳过 RAG 上下文注入）
  let kbContext = ''
  let caseContext = ''
  if (config.kbEnabled && !options.skipRag) {
    try {
      const { buildKBContext } = await import('./knowledge-base.mjs')
      const { kbQuery, caseContext: cCtx } = await buildSimilarCaseContext(images[0], config)
      caseContext = cCtx
      kbContext = await buildKBContext(kbQuery, config.kbMaxChunks || 5)
    } catch (e) {
      console.warn('[llm-analyzer] 知识库检索失败:', e.message)
    }
  }

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const start = Date.now()

  switch (config.provider) {
    case 'anthropic':
      return { ...await callAnthropic(config, images, kbContext, caseContext, context), elapsed: Date.now() - start, model: config.model }
    case 'ollama':
      return { ...await callOllama(config, images, kbContext, caseContext, context), elapsed: Date.now() - start, model: config.model }
    case 'openai':
    default:
      return { ...await callOpenAI(config, images, kbContext, caseContext, context, signal), elapsed: Date.now() - start, model: config.model }
  }
}

// 流式分析（带真实进度回调），用于 SSE 推送
export async function analyzeWithLLMStream(imageBase64s, onProgress, contextObj, options = {}) {
  // 兼容单张图片（字符串）
  const images = Array.isArray(imageBase64s) ? imageBase64s : [imageBase64s]
  const config = await loadModelConfig()
  const context = buildContextFromForm(contextObj)
  if (!config.enabled || !config.apiKey) {
    throw new Error('大模型分析未启用或未配置 API Key，请在管理后台设置')
  }

  onProgress({ stage: 'init', percent: 5, message: '正在加载模型配置...' })

  // 检索知识库 + 相似案例（仅LLM模式跳过 RAG 上下文注入）
  let kbContext = ''
  let caseContext = ''
  if (config.kbEnabled && !options.skipRag) {
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
    onProgress({ stage: 'init', percent: 10, message: options.skipRag ? '已跳过知识库检索（纯 LLM 模式）' : '模型配置已就绪...' })
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

// ===== 案例标注专用 Prompt（返回管理后台所需的 tags 字段） =====
function buildAnnotationPrompt(config = {}, ragContext = '') {
  const systemPrompt = config.systemPrompt && config.systemPrompt.trim()
    ? config.systemPrompt.trim()
    : `你是一个专业的屏幕故障案例标注专家。请分析这张屏幕照片，为案例库生成标注信息，严格以 JSON 格式返回：

{
  "crackLocation": "屏损位置（从以下选择一个：天侧、地侧、左侧、右侧、四角区域、中央区域、全屏区域、局部不规则区域）",
  "crackShape": "屏损形态（从以下选择一个：单条线状屏裂、多条线状屏裂、点放射状屏裂、发散性线状屏裂、环状/圈状屏裂、网状(大面积无规则)屏裂）",
  "crackPrinciple": "屏损原理（30-80字，仅基于图片可见痕迹推断，格式如"右下角存在明显磕碰点，放射状裂纹由此发散"）",
  "crackStage": "屏损环节（从以下选择一个：产品因素、物流运输搬运、拆机验机安装、使用保管不当）",
  "result": "鉴定结论（从以下选择一个：product_quality_issue、not_product_quality、no_damage）",
  "summary": "一句话摘要（格式：\"屏损位置: XX, 形状: XX\"，15-30字）"
}

注意：
- **首先根据电视机边框、品牌logo、底座/支架位置判断屏幕正方向（照片可能倒置或旋转），位置判断必须基于屏幕正方向。**
- crackLocation 和 crackShape 必须从给定选项中选择，不得编造
- result 映射关系：外力痕迹明显 → not_product_quality；无外力痕迹且有产品缺陷特征 → product_quality_issue；无任何损伤痕迹 → no_damage
- crackPrinciple 仅描述图片可见痕迹（如"右下角存在明显磕碰点，放射状裂纹由此发散"），不要写"可能是用户..."这类猜测`;
  let userMessage = '请分析这张屏幕照片生成标注。注意：crackPrinciple 是分析"为什么会坏"（成因推断），不是描述"坏了什么样子"（状态描述）。严格只返回 JSON，不要包含其他文字。'
  if (ragContext) {
    userMessage += `\n\n【相似案例参考（向量检索聚合结果，仅作参考）】\n${ragContext}\n请结合参考信息判断，但最终以图片实际内容为准。`
  }
  return { systemPrompt, userMessage }
}

// 调用大模型生成案例标注
async function callLLMForAnnotation(config, imageBase64, ragContext = '') {
  const { systemPrompt, userMessage } = buildAnnotationPrompt(config, ragContext)
  const messages = []
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: userMessage },
      { type: 'image_url', image_url: { url: imageBase64, detail: 'high' } },
    ],
  })
  const resp = await fetch(normalizeEndpoint(config.endpoint), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: messages,
      temperature: config.temperature,
      max_tokens: Math.min(config.maxTokens, 2048),
    }),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`API 调用失败 (${resp.status}): ${errText}`)
  }
  const data = await resp.json()
  const raw = data.choices?.[0]?.message?.content || ''
  return extractAnnotationJSON(raw)
}

function extractAnnotationJSON(raw) {
  let text = raw.trim()
  text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()

  let result = null
  const tries = [
    text,
    text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1),
  ]

  for (const t of tries) {
    if (!t || !t.includes('{')) continue
    try { result = JSON.parse(t); break } catch {
      try {
        const fixed = t.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']').replace(/[\u0000-\u001F]/g, ' ')
        result = JSON.parse(fixed); break
      } catch { continue }
    }
  }

  if (!result) {
    return { crackLocation: '', crackShape: '', crackPrinciple: '', crackStage: '', result: '', summary: '' }
  }

  // 透传 LLM 返回的所有字段，保持与前端 annoFields 的 id 对齐
  return {
    crackLocation: result.crackLocation || '',
    crackShape: result.crackShape || '',
    crackPrinciple: result.crackPrinciple || '',
    crackStage: result.crackStage || '',
    result: result.result || '',
    summary: result.summary || '',
  }
}

// 将 RAG 聚合结果映射为标注字段
function ragResultToAnnotation(rag) {
  return {
    crackLocation: rag.location || '',
    crackShape: rag.shape || '',
    crackPrinciple: rag.principle || '',
    crackStage: rag.stage || '',
    result: rag.conclusion || '',
    summary: rag.description || '',
  }
}

// 生成注入给 LLM 的相似案例参考文本
function buildRAGContextText(rag) {
  if (!rag) return ''
  const lines = []
  if (rag.location) lines.push(`屏损位置: ${rag.location}`)
  if (rag.shape) lines.push(`屏损形态: ${rag.shape}`)
  if (rag.stage) lines.push(`屏损环节: ${rag.stage}`)
  if (rag.conclusion) lines.push(`鉴定结论: ${rag.conclusion}`)
  if (rag.principle) lines.push(`屏损原理: ${rag.principle}`)
  if (rag.matchedCaseTitle) lines.push(`最相似案例: ${rag.matchedCaseTitle}（相似度 ${rag.confidence}%）`)
  return lines.join('\n')
}

// 按标注分析模式对单张图片生成标注：rag=仅RAG聚合 | llm=仅LLM | hybrid=RAG参考+LLM
async function annotateImageByMode(config, imageBase64) {
  const mode = config.analysisMode || 'hybrid'

  // RAG 检索相似案例（hybrid 与 rag 模式都会用到）
  let rag = null
  if (mode !== 'llm') {
    try {
      const { analyzeWithRAG } = await import('./search-engine.mjs')
      rag = await analyzeWithRAG(imageBase64, 5)
    } catch {
      rag = null
    }
  }

  if (mode === 'rag') {
    if (!rag || (!rag.location && !rag.shape && !rag.stage && !rag.conclusion && !rag.principle)) {
      throw new Error('RAG 模式未检索到足够相似的案例，请先重建向量索引，或切换为 LLM/混合模式')
    }
    return { ...ragResultToAnnotation(rag), source: 'rag', rag }
  }

  // llm 或 hybrid：调用大模型；hybrid 时注入 RAG 聚合结果作为参考
  const ragContext = mode === 'hybrid' ? buildRAGContextText(rag) : ''
  const result = await callLLMForAnnotation(config, imageBase64, ragContext)
  return { ...result, source: mode === 'hybrid' ? 'hybrid' : 'llm', rag: rag || null }
}

/**
 * 单张图片 AI 辅助标注（供案例编辑器使用）
 */
export async function annotateSingle(imageBase64) {
  const config = await loadAnnotationConfig()
  const needsLLM = (config.analysisMode || 'hybrid') !== 'rag'
  if (!config.enabled || (needsLLM && !config.apiKey)) {
    throw new Error('标注模型未启用或未配置 API Key')
  }
  const start = Date.now()
  const result = await annotateImageByMode(config, imageBase64)
  return { ...result, elapsed: Date.now() - start, model: config.model }
}

/**
 * 批量图片 AI 预标注
 * @param {string[]} imageBase64List - base64 图片数组
 * @returns {Promise<{annotations: object[], elapsed: number, total: number}>}
 */
export async function annotateBatch(imageBase64List) {
  const config = await loadAnnotationConfig()
  const needsLLM = (config.analysisMode || 'hybrid') !== 'rag'
  if (!config.enabled || (needsLLM && !config.apiKey)) {
    throw new Error('标注模型未启用或未配置 API Key')
  }
  const start = Date.now()
  const annotations = []

  for (let i = 0; i < imageBase64List.length; i++) {
    try {
      const result = await annotateImageByMode(config, imageBase64List[i])
      annotations.push({ index: i, ...result, success: true })
    } catch (e) {
      annotations.push({ index: i, success: false, error: e.message })
    }
  }

  return { annotations, elapsed: Date.now() - start, total: imageBase64List.length }
}
