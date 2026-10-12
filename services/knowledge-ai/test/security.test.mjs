import test from 'node:test'
import assert from 'node:assert/strict'
import { validateModelEndpoint } from '../src/llm-analyzer.mjs'
import { buildSafeConfigUpdate } from '../src/config-validation.mjs'
import { isValidImageDataUrl, validateCorrectionEntry } from '../src/search-engine.mjs'

function modelConfig(overrides = {}) {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'old-secret',
    inheritEnvApiKey: false,
    endpoint: 'https://api.openai.com/v1/chat/completions',
    temperature: 0.3,
    maxTokens: 4096,
    enabled: true,
    systemPrompt: '',
    kbEnabled: true,
    kbSearchQuery: '',
    kbMaxChunks: 5,
    showRagPanel: true,
    showAiPanel: true,
    analysisMode: 'hybrid',
    orientationMode: 'auto',
    annoFields: [],
    ...overrides,
  }
}

test('model config only accepts supported image orientation modes', () => {
  const manual = buildSafeConfigUpdate(modelConfig(), { orientationMode: 'manual' }, 'model')
  assert.equal(manual.orientationMode, 'manual')
  assert.throws(
    () => buildSafeConfigUpdate(modelConfig(), { orientationMode: 'disabled' }, 'model'),
    error => error.code === 'INVALID_MODEL_CONFIG' && /orientationMode/.test(error.message),
  )
})

test('model endpoints require HTTPS and block metadata/private targets', { concurrency: false }, () => {
  const previous = process.env.LLM_ALLOWED_HOSTS
  delete process.env.LLM_ALLOWED_HOSTS
  try {
    assert.doesNotThrow(() => validateModelEndpoint('https://api.openai.com/v1', 'openai'))
    assert.throws(() => validateModelEndpoint('http://169.254.169.254/latest/meta-data', 'openai'))
    assert.throws(() => validateModelEndpoint('https://127.0.0.1/secret', 'openai'))
    assert.throws(() => validateModelEndpoint('https://user:pass@example.com/v1', 'openai'))
    assert.throws(() => validateModelEndpoint('https://attacker.example/v1', 'openai'))
    assert.doesNotThrow(() => validateModelEndpoint('http://127.0.0.1:11434/api/chat', 'ollama'))
    assert.throws(() => validateModelEndpoint('http://169.254.169.254:11434/latest/meta-data', 'ollama'))
    assert.throws(() => validateModelEndpoint('http://127.0.0.1:8080/api/chat', 'ollama'))
  } finally {
    if (previous === undefined) delete process.env.LLM_ALLOWED_HOSTS
    else process.env.LLM_ALLOWED_HOSTS = previous
  }
})

test('LLM_ALLOWED_HOSTS requires an exact host and port for private HTTP endpoints', { concurrency: false }, () => {
  const previous = process.env.LLM_ALLOWED_HOSTS
  process.env.LLM_ALLOWED_HOSTS = 'model.internal:8080'
  try {
    assert.doesNotThrow(() => validateModelEndpoint('http://model.internal:8080/v1', 'openai'))
    assert.throws(() => validateModelEndpoint('http://model.internal:8081/v1', 'openai'))
  } finally {
    if (previous === undefined) delete process.env.LLM_ALLOWED_HOSTS
    else process.env.LLM_ALLOWED_HOSTS = previous
  }
})

test('model config never carries an old or masked key to a changed endpoint', { concurrency: false }, () => {
  const current = modelConfig()

  assert.throws(
    () => buildSafeConfigUpdate(current, {
      endpoint: 'https://api.anthropic.com/v1/messages',
      provider: 'anthropic',
      apiKey: '********cret',
    }, 'model'),
    error => error.code === 'INVALID_MODEL_CONFIG' && /API Key/.test(error.message),
  )
  assert.throws(
    () => buildSafeConfigUpdate(current, {
      endpoint: 'https://api.anthropic.com/v1/messages',
      provider: 'anthropic',
    }, 'model'),
    /API Key/,
  )

  const changed = buildSafeConfigUpdate(current, {
    endpoint: 'https://api.anthropic.com/v1/messages',
    provider: 'anthropic',
    apiKey: 'new-secret',
  }, 'model')
  assert.equal(changed.apiKey, 'new-secret')
  assert.equal(changed.inheritEnvApiKey, false)

  const disabled = buildSafeConfigUpdate(current, {
    endpoint: 'https://api.anthropic.com/v1/messages',
    provider: 'anthropic',
    enabled: false,
    apiKey: '********cret',
  }, 'model')
  assert.equal(disabled.apiKey, '')
  assert.equal(disabled.inheritEnvApiKey, false)
})

