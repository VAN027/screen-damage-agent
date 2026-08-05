import { createServer, json } from './server-utils.mjs'
import { searchSimilar, getCaseById, getStats, listCases, createCase, updateCase, deleteCase, batchDeleteCases, batchImport, validateCase, getImagePath, batchImportFromImages, loadTraining, addTraining, getTrainingStats, searchSimilarVector, indexCaseVector, rebuildVectorIndex, isClipAvailable, saveCorrection, getResultStats, analyzeWithRAG, aggregateRAGFields } from './search-engine.mjs'
import { analyzeWithLLM, analyzeWithLLMStream, loadModelConfig, saveModelConfig, loadAnnotationConfig, saveAnnotationConfig, annotateSingle, annotateBatch } from './llm-analyzer.mjs'
import { uploadDocument, listDocuments, getDocument, deleteDocument, getKBStats, searchKB } from './knowledge-base.mjs'
import { normalizeEvalField } from './field-normalize.mjs'
import { readFile, stat } from 'node:fs/promises'
import { loadFieldDefsSync, loadFieldDefs } from './db.mjs'

// 加载集中式字段定义
const _fieldDefs = loadFieldDefsSync()
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PORT = parseInt(process.env.KNOWLEDGE_PORT || '8083', 10)
const startTime = Date.now()

function normalizeQuery(q) {
  return {
    symptoms: q.symptoms || [],
    crackShape: q.crackShape || '',
    physicalFeature: q.physicalFeature || '',
    liquidState: q.liquidState || '',
    installStatus: q.installStatus || '',
    result: q.result || '',
    excludeId: q.excludeId || '',
    topK: Math.min(parseInt(q.topK) || 3, 10),
  }
}

// 归一化结论标签（中文/英文统一）
function normConcLabel(val) {
  if (!val || val === '') return ''
  const map = { product_quality_issue: '产品质量问题', not_product_quality: '非产品质量问题', no_damage: '屏幕完好' }
  return map[val] || val
}

