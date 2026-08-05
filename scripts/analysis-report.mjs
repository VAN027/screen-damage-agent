#!/usr/bin/env node
/**
 * 鉴定评估分析报告
 * 
 * 使用方式：
 *   node scripts/analysis-report.mjs
 * 
 * 输出：
 *   1. 各字段整体准确率
 *   2. 按故障形态分组的各字段准确率
 *   3. 鉴定结论混淆矩阵
 *   4. 漏液/熔屏等质量问题专项分析
 */

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(__dirname, '..', 'services', 'knowledge-ai', 'data', 'knowledge.db')

// better-sqlite3 安装在 knowledge-ai 子目录，需要从那里 require
const knowledgeAiDir = join(__dirname, '..', 'services', 'knowledge-ai')
const localRequire = createRequire(join(knowledgeAiDir, 'package.json'))

const db = localRequire('better-sqlite3')(DB_PATH)

// ===== 工具函数 =====
const pct = (ok, total) => total > 0 ? (ok / total * 100).toFixed(1) + '%' : '-'
const pad = (s, len) => {
  const str = String(s)
  // 中文字符占2个显示宽度
  const clen = [...str].reduce((acc, c) => acc + (c.charCodeAt(0) > 127 ? 2 : 1), 0)
  return str + ' '.repeat(Math.max(0, len - clen))
}

// ===== 结论标签映射 =====
const CONC_LABELS = {
  'product_quality_issue': '产品质量问题',
  'not_product_quality': '非产品质量问题',
  'no_damage': '屏幕完好',
  '产品质量问题': '产品质量问题',
  '非产品质量问题': '非产品质量问题',
  '屏幕完好': '屏幕完好',
}

// ===== 规范化结论标签 =====
function normConc(value, fallback) {
  // 空值：如果 match=1（同意LLM），用fallback
  if (!value || value === '') return fallback || value
  return CONC_LABELS[value] || value
}

// ===== 读取数据 =====
const rows = db.prepare('SELECT * FROM evaluations WHERE analyzed=1').all()
const judged = rows.filter(r => r.match_conclusion !== -1 || r.match_location !== -1)
const total = rows.length
const judgedCount = judged.length

console.log('═══════════════════════════════════════════')
console.log('       屏损鉴定评估分析报告')
console.log('═══════════════════════════════════════════')
console.log(`评估总数: ${total}  |  已标注: ${judgedCount} 条  |  未标注: ${total - judgedCount} 条`)
console.log(`报告时间: ${new Date().toLocaleString('zh-CN')}`)
console.log('')

// ===== 1. 整体准确率 =====
console.log('━━━ 一、各字段整体准确率 ━━━')
console.log('')

const fields = [
  { key: 'status_obs', label: '状态观察' },
  { key: 'location', label: '故障位置' },
  { key: 'shape', label: '故障形态' },
  { key: 'principle', label: '故障原理' },
  { key: 'conclusion', label: '鉴定结论' },
]

for (const { key, label } of fields) {
  const hasJ = rows.filter(r => r['match_' + key] !== -1)
  const ok = hasJ.filter(r => r['match_' + key] === 1).length
  const ng = hasJ.filter(r => r['match_' + key] === 0).length
  console.log(`  ${label}:  ${pct(ok, hasJ.length)}  (${ok}/${hasJ.length} 正确, ${ng}/${hasJ.length} 错误)`)
}

// ===== 2. 按故障形态分组 =====
console.log('')
console.log('━━━ 二、按故障形态分组准确率 ━━━')
console.log('')

