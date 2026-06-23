import { createServer, json, fetchJson } from './server-utils.mjs'
import { DecisionTree, calculateConfidence, needsExpertReview } from './decision-tree.mjs'

const PORT = parseInt(process.env.ENGINE_PORT || '8081', 10)
const ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:8082'
const startTime = Date.now()
const decisionTree = new DecisionTree()

async function reloadRulesFromAdmin() {
  try {
    const result = await fetchJson(`${ADMIN_URL}/api/admin/rules/published`)
    const data = typeof result === 'string' ? JSON.parse(result) : result
    if (data.success && data.data) {
      decisionTree.reloadRuleSet(data.data)
      console.log(`[decision-engine] 已从管理中台加载规则: ${data.data.ruleSetName} v${data.data.version}`)
      return true
    }
  } catch (e) {
    console.warn(`[decision-engine] 从管理中台加载规则失败 (${e.message})，使用内置默认规则`)
  }
  return false
}

function buildAnswers(req) {
  const a = {}
  let unknownCount = 0

  if (req.installStatus === 'unknown') {
    unknownCount++
    a['decision_installed'] = '否'
  } else {
    a['decision_installed'] = req.installStatus === 'installed' ? '是' : '否'
  }

  if (req.installStatus !== 'installed') {
    if (req.authPersonnel === 'unknown') {
      unknownCount++
      a['decision_auth_personnel'] = '否'
    } else {
      a['decision_auth_personnel'] = req.authPersonnel === 'yes' ? '是' : '否'
    }
  }

  const installNotInstalled = req.installStatus === 'not_installed' || req.installStatus === 'unknown'
  const authIsYesOrUnknown = req.authPersonnel === 'yes' || req.authPersonnel === 'unknown'
  if (installNotInstalled && authIsYesOrUnknown) {
    if (req.packageDamage === 'unknown') {
      unknownCount++
      a['decision_package_damage'] = '无破损'
    } else {
      a['decision_package_damage'] = req.packageDamage === 'damaged' ? '有破损' : '无破损'
    }
  }

  const hasProductFactor = req.faultLinks.includes('product_factor')
  const hasLogistics = req.faultLinks.includes('logistics_transport')
  const hasInstallUse = req.faultLinks.includes('unboxing_install') || req.faultLinks.includes('usage_mishandling')

  if (req.faultLinks.length === 0 || req.faultLinks.includes('unknown')) {
    unknownCount++
  }

  const pkgNotDamaged = req.packageDamage !== 'damaged' || req.packageDamage === 'unknown'
  if (pkgNotDamaged) {
    a['decision_product_factor'] = hasProductFactor ? '是' : '否'
  } else {
    a['decision_logistics_factor'] = hasLogistics ? '是' : '否'
  }

  a['decision_install_use'] = hasInstallUse ? '是' : '否'

  return { answers: a, unknownCount }
}

function outcomeToEnum(outcome) {
  if (outcome === '产品质量问题') return 'product_quality_issue'
  if (outcome === '物流问题') return 'logistics_issue'
  if (outcome === '需进一步综合判定') return 'needs_further_review'
  return 'not_product_quality'
}

const routes = [
  {
    method: 'GET',
    path: '/api/health',
    handler: (_req, res) => {
      json(res, 200, {
        service: 'decision-engine',
        status: 'ok',
        uptime: Date.now() - startTime,
        version: '1.0.0',
      })
    },
  },
  {
    method: 'POST',
    path: '/api/decision/evaluate',
    handler: (_req, res, { body }) => {
      const req = body

      const { answers, unknownCount } = buildAnswers(req)
      const evalResult = decisionTree.evaluate(answers)

      const confidence = calculateConfidence({
        evaluationResult: evalResult,
        symptomCount: (req.symptoms || []).length,
        hasImpactPoint: req.hasImpactPoint,
        hasButterflyPattern: req.hasButterflyPattern,
        hasLeakIrregular: !!req.crackLocation,
        unknownCount,
      })

      let result = outcomeToEnum(evalResult.outcome)
      let resultLabel = evalResult.outcome
      if (unknownCount >= 2 && unknownCount < 4) {
        result = 'needs_further_review'
        resultLabel = '需进一步综合判定'
      }

      json(res, 200, {
        success: true,
        data: {
          caseId: req.caseId,
          result,
          resultLabel,
          confidence,
          needExpertReview: needsExpertReview(confidence),
          decisionPath: evalResult.path,
          ruleVersion: decisionTree.currentVersion,
          uncertainty: unknownCount > 0 ? { fields: unknownCount, message: unknownCount >= 4 ? '非现场判定：全部信息标注为不确定，置信度未扣减' : unknownCount >= 2 ? '多项信息不确定，建议转人工复核' : '部分信息不确定，置信度已降低' } : null,
        },
      })
    },
  },
  {
    method: 'POST',
    path: '/api/decision/reload',
    handler: async (_req, res) => {
      const ok = await reloadRulesFromAdmin()
      if (ok) {
        json(res, 200, { success: true, message: '规则已从管理中台重新加载', version: decisionTree.currentVersion })
      } else {
        try {
          const raw = await fetchJson(`${ADMIN_URL}/api/admin/rules/published`)
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw
          if (data.success && data.data) {
            decisionTree.reloadRuleSet(data.data)
            json(res, 200, { success: true, message: '二级fallback成功加载', version: decisionTree.currentVersion })
          } else {
            json(res, 200, { success: false, error: { code: 'RELOAD_FAILED', message: 'admin返回数据但success为false' } })
          }
        } catch (e2) {
          json(res, 200, { success: false, error: { code: 'RELOAD_FAILED', message: e2.message } })
        }
      }
    },
  },
]

createServer(routes, PORT, 'decision-engine')
console.log(`[decision-engine] 判定接口 → POST http://localhost:${PORT}/api/decision/evaluate`)

reloadRulesFromAdmin()