// 生成汇总分析 Sheet（按形态准确率、混淆矩阵、专项分析）
function buildSummarySheet(wb, records) {
  const ws = wb.addWorksheet('汇总分析')

  const bold = { bold: true }
  const blueBg = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } }
  const whiteFont = { bold: true, color: { argb: 'FFFFFFFF' } }
  const greenBg = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } }
  const redBg = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } }
  const grayBg = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } }
  const center = { horizontal: 'center', vertical: 'middle' }
  const wrap = { horizontal: 'left', vertical: 'middle', wrapText: true }
  const pct = (ok, total) => total > 0 ? Math.round(ok / total * 100) : null
  const pctStr = (ok, total) => total > 0 ? Math.round(ok / total * 100) + '%' : '-'

  // 只取已 LLM 分析的
  const analyzed = records.filter(r => r.analyzed)
  const judged = records.filter(r => r.match_conclusion !== -1 || r.match_location !== -1)

  let rowIdx = 1
  const sectionTitle = (text) => {
    const r = ws.getRow(rowIdx)
    r.getCell(1).value = text
    r.getCell(1).font = { bold: true, size: 13, color: { argb: 'FF1E40AF' } }
    r.height = 24
    rowIdx++
  }

  const headerRow = (cells) => {
    cells.forEach((v, i) => {
      const c = ws.getRow(rowIdx).getCell(i + 1)
      c.value = v; c.font = whiteFont; c.fill = blueBg; c.alignment = center
    })
    ws.getRow(rowIdx).height = 20
    rowIdx++
  }

  const dataRow = (cells, highlights = []) => {
    cells.forEach((v, i) => {
      const c = ws.getRow(rowIdx).getCell(i + 1)
      c.value = v; c.alignment = center
      if (highlights[i]) c.fill = highlights[i]
    })
    rowIdx++
  }

  // ===== 0. 总览看板 =====
  sectionTitle('▎总览看板')
  const totalAll = records.length
  const totalAnalyzed = analyzed.length
  const totalJudged = judged.length
  const allOk6 = analyzed.filter(r =>
    ['status_obs','location','shape','principle','conclusion'].every(f => r['match_'+f] === 1)
  ).length
  const allJudged6 = analyzed.filter(r =>
    ['status_obs','location','shape','principle','conclusion'].every(f => r['match_'+f] !== -1)
  ).length
  headerRow(['指标', '数值', '说明'])
  dataRow(['总案例数', totalAll, '数据库全部记录'])
  dataRow(['LLM已分析', totalAnalyzed, totalAll ? pctStr(totalAnalyzed, totalAll)+' 覆盖率' : '-'])
  dataRow(['已人工标注', totalJudged, totalAnalyzed ? pctStr(totalJudged, totalAnalyzed)+' 标注率' : '-'])
  dataRow(['六字段全正确', allOk6, allJudged6 ? pctStr(allOk6, allJudged6)+' (占已标注六字段)' : '-'])
  rowIdx++

  // 各字段准确率一行总览
  headerRow([' ', '状态观察', '故障位置', '故障形态', '故障原理', '鉴定结论'])
  const accRow = ['准确率']
  for (const f of ['status_obs','location','shape','principle','conclusion']) {
    const hh = analyzed.filter(r => r['match_'+f] !== -1)
    const oo = hh.filter(r => r['match_'+f] === 1).length
    accRow.push(pctStr(oo, hh.length))
  }
  dataRow(accRow)
  rowIdx++

  // ===== 1. 整体准确率 =====
  sectionTitle('一、各字段整体准确率')
  const judgedCount = judged.length
  headerRow(['字段', 'LLM分析数', '已标注数', '正确数', '错误数', '准确率'])
  for (const { key, label } of [
    { key: 'status_obs', label: '状态观察' },
    { key: 'location', label: '故障位置' },
    { key: 'shape', label: '故障形态' },
    { key: 'principle', label: '故障原理' },
    { key: 'conclusion', label: '鉴定结论' },
  ]) {
    const hasJ = analyzed.filter(r => r['match_' + key] !== -1)
    const ok = hasJ.filter(r => r['match_' + key] === 1).length
    const ng = hasJ.filter(r => r['match_' + key] === 0).length
    const rate = pct(ok, hasJ.length)
    const bg = rate !== null && rate >= 70 ? greenBg : (rate !== null ? redBg : undefined)
    dataRow([label, analyzed.length, hasJ.length, ok, ng, pctStr(ok, hasJ.length)], [,,,,, bg])
  }

  // 空白行
  rowIdx++

  // ===== 2. 按故障形态分组 =====
  sectionTitle('二、按故障形态分组准确率')
  headerRow(['故障形态', '数量', '状态观察', '故障位置', '故障形态', '故障原理', '鉴定结论'])

  const shapeGroups = {}
  for (const r of analyzed) {
    const s = r.llm_shape || '(无)'
    if (!shapeGroups[s]) shapeGroups[s] = { total: 0, counts: {} }
    shapeGroups[s].total++
    for (const f of ['status_obs', 'location', 'shape', 'principle', 'conclusion']) {
      if (!shapeGroups[s].counts[f]) shapeGroups[s].counts[f] = { ok: 0, total: 0 }
      if (r['match_' + f] !== -1) {
        shapeGroups[s].counts[f].total++
        if (r['match_' + f] === 1) shapeGroups[s].counts[f].ok++
      }
    }
  }
  const sortedShapes = Object.entries(shapeGroups).sort((a, b) => b[1].total - a[1].total)
  for (const [shape, g] of sortedShapes) {
    const fields = ['status_obs', 'location', 'shape', 'principle', 'conclusion']
    const cells = [shape, g.total]
    const highlights = []
    for (const f of fields) {
      const { ok, total } = g.counts[f]
      cells.push(pctStr(ok, total))
      const r = pct(ok, total)
      highlights.push(r !== null && r >= 70 ? greenBg : (r !== null ? redBg : grayBg))
    }
    dataRow(cells, [,,...highlights])
  }

  rowIdx++

  // ===== 3. 鉴定结论混淆矩阵 =====
  sectionTitle('三、鉴定结论混淆矩阵 (LLM预测 vs 人工判定)')
  const humanConcs = new Set()
  const cross = {}
  for (const r of judged) {
    const llm = normConcLabel(r.llm_conclusion) || '(无)'
    const human = normConcLabel(r.human_conclusion) || (r.match_conclusion === 1 ? llm : '(未填)')
    humanConcs.add(human)
    if (!cross[llm]) cross[llm] = {}
    cross[llm][human] = (cross[llm][human] || 0) + 1
  }
  const sortedHuman = [...humanConcs].sort()
  headerRow(['LLM预测 ↓  人工判定 →', ...sortedHuman])

  for (const llm of Object.keys(cross).sort()) {
    const cells = [llm]
    const highlights = []
    for (const h of sortedHuman) {
      const v = cross[llm][h] || 0
      cells.push(v === 0 ? '-' : v)
      highlights.push(llm === h ? greenBg : (v > 0 ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } } : undefined))
    }
    dataRow(cells, [, ...highlights])
  }

  rowIdx++

  // ===== 4. 漏液/熔屏专项 =====
  sectionTitle('四、质量类故障专项分析 (漏液、熔屏)')
  for (const qs of ['漏液', '熔屏']) {
    const subset = analyzed.filter(r => r.llm_shape && r.llm_shape.includes(qs))
    if (subset.length === 0) {
      dataRow([qs, '无数据', '', '', '', ''])
      continue
    }
    rowIdx++ // blank
    sectionTitle(`  ▸ ${qs} (${subset.length}例)`)
    headerRow(['字段', 'LLM分析数', '已标注数', '正确数', '错误数', '准确率'])
    for (const { key, label } of [
      { key: 'status_obs', label: '状态观察' },
      { key: 'location', label: '故障位置' },
      { key: 'shape', label: '故障形态' },
      { key: 'principle', label: '故障原理' },
      { key: 'conclusion', label: '鉴定结论' },
    ]) {
      const hasJ = subset.filter(r => r['match_' + key] !== -1)
      const ok = hasJ.filter(r => r['match_' + key] === 1).length
      const ng = hasJ.filter(r => r['match_' + key] === 0).length
      const rate = pct(ok, hasJ.length)
      const bg = rate !== null && rate >= 70 ? greenBg : (rate !== null ? redBg : undefined)
      dataRow([label, subset.length, hasJ.length, ok, ng, pctStr(ok, hasJ.length)], [,,,,, bg])
    }
    // 误判统计
    const pq2npq = subset.filter(r => r.match_conclusion === 0 && normConcLabel(r.llm_conclusion) === '产品质量问题' && normConcLabel(r.human_conclusion, '') === '非产品质量问题')
    const npq2pq = subset.filter(r => r.match_conclusion === 0 && normConcLabel(r.llm_conclusion) === '非产品质量问题' && normConcLabel(r.human_conclusion, '') === '产品质量问题')
    const noDam = subset.filter(r => r.match_conclusion === 0 && normConcLabel(r.llm_conclusion) === '屏幕完好')
    const errLines = []
    if (pq2npq.length > 0) errLines.push(`产品质量→非产品质量误判: ${pq2npq.length}例`)
    if (npq2pq.length > 0) errLines.push(`非产品质量→产品质量漏判: ${npq2pq.length}例`)
    if (noDam.length > 0) errLines.push(`判为屏幕完好但有故障: ${noDam.length}例`)
    if (errLines.length > 0) {
      dataRow(['结论误判', errLines.join('\n'), '', '', '', ''], [{ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } }])
    }
  }

  rowIdx++

  // ===== 5. 全局结论误判 =====
  sectionTitle('五、全局结论误判统计')
  headerRow(['误判类型', '数量', '占比', '涉及形态'])
  const globalPq2npq = analyzed.filter(r => r.match_conclusion === 0 && normConcLabel(r.llm_conclusion) === '产品质量问题' && normConcLabel(r.human_conclusion, '') === '非产品质量问题')
  const globalNpq2pq = analyzed.filter(r => r.match_conclusion === 0 && normConcLabel(r.llm_conclusion) === '非产品质量问题' && normConcLabel(r.human_conclusion, '') === '产品质量问题')
  const globalDam = analyzed.filter(r => r.match_conclusion === 0 && normConcLabel(r.llm_conclusion) === '屏幕完好')
  const globalNd = analyzed.filter(r => r.match_conclusion === 0 && normConcLabel(r.llm_conclusion) !== '屏幕完好' && normConcLabel(r.human_conclusion, '') === '屏幕完好')

  const errSummary = [
    { label: '产品质量→非产品质量误判', list: globalPq2npq },
    { label: '非产品质量→产品质量漏判', list: globalNpq2pq },
    { label: '判为屏幕完好但有故障', list: globalDam },
    { label: '判为有故障但屏幕完好', list: globalNd },
  ]
  for (const { label, list } of errSummary) {
    const shapes = [...new Set(list.map(r => r.llm_shape || '-'))].join(', ')
    dataRow([label, list.length, pctStr(list.length, analyzed.length), shapes || '-'])
  }

  rowIdx++

  // ===== 6. 六字段联合通过率分布 =====
  sectionTitle('六、六字段联合通过率分布')
  headerRow(['通过字段数', '案例数', '占比', '累计占比'])
  const all5Judged = analyzed.filter(r =>
    ['status_obs','location','shape','principle','conclusion'].every(f => r['match_'+f] !== -1)
  )
  const passDist = {5:0, 4:0, 3:0, 2:0, 1:0, 0:0}
  for (const r of all5Judged) {
    const ok = ['status_obs','location','shape','principle','conclusion'].filter(f => r['match_'+f] === 1).length
    passDist[ok]++
  }
  let cumulative = 0
  const total5 = all5Judged.length
  for (let n = 5; n >= 0; n--) {
    if (n < 5 && passDist[n] === 0 && passDist[n-1] === 0) continue
    cumulative += passDist[n]
    dataRow([`${n}/5 字段正确`, passDist[n], pctStr(passDist[n], total5), pctStr(cumulative, total5)])
  }

  rowIdx++

  // ===== 7. 严重程度分布分析 =====
  sectionTitle('七、严重程度分布 (LLM判定)')
  headerRow(['严重程度', '案例数', '占比'])
  const sevCounts = {}
  for (const r of analyzed) {
    const s = r.llm_severity || '(未判定)'
    sevCounts[s] = (sevCounts[s] || 0) + 1
  }
  const sortedSev = Object.entries(sevCounts).sort((a, b) => b[1] - a[1])
  for (const [sev, cnt] of sortedSev) {
    dataRow([sev, cnt, pctStr(cnt, analyzed.length)])
  }

  rowIdx++

  // ===== 8. 故障环节准确率 =====
  sectionTitle('八、故障环节/阶段准确率')
  const stageJudged = analyzed.filter(r => r.match_stage !== -1)
  const stageOk = stageJudged.filter(r => r.match_stage === 1).length
  const stageNg = stageJudged.filter(r => r.match_stage === 0).length
  headerRow(['字段', 'LLM分析数', '已标注数', '正确数', '错误数', '准确率'])
  dataRow(['故障环节', analyzed.length, stageJudged.length, stageOk, stageNg, pctStr(stageOk, stageJudged.length)])
  rowIdx++
  sectionTitle('  ▸ 故障环节值分布 (LLM vs 人工)')
  const stageCross = {}
  const humanStages = new Set()
  for (const r of stageJudged) {
    const llmS = r.llm_stage || '(无)'
    const humanS = r.human_stage || (r.match_stage === 1 ? llmS : '(未填)')
    humanStages.add(humanS)
    if (!stageCross[llmS]) stageCross[llmS] = {}
    stageCross[llmS][humanS] = (stageCross[llmS][humanS] || 0) + 1
  }
  const sortedHStages = [...humanStages].sort()
  headerRow(['LLM ↓  人工 →', ...sortedHStages])
  for (const llmS of Object.keys(stageCross).sort()) {
    dataRow([llmS, ...sortedHStages.map(h => stageCross[llmS][h] || '-')])
  }

  rowIdx++

  // ===== 9. 每字段各选项准确率明细 =====
  sectionTitle('九、每字段各选项准确率明细')
  const detailFields = [
    { key: 'status_obs', label: '状态观察', llmField: 'llm_status_obs' },
    { key: 'location', label: '故障位置', llmField: 'llm_location' },
    { key: 'shape', label: '故障形态', llmField: 'llm_shape' },
    { key: 'principle', label: '故障原理', llmField: 'llm_principle' },
  ]
  for (const { key, label, llmField } of detailFields) {
    rowIdx++
    sectionTitle(`  ▸ ${label}`)
    headerRow(['LLM选项值', '出现次数', '已标注数', '正确数', '错误数', '准确率'])
    const optionStats = {}
    for (const r of analyzed) {
      const val = r[llmField] || '(空)'
      if (!optionStats[val]) optionStats[val] = { total: 0, ok: 0, judged: 0 }
      optionStats[val].total++
      if (r['match_' + key] !== -1) {
        optionStats[val].judged++
        if (r['match_' + key] === 1) optionStats[val].ok++
      }
    }
    const sortedOpts = Object.entries(optionStats).sort((a, b) => b[1].total - a[1].total)
    for (const [opt, st] of sortedOpts) {
      const rate = pct(st.ok, st.judged)
      const bg = rate !== null && rate >= 70 ? greenBg : (rate !== null ? redBg : undefined)
      dataRow([opt, st.total, st.judged, st.ok, st.judged - st.ok, pctStr(st.ok, st.judged)], [,,,,, bg])
    }
  }

  rowIdx++

  // ===== 10. 误判案例明细 =====
  sectionTitle('十、误判案例明细 (鉴定结论不一致)')
  const wrongConcs = analyzed.filter(r => r.match_conclusion === 0)
  if (wrongConcs.length === 0) {
    dataRow(['无结论误判案例', '', '', '', '', ''])
  } else {
    headerRow(['ID', '案例名称', '故障形态', 'LLM结论', '人工结论', '误判类型'])
    for (const r of wrongConcs) {
      const llmC = normConcLabel(r.llm_conclusion) || ''
      const humanC = normConcLabel(r.human_conclusion) || (r.match_conclusion === 0 ? '(人工未填)' : '')
      let errType = ''
      if (llmC === '产品质量问题' && (humanC === '非产品质量问题' || humanC === '')) errType = '产品质量→非产品质量误判'
      else if (llmC === '非产品质量问题' && (humanC === '产品质量问题' || humanC === '')) errType = '非产品质量→产品质量漏判'
      else if (llmC === '屏幕完好') errType = '判为屏幕完好但有故障'
      else errType = '其他'
      dataRow([r.id, r.case_title || '', r.llm_shape || '', llmC, humanC === '' ? '(人工未填)' : humanC, errType])
    }
  }

  // 列宽
  ws.columns = [
    { width: 26 }, { width: 14 }, { width: 14 }, { width: 20 }, { width: 14 }, { width: 16 }, { width: 14 },
    { width: 14 }, { width: 14 }, { width: 16 }, { width: 14 }, { width: 14 },
  ]

  // 冻结首行
  ws.views = [{ state: 'frozen', ySplit: 1 }]
}

