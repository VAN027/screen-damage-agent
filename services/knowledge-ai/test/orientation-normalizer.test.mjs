import test from 'node:test'
import assert from 'node:assert/strict'

import { decideOrientation } from '../src/orientation-normalizer.mjs'

function detection(overrides = {}) {
  return {
    tvDetected: true,
    geometryConfidence: 0.9,
    baseRotation: 0,
    reason: '',
    ocr: { decision: 'normal', confidence: 0.88 },
    ...overrides,
  }
}

test('keeps a horizontal TV when OCR is upright', () => {
  assert.deepEqual(decideOrientation(detection()), {
    angle: 0,
    requiresConfirmation: false,
    source: 'geometry+ocr',
    confidence: 0.88,
    reason: '电视长轴和文字识别方向均达到自动纠正阈值',
  })
})
test('maps a vertical TV plus an upside-down OCR decision to 270 degrees', () => {
  const result = decideOrientation(detection({
    baseRotation: 90,
    ocr: { decision: 'rotated180', confidence: 0.84 },
  }))
  assert.equal(result.angle, 270)
  assert.equal(result.requiresConfirmation, false)
  assert.equal(result.source, 'geometry+ocr')
})

test('combines OCR and multimodal evidence when both select the same candidate', () => {
  const result = decideOrientation(detection(), {
    choice: 'A', confidence: 0.86, evidence: '文字、底座和环境方向均为正向',
  })
  assert.equal(result.angle, 0)
  assert.equal(result.requiresConfirmation, false)
  assert.equal(result.source, 'geometry+ocr+multimodal')
  assert.equal(result.confidence, 0.86)
})

test('requires confirmation when reliable OCR and multimodal decisions conflict', () => {
  const result = decideOrientation(detection(), {
    choice: 'B', confidence: 0.92, evidence: '候选 B 的环境方向为正向',
  })
  assert.equal(result.angle, 0)
  assert.equal(result.requiresConfirmation, true)
  assert.equal(result.source, 'ocr-multimodal-conflict')
  assert.match(result.reason, /冲突/)
})

test('uses the multimodal comparison only as a two-candidate fallback', () => {
  const result = decideOrientation(
    detection({ ocr: { decision: 'uncertain', confidence: 0.4 } }),
    { choice: 'B', confidence: 0.91, evidence: '候选 B 的品牌文字为正向' },
  )
  assert.equal(result.angle, 180)
  assert.equal(result.requiresConfirmation, false)
  assert.equal(result.source, 'geometry+multimodal')
})

test('requires confirmation when the TV rectangle is not reliable', () => {
  const result = decideOrientation(detection({
    tvDetected: false,
    geometryConfidence: 0,
    baseRotation: 90,
    reason: '未可靠检测到电视矩形边框',
    ocr: { decision: 'uncertain', confidence: 0 },
  }), { choice: 'A', confidence: 0.99 })
  assert.equal(result.angle, 90)
  assert.equal(result.requiresConfirmation, true)
  assert.equal(result.source, 'unresolved')
})

test('requires confirmation when both OCR and model confidence are weak', () => {
  const result = decideOrientation(
    detection({ baseRotation: 90, ocr: { decision: 'uncertain', confidence: 0.3 } }),
    { choice: 'A', confidence: 0.55 },
  )
  assert.equal(result.angle, 90)
  assert.equal(result.requiresConfirmation, true)
  assert.equal(result.source, 'geometry-suggestion')
})
