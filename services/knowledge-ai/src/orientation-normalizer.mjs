import sharp from 'sharp'
import { compareTVOrientationOcr, detectTVOrientation } from './clip-client.mjs'
import { judgeTVOrientationCandidates } from './llm-analyzer.mjs'

const IMAGE_DATA_URL_RE = /^data:image\/(?:jpeg|jpg|png|webp|gif|bmp|avif);base64,([A-Za-z0-9+/]+={0,2})$/i
const MAX_INPUT_BYTES = 10 * 1024 * 1024
const MAX_INPUT_PIXELS = 20_000_000
const GEOMETRY_CONFIDENCE = 0.62
const OCR_CONFIDENCE = 0.8
const MODEL_CONFIDENCE = 0.76

function reportProgress(callback, stage, status, data = {}) {
  if (typeof callback !== 'function') return
  try { callback({ stage, status, ...data }) } catch { /* progress must never break detection */ }
}

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

async function modelCandidateBuffer(buffer, angle = 0) {
  const input = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
  const oriented = angle ? input.rotate(angle) : input
  return oriented
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75, chromaSubsampling: '4:2:0' })
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
  const modelChoice = modelDecision?.choice
  const modelConfidence = Number(modelDecision?.confidence) || 0
  const modelReliable = geometryReliable
    && ['A', 'B'].includes(modelChoice)
    && modelConfidence >= MODEL_CONFIDENCE
  const ocrChoice = ocrDecision === 'rotated180' ? 'B' : 'A'

  if (ocrReliable && modelReliable && ocrChoice !== modelChoice) {
    return {
      angle: baseRotation,
      requiresConfirmation: true,
      source: 'ocr-multimodal-conflict',
      confidence: Math.min(geometryConfidence, Math.max(ocrConfidence, modelConfidence)),
      reason: `OCR 判断候选 ${ocrChoice}，多模态判断候选 ${modelChoice}，高置信度结果冲突，请人工确认`,
    }
  }

  if (ocrReliable && modelReliable) {
    return {
      angle: (baseRotation + (modelChoice === 'B' ? 180 : 0)) % 360,
      requiresConfirmation: false,
      source: 'geometry+ocr+multimodal',
      confidence: Math.min(geometryConfidence, ocrConfidence, modelConfidence),
      reason: modelDecision.evidence || 'OCR 与多模态模型对电视上下方向判断一致',
    }
  }

  // Model unavailable or uncertain: preserve the reliable OCR degradation path.
  if (ocrReliable) {
    return {
      angle: (baseRotation + (ocrDecision === 'rotated180' ? 180 : 0)) % 360,
      requiresConfirmation: false,
      source: 'geometry+ocr',
      confidence: Math.min(geometryConfidence, ocrConfidence),
      reason: '电视长轴和文字识别方向均达到自动纠正阈值',
    }
  }

  if (modelReliable) {
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

async function normalizeBuffer(buffer, { allowModel = true, useOcr = false, debug = false, onProgress = null, signal } = {}) {
  const preprocessStarted = performance.now()
  reportProgress(onProgress, 'preprocess', 'running')
  let sourceBuffer
  try {
    sourceBuffer = await exifNormalizedJpeg(buffer)
  } catch (error) {
    reportProgress(onProgress, 'preprocess', 'failed', { message: error.message })
    throw orientationError(`图片解码或 EXIF 方向归一化失败: ${error.message}`, 'INVALID_IMAGE', 400)
  }
  reportProgress(onProgress, 'preprocess', 'completed', { durationMs: performance.now() - preprocessStarted })

  const sourceDataUrl = asDataUrl(sourceBuffer)
  let detection
  try {
    // The Python detector returns Canny/closing/geometry timings together in a
    // single response. Track that end-to-end wait separately so it is not
    // incorrectly presented as live Canny execution time.
    const opencvStarted = performance.now()
    reportProgress(onProgress, 'opencv', 'running', {
      message: '含图片传输、解码、Canny、闭运算和几何检测',
    })
    const splitOcrForProgress = typeof onProgress === 'function' && useOcr
    detection = await detectTVOrientation(sourceDataUrl, {
      useOcr: splitOcrForProgress ? false : useOcr,
      debug: debug || splitOcrForProgress,
      signal,
    })
    const timings = detection?.debug?.timings || {}
    reportProgress(onProgress, 'opencv', 'completed', {
      durationMs: performance.now() - opencvStarted,
      message: '端到端总耗时（含 IPC 与图片解码）',
    })
    reportProgress(onProgress, 'canny', 'completed', {
      durationMs: timings.cannyMs,
      message: 'OpenCV 内部精确耗时',
    })
    reportProgress(onProgress, 'contours', 'completed', {
      durationMs: timings.closingMs,
      message: 'OpenCV 内部精确耗时',
    })
    reportProgress(onProgress, 'geometry', 'completed', {
      durationMs: timings.geometryMs,
      message: 'OpenCV 内部精确耗时',
    })

    if (splitOcrForProgress) {
      const points = detection?.tvRegion?.points
      if (detection.tvDetected === true && Array.isArray(points) && points.length === 4) {
        reportProgress(onProgress, 'ocr', 'running')
        const ocrStarted = performance.now()
        try {
          detection.ocr = await compareTVOrientationOcr(sourceDataUrl, points, { signal })
          reportProgress(onProgress, 'ocr', 'completed', {
            durationMs: Number(detection.ocr?.durationMs) || performance.now() - ocrStarted,
          })
        } catch (error) {
          detection.ocr = { decision: 'uncertain', confidence: 0, error: String(error.message || error).slice(0, 240) }
          reportProgress(onProgress, 'ocr', 'failed', { durationMs: performance.now() - ocrStarted, message: detection.ocr.error })
        }
      } else {
        reportProgress(onProgress, 'ocr', 'skipped', { message: '未获得可靠电视区域' })
      }
    } else if (typeof onProgress === 'function' && !useOcr) {
      reportProgress(onProgress, 'ocr', 'skipped', { message: 'OCR 已关闭' })
    }
  } catch (error) {
    reportProgress(onProgress, 'opencv', 'failed', { message: error.message })
    reportProgress(onProgress, 'canny', 'skipped', { message: '未获得 OpenCV 内部计时' })
    reportProgress(onProgress, 'contours', 'skipped', { message: '未获得 OpenCV 内部计时' })
    reportProgress(onProgress, 'geometry', 'skipped', { message: '未获得 OpenCV 内部计时' })
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
  // Always compare A/B when model use is enabled. Even when geometry is weak,
  // the model can still inspect background, stand, bezel and logo evidence;
  // weak geometry remains confirmation-required during final fusion.
  if (allowModel) {
    try {
      reportProgress(onProgress, 'candidates', 'running')
      const candidatesStarted = performance.now()
      const candidateABuffer = await modelCandidateBuffer(sourceBuffer, baseRotation)
      const candidateBBuffer = await modelCandidateBuffer(sourceBuffer, (baseRotation + 180) % 360)
      reportProgress(onProgress, 'candidates', 'completed', { durationMs: performance.now() - candidatesStarted })
      reportProgress(onProgress, 'multimodal', 'running')
      const modelStarted = performance.now()
      modelDecision = await judgeTVOrientationCandidates(
        asDataUrl(candidateABuffer),
        asDataUrl(candidateBBuffer),
        signal,
      )
      reportProgress(onProgress, 'multimodal', 'completed', { durationMs: performance.now() - modelStarted })
    } catch (error) {
      modelError = String(error.message || error).slice(0, 300)
      reportProgress(onProgress, 'multimodal', 'failed', { message: modelError })
    }
  } else {
    reportProgress(onProgress, 'candidates', 'skipped', { message: '多模态复核已关闭' })
    reportProgress(onProgress, 'multimodal', 'skipped', { message: '多模态复核已关闭' })
  }

  const fusionStarted = performance.now()
  reportProgress(onProgress, 'fusion', 'running')
  const decision = decideOrientation(detection, modelDecision)
  reportProgress(onProgress, 'fusion', 'completed', { durationMs: performance.now() - fusionStarted })
  const rotationStarted = performance.now()
  reportProgress(onProgress, 'rotation', 'running')
  const normalizedBuffer = decision.angle ? await jpegBuffer(sourceBuffer, decision.angle) : sourceBuffer
  reportProgress(onProgress, 'rotation', 'completed', { durationMs: performance.now() - rotationStarted })
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
        points: Array.isArray(detection.tvRegion?.points) ? detection.tvRegion.points : [],
        areaRatio: Number(detection.tvRegion?.areaRatio) || 0,
        aspectRatio: Number(detection.tvRegion?.aspectRatio) || 0,
        rectangularity: Number(detection.tvRegion?.rectangularity) || 0,
        candidateCount: Number(detection.tvRegion?.candidateCount) || 0,
        detectionMethod: detection.tvRegion?.detectionMethod || 'unknown',
        perspectiveDistortion: Number(detection.tvRegion?.perspectiveDistortion) || 0,
        partial: detection.tvRegion?.partial === true,
      },
      ocr: detection.ocr || { decision: 'not_run', confidence: 0 },
      debug: debug ? (detection.debug || null) : undefined,
      multimodal: modelDecision || (modelError ? { status: 'unavailable', error: modelError } : null),
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
    results.push(await normalizeTVImage(image, { allowModel, useOcr: false, signal }))
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
