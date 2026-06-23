import { createServer, json } from './server-utils.mjs'
import { store } from './rules-store.mjs'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.ADMIN_PORT || '8082', 10)
const startTime = Date.now()

const DEFAULT_RULES_NODES = [
  { id: 'node_start', type: 'start', description: '屏损故障发生', nextNodeId: 'decision_installed' },
  { id: 'decision_installed', type: 'decision', question: '是否已安装？',
    branches: [{ answer: '是', nextNodeId: 'outcome_C' }, { answer: '否', nextNodeId: 'decision_auth_personnel' }] },
  { id: 'decision_auth_personnel', type: 'decision', question: '开箱人员是否为TCL授权人员？',
    branches: [{ answer: '否', nextNodeId: 'outcome_E' }, { answer: '是', nextNodeId: 'decision_package_damage' }] },
  { id: 'decision_package_damage', type: 'decision', question: '包装箱是否有破损？',
    branches: [{ answer: '无破损', nextNodeId: 'decision_product_factor' }, { answer: '有破损', nextNodeId: 'decision_logistics_factor' }] },
  { id: 'decision_product_factor', type: 'decision', question: '故障环节是否包含"产品因素"？',
    branches: [{ answer: '是', nextNodeId: 'outcome_H' }, { answer: '否', nextNodeId: 'decision_install_use' }] },
  { id: 'decision_logistics_factor', type: 'decision', question: '故障环节是否包含"物流运输搬运"？',
    branches: [{ answer: '是', nextNodeId: 'outcome_K' }, { answer: '否', nextNodeId: 'decision_install_use' }] },
  { id: 'decision_install_use', type: 'decision', question: '故障环节是否包含"拆机验机安装"或"使用保管不当"？',
    branches: [{ answer: '是', nextNodeId: 'outcome_N' }, { answer: '否', nextNodeId: 'outcome_O' }] },
  { id: 'outcome_C', type: 'outcome', result: '非产品质量问题', conditionSummary: '已安装', nextNodeId: 'node_end' },
  { id: 'outcome_E', type: 'outcome', result: '非产品质量问题', conditionSummary: '未安装 + 非授权开箱', nextNodeId: 'node_end' },
  { id: 'outcome_H', type: 'outcome', result: '产品质量问题', conditionSummary: '未安装 + 授权开箱 + 包装完好 + 故障环节包含产品因素', nextNodeId: 'node_end' },
  { id: 'outcome_K', type: 'outcome', result: '物流问题', conditionSummary: '未安装 + 授权开箱 + 包装破损 + 故障环节包含物流运输搬运', nextNodeId: 'node_end' },
  { id: 'outcome_N', type: 'outcome', result: '非产品质量问题', conditionSummary: '故障环节包含拆机验机安装或使用保管不当', nextNodeId: 'node_end' },
  { id: 'outcome_O', type: 'outcome', result: '需进一步综合判定', conditionSummary: '排除产品因素、物流因素、安装/使用因素后，参考具体屏裂类型及案例指导', nextNodeId: 'node_end' },
  { id: 'node_end', type: 'end', description: '判定结束' },
]

async function seedDefaultRules() {
  const list = await store.list()
  if (list.length === 0) {
    const created = await store.create('屏损故障原因判定规则', '根据安装状态、开箱授权、包装状况和故障环节，判断屏损故障的责任归属', DEFAULT_RULES_NODES)
    await store.publish(created.id)
    console.log('[decision-admin] 已初始化默认规则集并发布')
  }
}

function serveFile(res, filePath, contentType) {
  readFile(filePath)
    .then(data => {
      res.writeHead(200, { 'Content-Type': contentType })
      res.end(data)
    })
    .catch(() => {
      res.writeHead(404)
      res.end('Not Found')
    })
}

const routes = [
  // ========== 健康检查 ==========
  {
    method: 'GET',
    path: '/api/health',
    handler: (_req, res) => {
      json(res, 200, { service: 'decision-admin', status: 'ok', uptime: Date.now() - startTime, version: '1.0.0' })
    },
  },
  // ========== 规则列表 ==========
  {
    method: 'GET',
    path: '/api/admin/rules',
    handler: async (_req, res) => {
      const list = await store.list()
      json(res, 200, { success: true, data: list })
    },
  },
  // ========== 规则详情 ==========
  {
    method: 'GET',
    path: '/api/admin/rules/detail',
    handler: async (_req, res, { query }) => {
      const rule = await store.get(query.id)
      if (!rule) return json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: '规则不存在' } })
      json(res, 200, { success: true, data: rule })
    },
  },
  // ========== 获取已发布规则（给 decision-engine 用） ==========
  {
    method: 'GET',
    path: '/api/admin/rules/published',
    handler: async (_req, res) => {
      const payload = await store.getDecisionTreePayload()
      if (!payload) return json(res, 404, { success: false, error: { code: 'NO_PUBLISHED', message: '没有已发布的规则' } })
      json(res, 200, { success: true, data: payload })
    },
  },
  // ========== 创建规则 ==========
  {
    method: 'POST',
    path: '/api/admin/rules',
    handler: async (_req, res, { body }) => {
      try {
        const rule = await store.create(body.ruleSetName, body.description || '', body.nodes || [])
        json(res, 201, { success: true, data: rule })
      } catch (e) {
        json(res, 400, { success: false, error: { code: 'CREATE_FAILED', message: e.message } })
      }
    },
  },
  // ========== 更新规则 ==========
  {
    method: 'PUT',
    path: '/api/admin/rules/update',
    handler: async (_req, res, { body }) => {
      try {
        const rule = await store.update(body.id, body)
        json(res, 200, { success: true, data: rule })
      } catch (e) {
        json(res, 400, { success: false, error: { code: 'UPDATE_FAILED', message: e.message } })
      }
    },
  },
  // ========== 发布规则 ==========
  {
    method: 'POST',
    path: '/api/admin/rules/publish',
    handler: async (_req, res, { body }) => {
      try {
        const rule = await store.publish(body.id)
        json(res, 200, { success: true, data: rule, message: '规则已发布，决策引擎将在下次请求时生效' })
      } catch (e) {
        json(res, 400, { success: false, error: { code: 'PUBLISH_FAILED', message: e.message } })
      }
    },
  },
  // ========== 删除规则 ==========
  {
    method: 'DELETE',
    path: '/api/admin/rules/delete',
    handler: async (_req, res, { query }) => {
      const ok = await store.remove(query.id)
      if (!ok) return json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: '规则不存在' } })
      json(res, 200, { success: true, message: '已删除' })
    },
  },
  // ========== 静态文件：管理后台页面 ==========
  {
    method: 'GET',
    path: '/admin',
    handler: (_req, res) => {
      serveFile(res, join(__dirname, '..', 'static', 'admin.html'), 'text/html; charset=utf-8')
    },
  },
  {
    method: 'GET',
    path: '/',
    handler: (_req, res) => {
      serveFile(res, join(__dirname, '..', 'static', 'admin.html'), 'text/html; charset=utf-8')
    },
  },
]

await store.ensureReady()
await seedDefaultRules()

createServer(routes, PORT, 'decision-admin')
console.log(`[decision-admin] 管理后台 → http://localhost:${PORT}/admin`)
console.log(`[decision-admin] 规则API → GET http://localhost:${PORT}/api/admin/rules`)
console.log(`[decision-admin] 已发布规则 → GET http://localhost:${PORT}/api/admin/rules/published`)