test('same-endpoint masked keys stay server-side and environment keys are never persisted', { concurrency: false }, () => {
  const current = modelConfig()
  const unchanged = buildSafeConfigUpdate(current, { apiKey: '********cret', temperature: 0.5 }, 'model')
  assert.equal(unchanged.apiKey, 'old-secret')
  assert.equal(unchanged.temperature, 0.5)

  const previousKey = process.env.LLM_API_KEY
  process.env.LLM_API_KEY = 'environment-secret'
  try {
    const environmentBacked = modelConfig({ apiKey: 'environment-secret', inheritEnvApiKey: true })
    Object.defineProperty(environmentBacked, '__apiKeyFromEnv', { value: true, enumerable: false })
    const safeForDisk = buildSafeConfigUpdate(environmentBacked, { apiKey: '********cret' }, 'model')
    assert.equal(safeForDisk.apiKey, '')
    assert.equal(safeForDisk.inheritEnvApiKey, true)
    assert.equal(JSON.stringify(safeForDisk).includes('environment-secret'), false)
  } finally {
    if (previousKey === undefined) delete process.env.LLM_API_KEY
    else process.env.LLM_API_KEY = previousKey
  }
})

test('correction validation blocks attribute-injection data URLs and bounds fields', () => {
  const validJpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`
  const capability = { feedbackId: 1, capabilityToken: 'a'.repeat(43) }
  assert.equal(isValidImageDataUrl(validJpeg), true)
  assert.equal(isValidImageDataUrl('data:image/" onerror="alert(1);base64,AAAA'), false)
  assert.equal(isValidImageDataUrl('data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+'), false)
  assert.equal(isValidImageDataUrl('data:image/png;base64,AAAA'), false)
  assert.equal(isValidImageDataUrl('data:image/jpeg;base64,%%%'), false)

  const correction = validateCorrectionEntry({
    ...capability,
    correctedLocation: ' 中央 ',
    correctedShape: ' 单条线状 ',
    correctedStage: ' 物流运输 ',
    correctedConclusion: '质量问题',
    remark: '人工确认结论有误',
    imageBase64: validJpeg,
    ignoredProperty: '<script>alert(1)</script>',
  })
  assert.equal(correction.correctedConclusion, 'product_quality_issue')
  assert.equal(correction.correctedLocation, '中央区域')
  assert.equal(correction.correctedShape, '单条线状屏裂')
  assert.equal(correction.correctedStage, '物流运输搬运')
  assert.equal('ignoredProperty' in correction, false)
  assert.throws(() => validateCorrectionEntry({
    ...capability,
    correctedConclusion: '任意结论',
    remark: 'x',
    correctedLocation: '中央区域',
    correctedShape: '单条线状屏裂',
    imageBase64: validJpeg,
  }))
  assert.throws(() => validateCorrectionEntry({
    ...capability,
    correctedConclusion: 'no_damage',
    remark: 'x'.repeat(2001),
    correctedLocation: '中央区域',
    correctedShape: '单条线状屏裂',
    imageBase64: validJpeg,
  }))
  assert.throws(() => validateCorrectionEntry({
    ...capability,
    correctedConclusion: 'no_damage',
    remark: 'x',
    correctedLocation: { toString: () => '中央区域' },
    correctedShape: '单条线状屏裂',
    imageBase64: validJpeg,
  }))
  assert.throws(() => validateCorrectionEntry({
    ...capability,
    correctedConclusion: 'no_damage',
    remark: 'x',
    correctedLocation: '中央区域',
    correctedShape: '单条线状屏裂',
    imageBase64: 'data:image/" onerror="alert(1);base64,AAAA',
  }))
  assert.throws(() => validateCorrectionEntry({
    ...capability,
    correctedConclusion: 'no_damage',
    remark: 'x',
    correctedShape: '单条线状屏裂',
    imageBase64: validJpeg,
  }), /location/)
  assert.throws(() => validateCorrectionEntry({
    correctedConclusion: 'no_damage',
    remark: 'x',
    correctedLocation: '中央区域',
    correctedShape: '单条线状屏裂',
    imageBase64: validJpeg,
  }), /反馈记录/)

  for (const missing of ['correctedLocation', 'correctedShape', 'correctedConclusion', 'remark', 'imageBase64']) {
    const complete = {
      ...capability,
      correctedLocation: '中央区域',
      correctedShape: '单条线状屏裂',
      correctedConclusion: 'no_damage',
      remark: '人工复核备注',
      imageBase64: validJpeg,
    }
    delete complete[missing]
    assert.throws(() => validateCorrectionEntry(complete), new RegExp(missing.replace('corrected', ''), 'i'))
  }
})