const routes = [
  {
    method: 'GET',
    path: '/api/health',
    handler: async (_req, res) => {
      const clipOk = await isClipAvailable()
      json(res, 200, {
        service: 'knowledge-ai',
        status: 'ok',
        uptime: Date.now() - startTime,
        version: '2.0.0',
        engine: clipOk ? 'DINOv2-ViT-S/14 (384-dim)' : 'label-match (vector service unavailable)',
      })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/cases/result-stats',
    handler: async (_req, res, { query }) => {
      const shapeVal = query.crackShape || ''
      // 支持逗号分隔的多值形态（如 "点放射状屏裂,网状屏裂"）
      const shapes = shapeVal ? shapeVal.split(',').map(s => s.trim()).filter(Boolean) : []
      const result = await getResultStats(shapes, query.crackStage || '')
      json(res, 200, { success: true, data: result })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/stats',
    handler: async (_req, res) => {
      const stats = await getStats()
      json(res, 200, { success: true, data: stats })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/backup',
    handler: async (_req, res) => {
      try {
        const { backupDb, checkpointWal } = await import('./db.mjs')
        checkpointWal()
        const path = await backupDb()
        json(res, 200, { success: true, data: { path, message: '数据库已备份' } })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'BACKUP_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/case',
    handler: async (_req, res, { query }) => {
      const c = await getCaseById(query.id)
      if (!c) return json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: '案例不存在' } })
      json(res, 200, { success: true, data: c })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/search',
    handler: async (_req, res, { body }) => {
      // 优先使用向量检索（融合标签加权）
      if (body.imageBase64) {
        try {
          const queryLabels = {
            symptoms: body.symptoms || [],
            crackShape: body.crackShape || '',
            crackLocation: body.crackLocation || '',
            physicalFeature: body.physicalFeature || '',
            liquidState: body.liquidState || '',
            installStatus: body.installStatus || '',
            result: body.result || '',
          }
          const results = await searchSimilarVector(body.imageBase64, body.topK || 5, body.excludeId || '', queryLabels)
          if (results.length > 0) {
            return json(res, 200, {
              success: true,
              data: {
                query: body,
                totalHits: results.length,
                engine: 'vector+label-fusion (PIL+Numpy 512-dim)',
                results: results.map(r => ({
                  id: r.id,
                  title: r.title,
                  deviceModel: r.deviceModel,
                  resultLabel: r.resultLabel,
                  similarity: r.similarity,
                  vecSimilarity: r.vecSimilarity,
                  labelSimilarity: r.labelSimilarity,
                  summary: r.summary,
                  tags: r.tags,
                  possibleCause: r.possibleCause || '',
                  warrantyTip: r.warrantyTip || '',
                  image: r.image,
                })),
              },
            })
          }
        } catch {
          // 向量检索失败，回退到标签匹配
        }
      }

      // 回退：标签加权匹配
      const q = normalizeQuery(body)
      const { getCaseImages } = await import('./search-engine.mjs')
      const results = await searchSimilar(q, q.topK)
      json(res, 200, {
        success: true,
        data: {
          query: body,
          totalHits: results.length,
          engine: 'multi-label-weighted-match (fallback)',
          results: results.map(r => ({
            id: r.id,
            title: r.title,
            deviceModel: r.deviceModel,
            resultLabel: r.resultLabel,
            similarity: r.similarity,
            summary: r.summary,
            tags: r.tags,
            possibleCause: r.possibleCause || '',
            warrantyTip: r.warrantyTip || '',
            image: getCaseImages(r)[0] || r.image || '',
          })),
        },
      })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/search-vector',
    handler: async (_req, res, { body }) => {
      if (!body.imageBase64) return json(res, 400, { success: false, error: { code: 'MISSING_IMAGE', message: '缺少图片数据 imageBase64' } })
      try {
        const queryLabels = body.labels || null
        const results = await searchSimilarVector(body.imageBase64, body.topK || 5, body.excludeId || '', queryLabels)
        // 仅RAG模式：附上 Top-K 加权投票聚合的结构化识别结果
        let aggregated = null
        if (body.mode === 'rag' && results.length > 0) {
          aggregated = aggregateRAGFields(results)
        }
        json(res, 200, {
          success: true,
          data: {
            query: { imageSize: body.imageBase64.length },
            totalHits: results.length,
            engine: 'vector+label-fusion (PIL+Numpy 512-dim)',
            results,
            aggregated,
          },
        })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'VECTOR_SEARCH_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/vector-stats',
    handler: async (_req, res) => {
      try {
        const clipOk = await isClipAvailable()
        json(res, 200, { success: true, data: { clipAvailable: clipOk } })
      } catch (e) {
        json(res, 200, { success: true, data: { clipAvailable: false, error: e.message } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/rebuild-index',
    handler: async (_req, res) => {
      try {
        const result = await rebuildVectorIndex()
        json(res, 200, { success: true, data: result })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'REBUILD_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/extract',
    handler: async (_req, res, { body }) => {
      // 如果提供了 base64 图片，通过 CLIP 服务提取特征
      if (body && body.imageBase64) {
        try {
          const { extractFeatures } = await import('./clip-client.mjs')
          const result = await extractFeatures(body.imageBase64)
          return json(res, 200, {
            success: true,
            data: {
              embeddingId: result.embedding_id,
              vector: result.vector,
              model: result.model,
              dim: result.dim,
            },
          })
        } catch (e) {
          return json(res, 503, {
            success: false,
            error: { code: 'CLIP_UNAVAILABLE', message: 'CLIP 服务不可用: ' + e.message },
          })
        }
      }

      // 无图片时的信息响应
      json(res, 200, {
        success: true,
        data: {
          message: '请提供 imageBase64 进行 CLIP 特征提取。CLIP ViT-B/32 提取 512 维向量。',
          modelInfo: {
            name: 'CLIP ViT-B/32',
            dim: 512,
            status: 'ready',
          },
        },
      })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/cases',
    handler: async (_req, res, { query }) => {
      const filter = {}
      if (query.result) filter.result = query.result
      if (query.keyword) filter.keyword = query.keyword
      const cases = await listCases(filter)
      json(res, 200, { success: true, data: cases })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/cases',
    handler: async (_req, res, { body }) => {
      const errs = await validateCase(body, 0)
      if (errs.length > 0) return json(res, 400, { success: false, error: { code: 'VALIDATION_ERROR', message: errs.join('; ') } })
      const c = await createCase(body)
      json(res, 201, { success: true, data: c })
    },
  },
  {
    method: 'PUT',
    path: '/api/knowledge/cases',
    handler: async (_req, res, { body }) => {
      if (!body.id) return json(res, 400, { success: false, error: { code: 'MISSING_ID', message: '缺少案例 id' } })
      try {
        const c = await updateCase(body.id, body)
        json(res, 200, { success: true, data: c })
      } catch (e) {
        json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: e.message } })
      }
    },
  },
  {
    method: 'DELETE',
    path: '/api/knowledge/cases',
    handler: async (_req, res, { query }) => {
      if (!query.id) return json(res, 400, { success: false, error: { code: 'MISSING_ID', message: '缺少案例 id' } })
      const ok = await deleteCase(query.id)
      if (!ok) return json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: '案例不存在' } })
      json(res, 200, { success: true, data: { id: query.id, deleted: true } })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/cases/batch-delete',
    handler: async (_req, res, { body }) => {
      if (!body.ids || !Array.isArray(body.ids) || body.ids.length === 0) return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '请提供 ids 数组' } })
      const result = await batchDeleteCases(body.ids)
      json(res, 200, { success: true, data: result })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/cases/batch',
    handler: async (_req, res, { body }) => {
      if (!body.items || !Array.isArray(body.items)) return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '请提供 items 数组' } })
      const result = await batchImport(body.items)
      const status = result.failed === 0 ? 200 : (result.imported === 0 ? 400 : 207)
      json(res, status, { success: result.failed === 0, data: result })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/images',
    handler: async (_req, res, { query }) => {
      if (!query.name) return json(res, 400, { success: false, error: { code: 'MISSING_NAME', message: '缺少图片文件名' } })
      try {
        const filepath = getImagePath(query.name)
        const data = await readFile(filepath)
        const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }
        const ct = mime[extname(query.name).toLowerCase()] || 'image/jpeg'
        res.writeHead(200, { 'Content-Type': ct, 'Content-Length': data.length, 'Cache-Control': 'public, max-age=86400' })
        res.end(data)
      } catch {
        json(res, 404, { success: false, error: { code: 'IMAGE_NOT_FOUND', message: '图片不存在' } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/cases/from-images',
    handler: async (_req, res, { body }) => {
      if (!body.images || !Array.isArray(body.images)) return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '请提供 images 数组' } })
      if (body.images.length > 100) return json(res, 400, { success: false, error: { code: 'TOO_MANY', message: '单次最多导入 100 张图片' } })
      const defaults = body.defaults || {}
      const result = await batchImportFromImages(body.images, defaults)
      const status = result.failed === 0 ? 200 : (result.imported === 0 ? 400 : 207)
      json(res, status, { success: result.failed === 0, data: result })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/training',
    handler: async (_req, res) => {
      const data = await loadTraining()
      const stats = await getTrainingStats()
      json(res, 200, { success: true, data: { entries: data, stats } })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/training',
    handler: async (_req, res, { body }) => {
      if (!body.features || !Array.isArray(body.features)) return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '缺少特征向量 features' } })
      if (!body.location || !body.shape) return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '缺少 location 或 shape 标签' } })
      if (body.features.length !== 35) return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '特征向量必须为 35 维' } })
      const count = await addTraining(body)
      json(res, 201, { success: true, data: { total: count, message: `训练数据已添加，当前共 ${count} 条` } })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/correction',
    handler: async (_req, res, { body }) => {
      if (!body.correctedLocation || !body.correctedShape || !body.correctedStage || !body.correctedConclusion) {
        return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '缺少必填字段（故障位置/形态/环节/结论）' } })
      }
      try {
        const result = await saveCorrection(body)
        json(res, 201, { success: true, data: result })
      } catch (err) {
        json(res, 500, { success: false, error: { code: 'SAVE_FAILED', message: err.message } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/analyze-llm',
    handler: async (_req, res, { body }) => {
      const images = body.images || (body.image ? [body.image] : null)
      if (!images || !images.length) return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '缺少图片数据 image 或 images (base64 数组)' } })
      try {
        // mode: hybrid=RAG+LLM混合(默认) | rag=仅RAG识别 | llm=仅LLM识别
        const mode = body.mode || 'hybrid'
        let result
        if (mode === 'rag') {
          result = await analyzeWithRAG(images[0], body.topK || 5)
        } else {
          result = await analyzeWithLLM(images, body.context, null, { skipRag: mode === 'llm' })
        }
        json(res, 200, { success: true, data: result })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'LLM_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/analyze-llm-stream',
    handler: async (_req, res, { body }) => {
      const images = body.images || (body.image ? [body.image] : null)
      if (!images || !images.length) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ success: false, error: { code: 'INVALID_FORMAT', message: '缺少图片数据 image 或 images (base64 数组)' } }))
        return
      }

      // SSE 响应头
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })

      const send = (event) => {
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`)
        } catch {
          // 客户端已断开
        }
      }

      try {
        // mode: hybrid=RAG+LLM混合(默认) | rag=仅RAG识别 | llm=仅LLM识别
        const mode = body.mode || 'hybrid'
        if (mode === 'rag') {
          const result = await analyzeWithRAG(images[0], body.topK || 5)
          send({ stage: 'done', percent: 100, message: `RAG 识别完成！命中 ${result.totalHits} 条案例`, result })
        } else {
          const result = await analyzeWithLLMStream(images, send, body.context, { skipRag: mode === 'llm' })
          send({ stage: 'done', percent: 100, message: '分析完成！', result })
        }
      } catch (e) {
        send({ stage: 'error', message: e.message || '分析失败' })
      } finally {
        res.end()
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/annotate-single',
    handler: async (_req, res, { body }) => {
      if (!body.image || !body.image.startsWith('data:image/')) {
        return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '缺少有效的 base64 图片' } })
      }
      try {
        const result = await annotateSingle(body.image)
        json(res, 200, { success: true, data: result })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'LLM_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/annotate-batch',
    handler: async (_req, res, { body }) => {
      if (!body.images || !Array.isArray(body.images) || body.images.length === 0) {
        return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '缺少有效的图片数组' } })
      }
      try {
        const result = await annotateBatch(body.images)
        json(res, 200, { success: true, data: result })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'LLM_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/model-config',
    handler: async (_req, res) => {
      const config = await loadModelConfig()
      // 隐藏部分 API Key
      const masked = { ...config, apiKey: config.apiKey ? config.apiKey.substring(0, 8) + '****' + config.apiKey.substring(config.apiKey.length - 4) : '' }
      json(res, 200, { success: true, data: masked })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/model-config',
    handler: async (_req, res, { body }) => {
      const config = await loadModelConfig()
      const updated = { ...config, ...body }
      // 如果 API Key 包含 **** 说明是脱敏后的值，保留原来的 Key
      if (body.apiKey && body.apiKey.includes('****')) {
        delete updated.apiKey
        updated.apiKey = config.apiKey
      }
      await saveModelConfig(updated)
      json(res, 200, { success: true, data: { message: '模型配置已保存' } })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/annotation-config',
    handler: async (_req, res) => {
      const config = await loadAnnotationConfig()
      const masked = { ...config, apiKey: config.apiKey ? config.apiKey.substring(0, 8) + '****' + config.apiKey.substring(config.apiKey.length - 4) : '' }
      json(res, 200, { success: true, data: masked })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/annotation-config',
    handler: async (_req, res, { body }) => {
      const config = await loadAnnotationConfig()
      const updated = { ...config, ...body }
      if (body.apiKey && body.apiKey.includes('****')) {
        delete updated.apiKey
        updated.apiKey = config.apiKey
      }
      await saveAnnotationConfig(updated)
      json(res, 200, { success: true, data: { message: '标注模型配置已保存' } })
    },
  },
  // ===== 集中式字段定义 API =====
  {
    method: 'GET',
    path: '/api/knowledge/field-defs',
    handler: async (_req, res) => {
      const defs = await loadFieldDefs()
      json(res, 200, { success: true, data: defs })
    },
  },
  // ===== 鉴定评估 API =====
  {
    method: 'GET',
    path: '/api/knowledge/eval/list',
    handler: async (_req, res) => {
      const { getAllEvals, getEvalStats } = await import('./db.mjs')
      const list = getAllEvals()
      const stats = getEvalStats()
      json(res, 200, { success: true, data: { list, stats } })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/eval/create',
    handler: async (_req, res, { body }) => {
      if (!body.caseIds || !Array.isArray(body.caseIds)) {
        return json(res, 400, { success: false, error: { code: 'INVALID', message: '缺少 caseIds 数组' } })
      }
      const { createEvalBatch } = await import('./db.mjs')
      let caseList = body.caseList
      if (!caseList) {
        const { listCases } = await import('./search-engine.mjs')
        const allCases = await listCases()
        const idSet = new Set(body.caseIds)
        caseList = allCases.filter(c => idSet.has(c.id)).map(c => ({
          case_id: c.id,
          case_title: c.title || '未命名',
          image_name: (c.images && c.images[0]) || c.image || '',
        }))
      }
      const results = createEvalBatch(caseList)
      json(res, 200, { success: true, data: { count: results.length } })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/eval/upload-images',
    handler: async (_req, res, { body }) => {
      const { images } = body || {}
      if (!images || !Array.isArray(images) || images.length === 0) {
        return json(res, 400, { success: false, error: { code: 'INVALID', message: '请上传至少一张图片' } })
      }
      try {
        const { createCase } = await import('./search-engine.mjs')
        const { createEvalBatch } = await import('./db.mjs')
        const caseList = []
        for (let i = 0; i < images.length; i++) {
          const dataUrl = images[i]
          if (!dataUrl || !dataUrl.startsWith('data:image/')) continue
          const c = await createCase({
            imageDataList: [dataUrl],
            title: `评估图片 ${new Date().toLocaleString('zh-CN')} #${i + 1}`,
            resultLabel: '',
          })
          caseList.push({
            case_id: c.id,
            case_title: c.title,
            image_name: (c.images && c.images[0]) || '',
          })
        }
        const results = createEvalBatch(caseList)
        json(res, 200, { success: true, data: { count: results.length, total: images.length } })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'UPLOAD_FAILED', message: e.message } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/eval/save',
    handler: async (_req, res, { body }) => {
      if (!body.id) return json(res, 400, { success: false, error: { code: 'MISSING_ID', message: '缺少记录 id' } })
      const { saveEvalAnnotation } = await import('./db.mjs')
      const result = saveEvalAnnotation(body.id, body)
      json(res, 200, { success: true, data: result || { id: body.id } })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/eval/batch-analyze',
    handler: async (_req, res) => {
      try {
      const { getAllEvals, saveEvalLLMResult, saveEvalRAGResult } = await import('./db.mjs')
      const { analyzeWithLLM } = await import('./llm-analyzer.mjs')
      const { getCaseById, searchSimilarVector } = await import('./search-engine.mjs')

      const records = getAllEvals().filter(r => !r.analyzed)
      let done = 0, errors = 0

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })
      const send = (evt) => { try { res.write(`data: ${JSON.stringify(evt)}\n\n`) } catch {} }
      let aborted = false
      const llmController = new AbortController()
      _req.on('close', () => {
        aborted = true
        llmController.abort()
      })

      for (const rec of records) {
        if (aborted) break
        try {
          const c = await getCaseById(rec.case_id)
          if (!c) { errors++; send({ stage: 'progress', id: rec.id, status: 'skipped', done: ++done, total: records.length, reason: '案例不存在' }); continue }
          const imageName = c.images?.[0] || c.image
          if (!imageName) { errors++; send({ stage: 'progress', id: rec.id, status: 'skipped', done: ++done, total: records.length, reason: '无图片' }); continue }
          const { getImagePath: getPath } = await import('./search-engine.mjs')
          const imgPath = getPath(imageName)
          const imgDataUrl = `data:image/${imageName.endsWith('png') ? 'png' : (imageName.endsWith('jpg') || imageName.endsWith('jpeg') ? 'jpeg' : 'webp')};base64,${Buffer.from(await import('node:fs/promises').then(m => m.readFile(imgPath))).toString('base64')}`

          const result = await analyzeWithLLM([imgDataUrl], null, llmController.signal)
          const desc = result.description || ''

          // 直接从 LLM JSON 输出取字段（不再需要正则回捞）
          const llmLocation = (result.location && result.location !== '未知') ? result.location : ''
          const llmShape = (result.shape && result.shape !== '未知') ? result.shape : ''
          const llmStage = result.stage || ''
          const llmConclusion = result.conclusion || ''
          const llmStatusObs = result.statusObs || ''
          const llmPrinciple = result.principle || ''

          saveEvalLLMResult(rec.id, {
            llm_location: llmLocation,
            llm_shape: llmShape,
            llm_stage: llmStage,
            llm_conclusion: llmConclusion,
            llm_description: desc,
            llm_severity: result.severity || '',
            llm_status_obs: llmStatusObs,
            llm_principle: llmPrinciple,
          })

          // RAG 分析：CLIP 向量检索
          let ragLocation = '', ragShape = ''
          try {
            const ragResults = await searchSimilarVector(imgDataUrl, 1, '')
            if (ragResults && ragResults.length > 0) {
              const top = ragResults[0]
              ragLocation = normalizeEvalField('location', top.crackLocation || '')
              ragShape = normalizeEvalField('shape', Array.isArray(top.crackShape) ? top.crackShape.join('、') : (top.crackShape || ''))
            }
          } catch (e) {
            // CLIP 不可用，RAG 字段留空
          }
          saveEvalRAGResult(rec.id, { rag_location: ragLocation, rag_shape: ragShape })

          done++
          const evtData = {
            stage: 'progress', id: rec.id, status: 'ok', done, total: records.length,
            llm_location: llmLocation,
            llm_shape: llmShape,
            llm_stage: llmStage,
            llm_conclusion: llmConclusion,
            llm_status_obs: llmStatusObs,
            llm_principle: llmPrinciple,
            rag_location: ragLocation,
            rag_shape: ragShape,
          }
          send(evtData)
        } catch (e) {
          if (e.name === 'AbortError') {
            done++
            send({ stage: 'progress', id: rec.id, status: 'aborted', done, total: records.length })
            break
          }
          errors++
          done++
          send({ stage: 'progress', id: rec.id, status: 'error', done, total: records.length, error: e.message })
        }
      }
      send({ stage: 'done', done, total: records.length, errors })
      res.end()
      } catch (e) {
        console.error('[eval/batch-analyze] 致命错误:', e.message)
        if (!res.headersSent) json(res, 500, { success: false, error: { code: 'INTERNAL', message: e.message } })
        else res.end()
      }
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/eval/stats',
    handler: async (_req, res) => {
      const { getEvalStats } = await import('./db.mjs')
      json(res, 200, { success: true, data: getEvalStats() })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/eval/export-xlsx',
    handler: async (_req, res) => {
      const { getAllEvals } = await import('./db.mjs')
      const { getImagePath: getPath } = await import('./search-engine.mjs')
      const fs = await import('node:fs/promises')
      const ExcelJS = (await import('exceljs')).default
      const records = getAllEvals()

      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('鉴定评估报告')

      // 表头（每个字段: LLM值 | 人工值 | 一致性 | 最终采用）
      const headers = [
        'ID', '案例ID', '案例名称', '图片',
        '状态观察(LLM)', '状态观察(人工)', '观察一致性', '状态观察(最终)',
        '故障位置(LLM)', '故障位置(人工)', '位置一致性', '故障位置(最终)',
        '故障形态(LLM)', '故障形态(人工)', '形态一致性', '故障形态(最终)',
        '故障原理(LLM)', '故障原理(人工)', '原理一致性', '故障原理(最终)',
        '故障环节(LLM)', '故障环节(人工)', '环节一致性', '故障环节(最终)',
        '鉴定结论(LLM)', '鉴定结论(人工)', '结论一致性', '鉴定结论(最终)',
        'LLM描述', '判别人',
      ]
      const headerRow = ws.addRow(headers)
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } }
      headerRow.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }

      // 图片列宽设为 14，行高统一 80px
      ws.getColumn(4).width = 14

      // 数据行
      const okText = (v) => v === 1 ? '一致' : (v === 0 ? '不一致' : '未标注')
      // 最终采用值：一致→LLM值，不一致且有人工→人工值，否则→LLM值
      const resolve = (matchVal, llmVal, humanVal) => {
        if (matchVal === 1) return llmVal || humanVal || ''
        if (matchVal === 0) return humanVal || llmVal || ''
        return llmVal || humanVal || ''
      }
      const IMG_W = 120, IMG_H = 90  // 缩略图尺寸（Excel 像素单位）
      let rowNum = 2  // header is row 1

      for (const r of records) {
        const row = ws.addRow([
          r.id, r.case_id, r.case_title || '', '',
          r.llm_status_obs || '', r.human_status_obs || '', okText(r.match_status_obs), resolve(r.match_status_obs, r.llm_status_obs, r.human_status_obs),
          r.llm_location || '', r.human_location || '', okText(r.match_location), resolve(r.match_location, r.llm_location, r.human_location),
          r.llm_shape || '', r.human_shape || '', okText(r.match_shape), resolve(r.match_shape, r.llm_shape, r.human_shape),
          r.llm_principle || '', r.human_principle || '', okText(r.match_principle), resolve(r.match_principle, r.llm_principle, r.human_principle),
          r.llm_stage || '', r.human_stage || '', okText(r.match_stage), resolve(r.match_stage, r.llm_stage, r.human_stage),
          r.llm_conclusion || '', r.human_conclusion || '', okText(r.match_conclusion), resolve(r.match_conclusion, r.llm_conclusion, r.human_conclusion),
          (r.llm_description || '').replace(/\n/g, ' '),
          r.judged_by || '',
        ])
        row.height = IMG_H * 0.75  // 约 67.5 pt
        row.alignment = { vertical: 'middle' }

        // 嵌入图片
        if (r.image_name) {
          try {
            const imgPath = getPath(r.image_name)
            const buf = await fs.readFile(imgPath)
            // 根据扩展名推断 MIME
            const ext = (r.image_name.split('.').pop() || '').toLowerCase()
            const mimeMap = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', bmp: 'bmp' }
            const mime = mimeMap[ext] || 'jpeg'
            const extMap = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', bmp: 'bmp' }
            const workExt = extMap[mime] || 'jpg'
            const imgId = wb.addImage({ buffer: buf, extension: workExt })
            ws.addImage(imgId, {
              tl: { col: 3, row: rowNum - 1 },   // column D (0-indexed)
              ext: { width: IMG_W, height: IMG_H },
            })
          } catch (_) { /* 图片不存在则跳过 */ }
        }

        // 一致性列标色（每个字段(最终)插入后索引后移）
        for (const colIdx of [7, 11, 15, 19, 23, 27]) {
          const cell = row.getCell(colIdx)
          if (cell.value === '一致') cell.font = { color: { argb: 'FF10B981' }, bold: true }
          else if (cell.value === '不一致') cell.font = { color: { argb: 'FFEF4444' }, bold: true }
          else cell.font = { color: { argb: 'FF9CA3AF' } }
        }
        rowNum++
      }

      // 列宽（共30列: ID/案例ID/案例名称/图片 + 6x4组 + 描述 + 判别人）
      ws.columns = headers.map((h, i) => {
        if (i === 3) return { header: h, key: `col${i}`, width: 14 }   // 图片列
        const w = i <= 2 ? 12 : (i === 29 ? 16 : (i >= 4 && i <= 27 ? 18 : 40))
        return { header: h, key: `col${i}`, width: w }
      })

      // 冻结首行 + 首 4 列（ID/案例ID/案例名/图片）
      ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 4 }]

      // ===== Sheet 2: 汇总分析 =====
      buildSummarySheet(wb, records)

      const buf = await wb.xlsx.writeBuffer()
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="eval-report.xlsx"`,
        'Content-Length': buf.length,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(buf)
    },
  },
  {
    method: 'DELETE',
    path: '/api/knowledge/eval/batch',
    handler: async (_req, res) => {
      const { deleteAllEvals } = await import('./db.mjs')
      deleteAllEvals()
      json(res, 200, { success: true, data: { message: '评估批次已清空' } })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/eval/sync-to-cases',
    handler: async (_req, res, { body }) => {
      const { ids } = body || {}
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return json(res, 400, { success: false, error: { code: 'INVALID', message: '请选择要同步的记录' } })
      }
      try {
        const { getAllEvals } = await import('./db.mjs')
        const { updateCase, getCaseById } = await import('./search-engine.mjs')
        const allEvals = getAllEvals()
        const idSet = new Set(ids)
        let synced = 0, skipped = 0
        const errors = []

        // 从集中式字段定义获取映射关系
        const shapeMapping = (_fieldDefs.shape && _fieldDefs.shape.caseMapping) || {}
        const conclusionLabelMap = (_fieldDefs.conclusion && _fieldDefs.conclusion.labelMap) || {}

        const normalizeShape = (shape, desc) => {
          if (!shape || shape === '未知') return shape
          if (shape.includes('(') || shape.includes('（')) return shape
          // 从 field-defs 读取映射
          if (shapeMapping[shape]) return shapeMapping[shape]
          // 兜底：检查描述中是否有缺陷关键词
          const hasDefect = /(?:缺角|裂纹|腐蚀|磕碰|凹坑)/.test(desc || '')
          if (shape === '漏液') return hasDefect ? '漏液（有缺角、裂纹、腐蚀）' : '漏液（无缺角、裂纹、腐蚀）'
          if (shape === '熔屏') return hasDefect ? '熔屏（有缺角、裂纹、腐蚀）' : '熔屏（无缺角、裂纹、腐蚀）'
          return shape
        }

        for (const ev of allEvals) {
          if (!idSet.has(ev.id)) continue
          if (!ev.case_id) { skipped++; errors.push({ id: ev.id, title: ev.case_title, reason: '评估记录缺少 case_id' }); continue }

          // 检查案例是否还存在
          try {
            const existingCase = await getCaseById(ev.case_id)
            if (!existingCase) {
              skipped++
              errors.push({ id: ev.id, title: ev.case_title, case_id: ev.case_id, reason: '案例已删除' })
              continue
            }
          } catch {
            skipped++
            errors.push({ id: ev.id, title: ev.case_title, case_id: ev.case_id, reason: '查询案例失败' })
            continue
          }

          // 优先使用人工标注；人工未填则用 LLM 结果
          const location = ev.human_location || ev.llm_location || ''
          const rawShape = ev.human_shape || ev.llm_shape || ''
          const shape = normalizeShape(rawShape, ev.llm_description || '')
          const stage = ev.human_stage || ev.llm_stage || ''
          const principle = ev.human_principle || ev.llm_principle || ''
          const conclusion = ev.human_conclusion || ev.llm_conclusion || ''

          try {
            await updateCase(ev.case_id, {
              crackLocation: location,
              crackShape: shape,
              crackStage: stage,
              crackPrinciple: principle,
              result: conclusion || '',
              resultLabel: conclusionLabelMap[conclusion] || '',
            })
            synced++
          } catch (e) {
            skipped++
            errors.push({ id: ev.id, title: ev.case_title, case_id: ev.case_id, reason: `写入失败: ${e.message}` })
          }
        }
        json(res, 200, { success: true, data: { synced, skipped, total: ids.length, errors } })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'SYNC_FAILED', message: e.message } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/eval/batch-delete',
    handler: async (_req, res, { body }) => {
      const { ids } = body || {}
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return json(res, 400, { success: false, error: { code: 'INVALID', message: '请选择要删除的记录' } })
      }
      try {
        const { deleteEvalsByIds } = await import('./db.mjs')
        const count = deleteEvalsByIds(ids)
        json(res, 200, { success: true, data: { deleted: count } })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'DELETE_FAILED', message: e.message } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/eval/clean-orphans',
    handler: async (_req, res) => {
      try {
        const { getAllEvals, deleteEvalsByIds } = await import('./db.mjs')
        const { getCaseById } = await import('./search-engine.mjs')
        const allEvals = getAllEvals()
        const orphanIds = []

        for (const ev of allEvals) {
          if (!ev.case_id) { orphanIds.push(ev.id); continue }
          try {
            const existingCase = await getCaseById(ev.case_id)
            if (!existingCase) orphanIds.push(ev.id)
          } catch { orphanIds.push(ev.id) }
        }

        let deleted = 0
        if (orphanIds.length > 0) {
          deleted = deleteEvalsByIds(orphanIds)
        }
        json(res, 200, { success: true, data: { found: orphanIds.length, deleted } })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'CLEAN_FAILED', message: e.message } })
      }
    },
  },
  // ===== 知识库管理 =====
  {
    method: 'GET',
    path: '/api/knowledge/kb/stats',
    handler: async (_req, res) => {
      const stats = await getKBStats()
      json(res, 200, { success: true, data: stats })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/kb/documents',
    handler: async (_req, res) => {
      const docs = await listDocuments()
      json(res, 200, { success: true, data: docs })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/kb/document',
    handler: async (_req, res, { query }) => {
      if (!query.id) return json(res, 400, { success: false, error: { code: 'MISSING_ID', message: '缺少文档 id' } })
      const doc = await getDocument(query.id)
      if (!doc) return json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: '文档不存在' } })
      json(res, 200, { success: true, data: doc })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/kb/upload',
    handler: async (_req, res, { body }) => {
      if (!body.filename || !body.content) return json(res, 400, { success: false, error: { code: 'INVALID_FORMAT', message: '请提供 filename 和 content' } })
      try {
        const doc = await uploadDocument(body.filename, body.content)
        json(res, 201, { success: true, data: doc })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'UPLOAD_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'DELETE',
    path: '/api/knowledge/kb/document',
    handler: async (_req, res, { query }) => {
      if (!query.id) return json(res, 400, { success: false, error: { code: 'MISSING_ID', message: '缺少文档 id' } })
      const ok = await deleteDocument(query.id)
      if (!ok) return json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: '文档不存在' } })
      json(res, 200, { success: true, data: { id: query.id, deleted: true } })
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/kb/search',
    handler: async (_req, res, { body }) => {
      if (!body.query) return json(res, 400, { success: false, error: { code: 'MISSING_QUERY', message: '请提供查询内容 query' } })
      const results = await searchKB(body.query, body.topK || 5)
      json(res, 200, { success: true, data: { query: body.query, results } })
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/dashboard',
    handler: async (_req, res) => {
      try {
        const DATA_DIR = join(__dirname, '..', 'data')
        const IMAGES_DIR = join(DATA_DIR, 'images')
        const CASES_FILE = join(DATA_DIR, 'cases.json')
        const TRAINING_FILE = join(DATA_DIR, 'training.json')
        const KB_FILE = join(DATA_DIR, 'knowledge-base.json')

        // 并发获取所有统计
        const [caseStats, trainingStats, kbStats, clipOk] = await Promise.all([
          getStats(),
          getTrainingStats(),
          getKBStats(),
          isClipAvailable(),
        ])

        // 获取文件大小和图片数
        const getFileSize = async (f) => { try { const s = await stat(f); return s.size } catch { return 0 } }
        const countImageFiles = async () => {
          try {
            const { readdir } = await import('node:fs/promises')
            const files = await readdir(IMAGES_DIR)
            return files.filter(f => /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(f)).length
          } catch { return 0 }
        }

        const [casesSize, trainingSize, kbSize, imageCount] = await Promise.all([
          getFileSize(CASES_FILE),
          getFileSize(TRAINING_FILE),
          getFileSize(KB_FILE),
          countImageFiles(),
        ])

        // 获取 Python 向量服务状态
        let vectorStats = null
        try {
          const { clipStats } = await import('./clip-client.mjs')
          vectorStats = await clipStats()
        } catch { vectorStats = null }

        json(res, 200, {
          success: true,
          data: {
            uptime: Date.now() - startTime,
            cases: { ...caseStats, fileSize: casesSize, filePath: CASES_FILE },
            training: { ...trainingStats, fileSize: trainingSize, filePath: TRAINING_FILE },
            knowledgeBase: { ...kbStats, fileSize: kbSize, filePath: KB_FILE },
            images: { count: imageCount, dir: IMAGES_DIR },
            vector: { clipAvailable: clipOk, ...(vectorStats || {}) },
          },
        })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'DASHBOARD_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'GET',
    path: '/api/knowledge/sql-schema',
    handler: async (_req, res) => {
      try {
        const { getDb } = await import('./db.mjs')
        const db = getDb()
        // 获取所有表名
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
        const schema = tables.map(t => {
          const cols = db.prepare(`PRAGMA table_info(${t.name})`).all()
          return {
            name: t.name,
            columns: cols.map(c => ({ name: c.name, type: c.type, notnull: !!c.notnull, pk: !!c.pk })),
          }
        })
        json(res, 200, { success: true, data: schema })
      } catch (e) {
        json(res, 500, { success: false, error: { code: 'SCHEMA_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/sql-query',
    handler: async (_req, res, { body }) => {
      const { sql } = body || {}
      if (!sql || typeof sql !== 'string') {
        return json(res, 400, { success: false, error: { code: 'INVALID', message: '请提供 SQL 语句' } })
      }
      const trimmed = sql.trim()
      if (!/^SELECT\b/i.test(trimmed)) {
        return json(res, 403, { success: false, error: { code: 'FORBIDDEN', message: '仅允许 SELECT 查询，不支持修改操作' } })
      }
      try {
        const { getDb } = await import('./db.mjs')
        const db = getDb()
        const rows = db.prepare(trimmed).all()
        // 限制总行数，防止返回过多
        const maxRows = 5000
        const truncated = rows.length > maxRows ? rows.slice(0, maxRows) : rows
        json(res, 200, {
          success: true,
          data: {
            rows: truncated,
            total: rows.length,
            truncated: rows.length > maxRows,
            maxRows,
          },
        })
      } catch (e) {
        json(res, 400, { success: false, error: { code: 'SQL_ERROR', message: e.message } })
      }
    },
  },
  {
    method: 'POST',
    path: '/api/knowledge/sql-query/export',
    handler: async (_req, res, { body }) => {
      const { sql } = body || {}
      if (!sql || typeof sql !== 'string') {
        return json(res, 400, { success: false, error: { code: 'INVALID', message: '请提供 SQL 语句' } })
      }
      const trimmed = sql.trim()
      if (!/^SELECT\b/i.test(trimmed)) {
        return json(res, 403, { success: false, error: { code: 'FORBIDDEN', message: '仅允许 SELECT 查询' } })
      }
      try {
        const { getDb } = await import('./db.mjs')
        const db = getDb()
        const rows = db.prepare(trimmed).all()
        const maxRows = 5000
        const data = rows.length > maxRows ? rows.slice(0, maxRows) : rows

        const ExcelJS = (await import('exceljs')).default
        const wb = new ExcelJS.Workbook()
        const ws = wb.addWorksheet('查询结果')

        if (data.length > 0) {
          const headers = Object.keys(data[0])
          const headerRow = ws.addRow(headers)
          headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
          headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } }
          headerRow.alignment = { horizontal: 'center', vertical: 'middle' }
          for (const row of data) {
            ws.addRow(Object.values(row))
          }
          ws.columns = headers.map((h, i) => ({ header: h, key: `col${i}`, width: Math.max(12, Math.min(String(h).length * 2 + 4, 36)) }))
        } else {
          ws.addRow(['查询结果为空'])
        }

        const buf = await wb.xlsx.writeBuffer()
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="sql-query-result.xlsx"',
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(buf)
      } catch (e) {
        json(res, 400, { success: false, error: { code: 'SQL_ERROR', message: e.message } })
      }
    },
  },
]

createServer(routes, PORT, 'knowledge-ai')

// 启动时初始化数据库（search-engine 是懒加载，需要显式触发）
import('./db.mjs').then(({ initDb }) => initDb()).catch(e => console.warn('[knowledge-ai] DB 初始化失败:', e.message))
console.log(`[knowledge-ai] 相似案例检索 → POST http://localhost:${PORT}/api/knowledge/search`)
console.log(`[knowledge-ai] 案例库统计 → GET  http://localhost:${PORT}/api/knowledge/stats`)

// 定时 WAL checkpoint（每 30 分钟一次），防止 WAL 文件无限增长
import('./db.mjs').then(({ checkpointWal, backupDb }) => {
  setInterval(() => {
    checkpointWal()
  }, 30 * 60 * 1000)

  // 每日凌晨 3 点自动备份
  const scheduleBackup = () => {
    const now = new Date()
    const msUntil3am = ((24 - now.getHours() + 3) % 24) * 3600000 - now.getHours() * 3600000 - now.getMinutes() * 60000 - now.getSeconds() * 1000
    const delay = msUntil3am < 0 ? msUntil3am + 86400000 : msUntil3am
    setTimeout(() => {
      backupDb().catch(e => console.warn('[knowledge-ai] 定时备份失败:', e.message))
      // 之后每 24 小时备份一次
      setInterval(() => {
        backupDb().catch(e => console.warn('[knowledge-ai] 定时备份失败:', e.message))
      }, 24 * 3600000)
    }, delay)
  }
  scheduleBackup()
})