const byShape = db.prepare(`
  SELECT llm_shape,
    COUNT(*) as total,
    SUM(CASE WHEN match_status_obs=1 THEN 1 ELSE 0 END) as ok_sobs,
    SUM(CASE WHEN match_status_obs IN (0,1) THEN 1 ELSE 0 END) as has_sobs,
    SUM(CASE WHEN match_location=1 THEN 1 ELSE 0 END) as ok_loc,
    SUM(CASE WHEN match_location IN (0,1) THEN 1 ELSE 0 END) as has_loc,
    SUM(CASE WHEN match_shape=1 THEN 1 ELSE 0 END) as ok_shape,
    SUM(CASE WHEN match_shape IN (0,1) THEN 1 ELSE 0 END) as has_shape,
    SUM(CASE WHEN match_principle=1 THEN 1 ELSE 0 END) as ok_prin,
    SUM(CASE WHEN match_principle IN (0,1) THEN 1 ELSE 0 END) as has_prin,
    SUM(CASE WHEN match_conclusion=1 THEN 1 ELSE 0 END) as ok_conc,
    SUM(CASE WHEN match_conclusion IN (0,1) THEN 1 ELSE 0 END) as has_conc
  FROM evaluations WHERE analyzed=1
  GROUP BY llm_shape ORDER BY total DESC
`).all()

// 表头
console.log(pad('故障形态', 26) + pad('数量', 6) + pad('状态观察', 10) + pad('位置', 10) + pad('形态', 10) + pad('原理', 10) + pad('结论', 10))
console.log('-'.repeat(72))

for (const r of byShape) {
  console.log(
    pad(r.llm_shape || '(空)', 26) +
    pad(r.total, 6) +
    pad(pct(r.ok_sobs, r.has_sobs), 10) +
    pad(pct(r.ok_loc, r.has_loc), 10) +
    pad(pct(r.ok_shape, r.has_shape), 10) +
    pad(pct(r.ok_prin, r.has_prin), 10) +
    pad(pct(r.ok_conc, r.has_conc), 10)
  )
}

// ===== 3. 鉴定结论混淆矩阵 =====
console.log('')
console.log('━━━ 三、鉴定结论混淆矩阵 (LLM预测 vs 人工判定) ━━━')
console.log('')

const humanLabels = new Set()
const crossData = {}
for (const r of rows) {
  if (r.match_conclusion === -1) continue
  const llmLabel = normConc(r.llm_conclusion)
  // 如果 human_conclusion 为空且 match=1，说明人同意LLM，用LLM的结论
  const humanLabel = normConc(r.human_conclusion, r.match_conclusion === 1 ? llmLabel : null) || '(未填)'
  humanLabels.add(humanLabel)
  if (!crossData[llmLabel]) crossData[llmLabel] = {}
  crossData[llmLabel][humanLabel] = (crossData[llmLabel][humanLabel] || 0) + 1
}

const sortedHuman = [...humanLabels].sort()
const sortedLLM = Object.keys(crossData).sort()

// 表头
console.log(pad('LLM ↓  人工 →', 20) + sortedHuman.map(h => pad(h, 14)).join(''))
console.log('-'.repeat(20 + sortedHuman.length * 14))

// 数据行
for (const llm of sortedLLM) {
  const cells = sortedHuman.map(h => {
    const v = crossData[llm][h] || 0
    const isDiagonal = llm === h
    return pad(isDiagonal ? `✅${v}` : `${v}`, 14)
  }).join('')
  console.log(pad(llm, 20) + cells)
}

// ===== 4. 漏液/熔屏专项 =====
console.log('')
console.log('━━━ 四、质量类故障专项分析 ━━━')
console.log('')

