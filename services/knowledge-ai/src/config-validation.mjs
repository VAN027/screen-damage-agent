import { validateModelEndpoint } from './llm-analyzer.mjs'

function boundedRequestString(value, field, maxLength) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw Object.assign(new Error(`${field} 必须是字符串`), { statusCode: 400, code: 'INVALID_FORMAT', expose: true })
  const normalized = value.trim()
  if (normalized.length > maxLength) throw Object.assign(new Error(`${field} 超过 ${maxLength} 个字符上限`), { statusCode: 400, code: 'INVALID_FORMAT', expose: true })
  return normalized
}

function configRequestError(message) {
  const error = new Error(message)
  error.statusCode = 400
  error.code = 'INVALID_MODEL_CONFIG'
  error.expose = true
  return error
}

export function sanitizeAnnotationFields(value) {
  if (!Array.isArray(value) || value.length > 50) throw configRequestError('annoFields 必须是不超过 50 项的数组')
  const ids = new Set()
  return value.map((field, index) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) throw configRequestError(`第 ${index + 1} 个标注字段无效`)
    const id = boundedRequestString(field.id, `annoFields[${index}].id`, 64)
    const label = boundedRequestString(field.label, `annoFields[${index}].label`, 100)
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || ids.has(id)) throw configRequestError(`标注字段 ID "${id}" 无效或重复`)
    ids.add(id)
    if (!['tag-grid', 'result-btns', 'textarea', 'input'].includes(field.type)) throw configRequestError(`标注字段 "${id}" 类型无效`)
    const sanitized = { id, label, type: field.type, required: field.required === true }
    if (['tag-grid', 'result-btns'].includes(field.type)) {
      if (!Array.isArray(field.options) || field.options.length === 0 || field.options.length > 50) throw configRequestError(`标注字段 "${id}" 的选项数量无效`)
      sanitized.options = field.options.map((option, optionIndex) => {
        if (typeof option === 'string') return boundedRequestString(option, `${id}.options[${optionIndex}]`, 100)
        if (!option || typeof option !== 'object' || Array.isArray(option)) throw configRequestError(`标注字段 "${id}" 存在无效选项`)
        return {
          value: boundedRequestString(option.value, `${id}.options[${optionIndex}].value`, 100),
          label: boundedRequestString(option.label, `${id}.options[${optionIndex}].label`, 100),
          ...(option.cls === undefined ? {} : { cls: boundedRequestString(option.cls, `${id}.options[${optionIndex}].cls`, 32) }),
        }
      })
    }
    return sanitized
  })
}

/**
 * 生成可持久化的模型配置。当 provider/endpoint 改变时，旧密钥绝不会被带到新端点。
 */
export function buildSafeConfigUpdate(current, body, kind) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw configRequestError('模型配置必须是对象')
  const modelFields = new Set([
    'provider', 'model', 'apiKey', 'endpoint', 'temperature', 'maxTokens', 'enabled', 'systemPrompt',
    'kbEnabled', 'kbSearchQuery', 'kbMaxChunks', 'showRagPanel', 'showAiPanel', 'analysisMode', 'orientationMode', 'annoFields',
  ])
  const annotationFields = new Set(['provider', 'model', 'apiKey', 'endpoint', 'temperature', 'maxTokens', 'enabled', 'systemPrompt', 'analysisMode'])
  const allowed = kind === 'annotation' ? annotationFields : modelFields
  const updated = { ...current }
  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, field) && field !== 'apiKey') updated[field] = body[field]
  }

  updated.provider = boundedRequestString(updated.provider, 'provider', 32)
  updated.model = boundedRequestString(updated.model, 'model', 200)
  updated.endpoint = boundedRequestString(updated.endpoint, 'endpoint', 2048)
  updated.systemPrompt = boundedRequestString(updated.systemPrompt, 'systemPrompt', 20_000)
  if (!updated.model || !updated.endpoint) throw configRequestError('model 和 endpoint 不能为空')
  if (!['openai', 'anthropic', 'ollama'].includes(updated.provider)) throw configRequestError('provider 不受支持')
  if (typeof updated.enabled !== 'boolean') throw configRequestError('enabled 必须是布尔值')
  if (typeof updated.temperature !== 'number' || !Number.isFinite(updated.temperature) || updated.temperature < 0 || updated.temperature > 2) throw configRequestError('temperature 必须在 0-2 之间')
  if (!Number.isInteger(updated.maxTokens) || updated.maxTokens < 1 || updated.maxTokens > 32768) throw configRequestError('maxTokens 必须是 1-32768 的整数')
  if (!['hybrid', 'rag', 'llm'].includes(updated.analysisMode)) throw configRequestError('analysisMode 无效')

  if (kind === 'model') {
    for (const field of ['kbEnabled', 'showRagPanel', 'showAiPanel']) {
      if (typeof updated[field] !== 'boolean') throw configRequestError(`${field} 必须是布尔值`)
    }
    updated.kbSearchQuery = boundedRequestString(updated.kbSearchQuery, 'kbSearchQuery', 2000)
    if (!Number.isInteger(updated.kbMaxChunks) || updated.kbMaxChunks < 1 || updated.kbMaxChunks > 20) throw configRequestError('kbMaxChunks 必须是 1-20 的整数')
    if (updated.orientationMode === undefined) updated.orientationMode = 'auto'
    if (!['auto', 'manual'].includes(updated.orientationMode)) throw configRequestError('orientationMode 无效')
    if (Object.prototype.hasOwnProperty.call(body, 'annoFields')) updated.annoFields = sanitizeAnnotationFields(body.annoFields)
  }

  const identityChanged = current.provider !== updated.provider ||
    String(current.endpoint || '').replace(/\/+$/, '') !== updated.endpoint.replace(/\/+$/, '')
  const keyWasProvided = Object.prototype.hasOwnProperty.call(body, 'apiKey')
  if (keyWasProvided && typeof body.apiKey !== 'string') throw configRequestError('apiKey 必须是字符串')
  const rawKey = keyWasProvided ? body.apiKey.trim() : ''
  if (rawKey.length > 4096) throw configRequestError('apiKey 超过长度限制')
  const freshKey = rawKey && !rawKey.includes('****') ? rawKey : ''

  if (identityChanged) {
    if (updated.provider !== 'ollama' && updated.enabled && !freshKey) {
      throw configRequestError('更改 provider 或 endpoint 时必须重新输入未脱敏的 API Key')
    }
    updated.apiKey = freshKey
    updated.inheritEnvApiKey = false
  } else if (keyWasProvided && !rawKey.includes('****')) {
    updated.apiKey = rawKey
    updated.inheritEnvApiKey = false
  } else if (current.__apiKeyFromEnv) {
    // 保持环境变量引用，但绝不把环境密钥因普通配置保存而落盘。
    updated.apiKey = ''
    updated.inheritEnvApiKey = true
  } else {
    updated.apiKey = current.apiKey || ''
    updated.inheritEnvApiKey = current.inheritEnvApiKey !== false
  }

  const environmentKey = kind === 'annotation'
    ? (process.env.LLM_ANNO_API_KEY || process.env.LLM_API_KEY || '')
    : (process.env.LLM_API_KEY || '')
  const hasEffectiveKey = Boolean(updated.apiKey || (updated.inheritEnvApiKey !== false && environmentKey))
  if (updated.enabled && updated.provider !== 'ollama' && !hasEffectiveKey) throw configRequestError('启用模型前必须配置 API Key')

  try { validateModelEndpoint(updated.endpoint, updated.provider) }
  catch (error) { throw configRequestError(error.message) }
  return updated
}
