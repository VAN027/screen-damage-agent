/**
 * 批量纠正 data/images/ 下所有图片的 TV 屏幕方向
 *
 * 用法: node tools/fix-image-orientation.mjs [--dry-run] [--file=case-xxx.jpg]
 *   --dry-run    仅检测，不实际修改文件
 *   --file=xxx   只处理指定文件
 */

import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const IMAGES_DIR = path.join(__dirname, '..', 'data', 'images')

// --- 从 search-engine.mjs 复制的检测逻辑 ---

function _rowEdgeDensity(pixels, w, h) {
  const scores = new Array(h).fill(0)
  for (let y = 0; y < h; y++) {
    const rowOff = y * w
    let sum = 0
    for (let x = 1; x < w; x++) sum += Math.abs(pixels[rowOff + x] - pixels[rowOff + x - 1])
    scores[y] = sum / w
  }
  return scores
}

function _colEdgeDensity(pixels, w, h) {
  const scores = new Array(w).fill(0)
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = 1; y < h; y++) sum += Math.abs(pixels[y * w + x] - pixels[(y - 1) * w + x])
    scores[x] = sum / h
  }
  return scores
}

function _peakRegion(scores, thresholdRatio = 0.35) {
  const max = Math.max(...scores)
  const th = max * thresholdRatio
  let start = 0, end = scores.length - 1
  for (; start < scores.length && scores[start] < th; start++) {}
  for (; end >= 0 && scores[end] < th; end--) {}
  if (start >= end) return { start: 0, end: scores.length - 1 }
  const margin = Math.floor((end - start) * 0.04)
  return { start: start + margin, end: end - margin }
}

async function detectOrientation(buf) {
  const rawW = 600
  const { data, info } = await sharp(buf).resize(rawW).grayscale().raw().toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height
  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)

  const colScores = _colEdgeDensity(pixels, w, h)
  const cols = _peakRegion(colScores)
  const tvW = cols.end - cols.start

  const rowScores = _rowEdgeDensity(pixels, w, h)
  const rows = _peakRegion(rowScores)
  const tvH = rows.end - rows.start

  let needRot90 = tvH > tvW * 1.1
  let needFlip180 = false

  if (tvH >= 10) {
    const bandH = Math.max(Math.floor(tvH * 0.12), 4)
    let topSum = 0, botSum = 0
    for (let y = rows.start; y < Math.min(rows.start + bandH, h); y++) topSum += rowScores[y]
    for (let y = Math.max(rows.end - bandH, 0); y < rows.end; y++) botSum += rowScores[y]
    needFlip180 = topSum > botSum * 1.1
  }

  return { needRot90, needFlip180, tvW, tvH }
}

// --- Main ---

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const targetFile = args.find(a => a.startsWith('--file='))?.split('=')[1] || null
const force = args.includes('--force')

if (!fs.existsSync(IMAGES_DIR)) {
  console.error('Images directory not found:', IMAGES_DIR)
  process.exit(1)
}

const files = targetFile
  ? [targetFile]
  : fs.readdirSync(IMAGES_DIR).filter(f => /\.(jpg|png|jpeg|webp)$/i.test(f))

console.log(`${dryRun ? '[DRY RUN] ' : ''}Scanning ${files.length} images...`)

let ok = 0, fixed = 0, skipped = 0, errors = 0

for (const f of files) {
  const filePath = path.join(IMAGES_DIR, f)
  if (!fs.existsSync(filePath)) {
    console.log(`  SKIP: ${f} (not found)`)
    skipped++
    continue
  }

  const buf = fs.readFileSync(filePath)
  try {
    const { needRot90, needFlip180 } = await detectOrientation(buf)

    if (!needRot90 && !needFlip180) {
      ok++
      continue
    }

    const actions = []
    if (needRot90) actions.push('Rot90')
    if (needFlip180) actions.push('Flip180')

    if (dryRun) {
      console.log(`  [DRY] ${f}: ${actions.join(' + ')}`)
      fixed++
    } else {
      let corrected = sharp(buf)
      if (needRot90) corrected = sharp(await corrected.rotate(90).toBuffer())
      if (needFlip180) corrected = sharp(await corrected.rotate(180).toBuffer())
      // 二次验证
      const newBuf = await corrected.toBuffer()
      const { needRot90: r2, needFlip180: f2 } = await detectOrientation(newBuf)
      if (r2 || f2) {
        // 二次验证失败：尝试只用 rot90（至少保证 TV 横屏）
        const metaBuf = await sharp(buf).metadata()
        if (metaBuf.height > metaBuf.width) {
          const altBuf = await sharp(buf).rotate(needRot90 ? 270 : 90).toBuffer()
          const { needRot90: r3, needFlip180: f3 } = await detectOrientation(altBuf)
          if (!r3 && !f3) {
            fs.writeFileSync(filePath, altBuf)
            console.log(`  FIX: ${f}: Rot90(alt)`)
            fixed++
            continue
          }
          // 还是失败，至少做 rot90 保证横屏
          fs.writeFileSync(filePath, altBuf)
          console.log(`  SEMI: ${f}: Rot90(forced)`)
          fixed++
          continue
        }
        console.log(`  FAIL: ${f} — 二次检测仍然异常: rot90=${r2} flip180=${f2}`)
        errors++
        continue
      }
      fs.writeFileSync(filePath, newBuf)
      console.log(`  FIX: ${f}: ${actions.join(' + ')}`)
      fixed++
    }
  } catch (e) {
    console.log(`  ERR: ${f}: ${e.message}`)
    errors++
  }

  // 每 20 张输出进度
  if ((ok + fixed + skipped + errors) % 20 === 0) {
    console.log(`  [progress: ${ok + fixed + skipped + errors}/${files.length}]`)
  }
}

console.log(`\n=== Done ===`)
console.log(`  OK:      ${ok}`)
console.log(`  Fixed:   ${fixed}`)
console.log(`  Skipped: ${skipped}`)
console.log(`  Errors:  ${errors}`)
if (dryRun) console.log('\n(DRY RUN — 未实际修改文件。移除 --dry-run 执行真实修复)')
