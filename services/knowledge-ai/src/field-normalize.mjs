/**
 * 集中式字段值归一化（P0）
 *
 * 将 LLM 输出 / 人工标注 / 案例库脏值统一映射为 field-defs.json 中的规范值，
 * 保证评估对账、报告分组、RAG 匹配度对比使用同一套取值。
 *
 * 归一化规则（按顺序）：
 *   1. null/undefined/未知 → 空字符串
 *   2. 解开 JSON 数组字符串包装（案例库脏值：["点放射状屏裂"]）
 *   3. 全角/半角括号统一 + 去除中英文标点
 *   4. conclusion：中文标签 ↔ 代码互转（统一存代码，如 product_quality_issue）
 *   5. 精确命中规范选项
 *   6. 别名/子串匹配（如 左侧右侧 → 左侧、漏液（无缺角…） → 漏液）
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFS_PATH = join(__dirname, '..', 'data', 'field-defs.json')

// 兜底规范值（field-defs.json 读取失败时使用，需与其保持一致）
const FALLBACK_DEFS = {
  location: ['天侧', '地侧', '左侧', '右侧', '四角区域', '中央区域', '全屏区域', '局部不规则区域'],
  shape: ['单条线状屏裂', '多条线状屏裂', '点放射状屏裂', '发散性线状屏裂', '环状/圈状屏裂', '网状(大面积无规则)屏裂', '漏液', '熔屏'],
  stage: ['产品因素', '物流运输搬运', '拆机验机安装', '使用保管不当'],
  conclusion: ['product_quality_issue', 'not_product_quality', 'no_damage'],
}

let _defs = null
function getDefs() {
  if (_defs) return _defs
  try {
    const raw = readFileSync(DEFS_PATH, 'utf8')
    _defs = JSON.parse(raw).fields || {}
  } catch {
    _defs = {}
  }
  return _defs
}

function canonicalOptions(field) {
  const f = getDefs()[field]
  if (f && Array.isArray(f.options) && f.options.length > 0) {
    return f.options.map(o => (typeof o === 'string' ? o : o.value))
  }
  return FALLBACK_DEFS[field] || []
}

// 别名：值包含该 key 时 → 规范值
const ALIAS = {
  location: {
    '左侧右侧': '左侧',
    '左上角': '四角区域', '右上角': '四角区域', '左下角': '四角区域', '右下角': '四角区域',
    '四角': '四角区域', '角落': '四角区域',
    '顶部': '天侧', '上侧': '天侧', '上方': '天侧',
    '底部': '地侧', '下侧': '地侧', '下方': '地侧',
    '中央': '中央区域', '中心': '中央区域', '中部': '中央区域',
    '全屏': '全屏区域', '整个屏幕': '全屏区域',
    '不规则': '局部不规则区域', '局部': '局部不规则区域',
  },
  shape: {
    '单条': '单条线状屏裂', '单道': '单条线状屏裂',
    '多条': '多条线状屏裂', '多道': '多条线状屏裂',
    '点放射': '点放射状屏裂', '放射状': '点放射状屏裂',
    '发散': '发散性线状屏裂',
    '环状': '环状/圈状屏裂', '圈状': '环状/圈状屏裂', '环形': '环状/圈状屏裂',
    '网状': '网状(大面积无规则)屏裂', '蜘蛛网': '网状(大面积无规则)屏裂',
    '漏液（无缺角、裂纹、腐蚀）': '漏液', '漏液（有缺角、裂纹、腐蚀）': '漏液',
    '液晶泄漏': '漏液', '泄漏': '漏液', '浸润': '漏液', '进液': '漏液',
    '熔屏（无缺角、裂纹、腐蚀）': '熔屏', '熔屏（有缺角、裂纹、腐蚀）': '熔屏',
    '熔损': '熔屏', '烧焦': '熔屏', '碳化': '熔屏',
  },
}

// 结论：中文标签 → 代码（统一存代码，与 field-defs conclusion 的 option value 一致）
const CONCLUSION_LABEL_TO_CODE = {
  '产品质量问题': 'product_quality_issue',
  '非产品质量问题': 'not_product_quality',
  '屏幕完好': 'no_damage',
  '物流问题': 'logistics_issue',
  '需进一步鉴定': 'needs_further_review',
}

// 去除常见中英文标点
const STRIP_PUNCT = /[。.，,、；;：:！!？?（）()]/g

/**
 * 归一化单个字段值
 * @param {'location'|'shape'|'stage'|'conclusion'} field 字段类型
 * @param {*} raw 原始值
 * @returns {string} 归一化后的规范值（无法识别时保留原值）
 */
export function normalizeEvalField(field, raw) {
  if (raw === null || raw === undefined) return ''
  let v = String(raw).trim()
  if (!v || v === '未知') return ''

  // 1. 解开 JSON 数组字符串包装：["点放射状屏裂"] → 点放射状屏裂
  const unwrapped = v.match(/^\[\s*"?([^"]*)"?\s*\]$/)
  if (unwrapped) v = unwrapped[1].trim()

  // 2. 括号统一为全角（规范值使用全角括号，如 网状(大面积无规则)屏裂）
  v = v.replace(/[(]/g, '（').replace(/[)]/g, '）')

  // 3. 去除标点后的纯文本（用于精确/子串匹配）
  const plain = v.replace(STRIP_PUNCT, '').trim()

  if (field === 'conclusion') {
    // 已是代码 → 保留
    const codes = canonicalOptions('conclusion')
    if (codes.includes(plain) || codes.includes(v)) return codes.includes(plain) ? plain : v
    // 中文标签 → 代码
    if (CONCLUSION_LABEL_TO_CODE[plain]) return CONCLUSION_LABEL_TO_CODE[plain]
    if (CONCLUSION_LABEL_TO_CODE[v]) return CONCLUSION_LABEL_TO_CODE[v]
    // 子串匹配（长标签优先，避免"产品质量问题"误匹配"非产品质量问题"）
    const labels = Object.keys(CONCLUSION_LABEL_TO_CODE).sort((a, b) => b.length - a.length)
    for (const label of labels) {
      if (v.includes(label) || plain.includes(label)) return CONCLUSION_LABEL_TO_CODE[label]
    }
    return plain || v
  }

  // 4. 精确命中规范选项
  const options = canonicalOptions(field)
  if (options.includes(plain) || options.includes(v)) return options.includes(plain) ? plain : v

  // 5. 别名子串匹配
  const aliasMap = ALIAS[field] || {}
  for (const [key, mapped] of Object.entries(aliasMap)) {
    if (v.includes(key)) return mapped
  }

  // 6. 规范选项子串匹配（长选项优先；单字符过于模糊，跳过避免误匹配，如"无"命中"无规则"）
  if (v.length >= 2) {
    const sorted = [...options].sort((a, b) => b.length - a.length)
    for (const o of sorted) {
      if (o && (v.includes(o) || o.includes(v))) return o
    }
  }

  return plain || v
}