const qualityShapes = ['漏液', '熔屏']
for (const qs of qualityShapes) {
  const subset = rows.filter(r => r.llm_shape && r.llm_shape.includes(qs))
  if (subset.length === 0) {
    console.log(`  ${qs}: 无数据`)
    continue
  }
  console.log(`  【${qs}】共 ${subset.length} 例`)
  // 各字段准确率
  for (const { key, label } of fields) {
    const hasJ = subset.filter(r => r['match_' + key] !== -1)
    const ok = hasJ.filter(r => r['match_' + key] === 1).length
    console.log(`    ${label}: ${pct(ok, hasJ.length)}  (${ok}/${hasJ.length})`)
  }
  
  // 结论误判分析
  const pq2npqLocal = subset.filter(r => r.match_conclusion === 0 && normConc(r.llm_conclusion) === '产品质量问题' && normConc(r.human_conclusion, '') === '非产品质量问题')
  const npq2pqLocal = subset.filter(r => r.match_conclusion === 0 && normConc(r.llm_conclusion) === '非产品质量问题' && normConc(r.human_conclusion, '') === '产品质量问题')
  const noDam2dmg = subset.filter(r => r.match_conclusion === 0 && normConc(r.llm_conclusion) === '屏幕完好')
  if (pq2npqLocal.length > 0) console.log(`    ⚠  LLM判为「产品质量问题」→ 人工判定为「非产品质量」: ${pq2npqLocal.length} 例`)
  if (npq2pqLocal.length > 0) console.log(`    ⚠  LLM判为「非产品质量问题」→ 人工判定为「产品质量」: ${npq2pqLocal.length} 例`)
  if (noDam2dmg.length > 0) console.log(`    ⚠  LLM判为「屏幕完好」但实际有故障: ${noDam2dmg.length} 例`)
  console.log('')
}

// ===== 5. 全局误判统计 =====
console.log('━━━ 五、全局结论误判统计 ━━━')
console.log('')

// 用 normConc 创建标准化的标签，过滤时用
const pq2npq = rows.filter(r => {
  if (r.match_conclusion !== 0) return false
  const llm = normConc(r.llm_conclusion)
  const human = normConc(r.human_conclusion, '')
  return llm === '产品质量问题' && human === '非产品质量问题'
})
const npq2pq = rows.filter(r => {
  if (r.match_conclusion !== 0) return false
  const llm = normConc(r.llm_conclusion)
  const human = normConc(r.human_conclusion, '')
  return llm === '非产品质量问题' && human === '产品质量问题'
})
const dam2nd = rows.filter(r => {
  if (r.match_conclusion !== 0) return false
  const llm = normConc(r.llm_conclusion)
  return llm === '屏幕完好'
})
const nd2dam = rows.filter(r => {
  if (r.match_conclusion !== 0) return false
  const llm = normConc(r.llm_conclusion)
  const human = normConc(r.human_conclusion, '')
  return llm !== '屏幕完好' && human === '屏幕完好'
})

console.log(`  LLM判为「产品质量问题」但实际是「非产品质量」: ${pq2npq.length}/${judgedCount} (${pct(pq2npq.length, judgedCount)})`)
console.log(`  LLM判为「非产品质量问题」但实际是「产品质量」: ${npq2pq.length}/${judgedCount} (${pct(npq2pq.length, judgedCount)})`)
console.log(`  LLM判为「屏幕完好」但实际有故障:              ${dam2nd.length}/${judgedCount} (${pct(dam2nd.length, judgedCount)})`)
console.log(`  LLM判为有故障但实际「屏幕完好」:              ${nd2dam.length}/${judgedCount} (${pct(nd2dam.length, judgedCount)})`)

// 详细列出误判案例
if (pq2npq.length > 0) {
  console.log('')
  console.log('  ▸ 产品质量→非产品质量 误判案例:')
  for (const r of pq2npq) {
    console.log(`    #${r.id} ${r.case_title} | 形态: ${r.llm_shape}`)
  }
}
if (npq2pq.length > 0) {
  console.log('')
  console.log('  ▸ 非产品质量→产品质量 漏判案例:')
  for (const r of npq2pq) {
    console.log(`    #${r.id} ${r.case_title} | 形态: ${r.llm_shape}`)
  }
}

console.log('')
console.log('═══════════════════════════════════════════')
console.log('               报告结束')
console.log('═══════════════════════════════════════════')

db.close()
