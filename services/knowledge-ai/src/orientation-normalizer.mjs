import sharp from 'sharp'
import { detectTVOrientation } from './clip-client.mjs'
import { judgeTVOrientationCandidates } from './llm-analyzer.mjs'

const IMAGE_DATA_URL_RE = /^data:image\/(?:jpeg|jpg|png|webp|gif|bmp|avif);base64,([A-Za-z0-9+/]+={0,2})$/i
const MAX_INPUT_BYTES = 10 * 1024 * 1024
const MAX_INPUT_PIXELS = 20_000_000
const GEOMETRY_CONFIDENCE = 0.62
const OCR_CONFIDENCE = 0.8
const MODEL_CONFIDENCE = 0.76

function orientationError(message, code = 'ORIENTATION_ERROR', statusCode = 422, details = undefined) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  error.expose = true
  if (details) error.details = details
  return error
}
function parseDataUrl(imageDataUrl) {
  if (typeof imageDataUrl !== 'string') throw orientationError('图片必须是 base64 data URL', 'INVALID_IMAGE', 400)
  const match = IMAGE_DATA_URL_RE.exec(imageDataUrl)
  if (!match) throw orientationError('图片格式不受支持', 'INVALID_IMAGE', 400)
  const buffer = Buffer.from(match[1], 'base64')
  if (!buffer.length || buffer.length > MAX_INPUT_BYTES) throw orientationError('图片为空或超过 10MB', 'INVALID_IMAGE', 400)
  return buffer
}

function asDataUrl(buffer) {
  return `data:image/jpeg;base64,${buffer.toString('base64')}`
}

function supportedAngle(value, fallback = 0) {
  const numeric = Number(value)
  return [0, 90, 180, 270].includes(numeric) ? numeric : fallback
}

async function jpegBuffer(buffer, angle = 0) {
  const input = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
  const oriented = angle ? input.rotate(angle) : input
  return oriented
    .jpeg({ quality: 82, chromaSubsampling: '4:2:0' })
    .toBuffer()
}

async function exifNormalizedJpeg(buffer) {
  return sharp(buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .jpeg({ quality: 82, chromaSubsampling: '4:2:0' })
    .toBuffer()
}

export function decideOrientation(detection, modelDecision = null) {
  const tvDetected = detection?.tvDetected === true
  const geometryConfidence = Number(detection?.geometryConfidence) || 0
  const baseRotation = supportedAngle(detection?.baseRotation, 0)
  const ocrDecision = detection?.ocr?.decision
  const ocrConfidence = Number(detection?.ocr?.confidence) || 0
  const geometryReliable = tvDetected && geometryConfidence >= GEOMETRY_CONFIDENCE
  const ocrReliable = geometryReliable
    && ['normal', 'rotated180'].includes(ocrDecision)
    && ocrConfidence >= OCR_CONFIDENCE

  if (ocrReliable) {
    return {
      angle: (baseRotation + (ocrDecision === 'rotated180' ? 180 : 0)) % 360,
      requiresConfirmation: false,
      source: 'geometry+ocr',
      confidence: Math.min(geometryConfidence, ocrConfidence),
      reason: '电视长轴和文字识别方向均达到自动纠正阈值',
    }
  }

  const modelChoice = modelDecision?.choice
  const modelConfidence = Number(modelDecision?.confidence) || 0
  if (geometryReliable && ['A', 'B'].includes(modelChoice) && modelConfidence >= MODEL_CONFIDENCE) {
    return {
      angle: (baseRotation + (modelChoice === 'B' ? 180 : 0)) % 360,
      requiresConfirmation: false,
      source: 'geometry+multimodal',
      confidence: Math.min(geometryConfidence, modelConfidence),
      reason: modelDecision.evidence || '多模态模型完成两张候选图比较',
    }
  }

  return {
    angle: baseRotation,
    requiresConfirmation: true,
    source: tvDetected ? 'geometry-suggestion' : 'unresolved',
    confidence: geometryConfidence,
    reason: detection?.reason || '没有足够可靠的电视方向证据',
  }
}

async function normalizeBuffer(buffer, { allowModel = true, useOcr = true, signal } = {}) {
  let sourceBuffer
  try {
    sourceBuffer = await exifNormalizedJpeg(buffer)
  } catch (error) {
    throw orientationError(`图片解码或 EXIF 方向归一化失败: ${error.message}`, 'INVALID_IMAGE', 400)
  }

  const sourceDataUrl = asDataUrl(sourceBuffer)
  let detection
  try {
    detection = await detectTVOrientation(sourceDataUrl, { useOcr, signal })
  } catch (error) {
    return {
      buffer: sourceBuffer,
      sourceImage: sourceDataUrl,
      normalizedImage: sourceDataUrl,
      orientation: {
        status: 'confirmation_required',
        angle: 0,
        requiresConfirmation: true,
        source: 'service-error',
        confidence: 0,
        reason: '方向检测服务不可用，请人工确认图片方向',
        error: String(error.message || error).slice(0, 300),
      },
    }
  }

  const baseRotation = supportedAngle(detection.baseRotation, 0)
  let modelDecision = null
  let modelError = ''
  const geometryReliable = detection.tvDetected === true
    && Number(detection.geometryConfidence) >= GEOMETRY_CONFIDENCE
  const ocrReliable = ['normal', 'rotated180'].includes(detection?.ocr?.decision)
    && Number(detection?.ocr?.confidence) >= OCR_CONFIDENCE

  if (allowModel && geometryReliable && !ocrReliable) {
    try {
      const candidateABuffer = await jpegBuffer(sourceBuffer, baseRotation)
      const candidateBBuffer = await jpegBuffer(candidateABuffer, 180)
      modelDecision = await judgeTVOrientationCandidates(
        asDataUrl(candidateABuffer),
        asDataUrl(candidateBBuffer),
        signal,
      )
    } catch (error) {
      modelError = String(error.message || error).slice(0, 300)
    }
  }

  const decision = decideOrientation(detection, modelDecision)
  const normalizedBuffer = decision.angle ? await jpegBuffer(sourceBuffer, decision.angle) : sourceBuffer
  return {
    buffer: normalizedBuffer,
    sourceImage: sourceDataUrl,
    normalizedImage: asDataUrl(normalizedBuffer),
    orientation: {
      status: decision.requiresConfirmation
        ? 'confirmation_required'
        : (decision.angle === 0 ? 'already_upright' : 'auto_corrected'),
      angle: decision.angle,
      requiresConfirmation: decision.requiresConfirmation,
      source: decision.source,
      confidence: Math.round(decision.confidence * 1000) / 1000,
      reason: decision.reason,
      geometry: {
        tvDetected: detection.tvDetected === true,
        confidence: Number(detection.geometryConfidence) || 0,
        longAxis: detection.tvRegion?.longAxis || 'unknown',
        baseRotation,
      },
      ocr: detection.ocr || { decision: 'not_run', confidence: 0 },
      multimodal: modelDecision || (modelError ? { choice: 'uncertain', confidence: 0, error: modelError } : null),
    },
  }
}

export async function normalizeTVImage(imageDataUrl, options = {}) {
  return normalizeBuffer(parseDataUrl(imageDataUrl), options)
}

export async function normalizeTVImageBuffer(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_INPUT_BYTES) {
    throw orientationError('图片为空或超过 10MB', 'INVALID_IMAGE', 400)
  }
  return normalizeBuffer(buffer, options)
}

/**
 * All server-side analysis entry points call this unless the trusted preflight
 * flag says the browser has already shown/confirmed the exact normalized image.
 */
export async function prepareImagesForAnalysis(images, {
  alreadyPrepared = false,
  allowModel = true,
  requireResolved = true,
  signal,
} = {}) {
  if (alreadyPrepared) return { images, orientations: [], preprocessed: false }

  const results = []
  // OCR and the configured model are intentionally serialized to cap memory and cost.
  for (const image of images) {
    results.push(await normalizeTVImage(image, { allowModel, useOcr: true, signal }))
  }
  const unresolved = results
    .map((result, index) => ({ index, ...result.orientation }))
    .filter(item => item.requiresConfirmation)
  if (requireResolved && unresolved.length) {
    throw orientationError(
      '图片方向证据不足，请先在图片方向确认页完成确认',
      'ORIENTATION_CONFIRMATION_REQUIRED',
      422,
      { orientations: unresolved },
    )
  }
  return {
    images: results.map(result => result.normalizedImage),
    orientations: results.map(result => result.orientation),
    preprocessed: true,
  }
}
