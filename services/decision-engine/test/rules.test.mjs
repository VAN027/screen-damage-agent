import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  DecisionTree,
  RuleValidationError as EngineRuleValidationError,
  validateRuleSet as validateEngineRuleSet,
} from '../src/decision-tree.mjs'
import {
  RulesStore,
  RuleConflictError,
  RuleValidationError as AdminRuleValidationError,
  MAX_RULE_NODES as ADMIN_MAX_RULE_NODES,
  validateRuleSet as validateAdminRuleSet,
} from '../../decision-admin/src/rules-store.mjs'
import {
  RulePublishActivationError,
  publishAndReloadRule,
} from '../../decision-admin/src/index.mjs'
import {
  DecisionRequestError,
  buildAnswers,
  DEFAULT_RULE_RECONCILE_INTERVAL_MS,
  evaluateDecision,
  getRuleSyncStatus,
  MIN_RULE_RECONCILE_INTERVAL_MS,
  normalizeRuleReconcileInterval,
  reloadRulesFromAdmin,
  routes as engineRoutes,
  ruleReloadRetryDelay,
  startRuleReconciliation,
  stopRuleReconciliation,
  stopRuleReloadRetry,
  validateDecisionRequest,
} from '../src/index.mjs'

function validRuleSet(overrides = {}) {
  return {
    id: 'test-rule',
    revision: 'test-revision',
    ruleSetName: '测试规则',
    version: '1.0',
    description: 'test',
    startNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', nextNodeId: 'decision_installed' },
      {
        id: 'decision_installed',
        type: 'decision',
        question: '是否为质量问题？',
        branches: [
          { answer: '是', nextNodeId: 'quality' },
          { answer: '否', nextNodeId: 'not_quality' },
        ],
      },
      { id: 'quality', type: 'outcome', result: '质量问题', nextNodeId: 'end' },
      { id: 'not_quality', type: 'outcome', result: '非质量问题', nextNodeId: 'end' },
      { id: 'end', type: 'end' },
    ],
    ...overrides,
  }
}

function clone(value) {
  return structuredClone(value)
}

function assertBothReject(ruleSet, pattern) {
  assert.throws(() => validateEngineRuleSet(ruleSet), error => {
    assert.ok(error instanceof EngineRuleValidationError)
    assert.match(error.message, pattern)
    return true
  })
  assert.throws(() => validateAdminRuleSet(ruleSet), error => {
    assert.ok(error instanceof AdminRuleValidationError)
    assert.match(error.message, pattern)
    return true
  })
}

async function invokeEngineRoute(method, path, body = null) {
  const route = engineRoutes.find(candidate => candidate.method === method && candidate.path === path)
  assert.ok(route, `missing route ${method} ${path}`)
  let statusCode = null
  let payload = null
  const res = {
    writableEnded: false,
    writeHead(status) { statusCode = status },
    end(raw) {
      this.writableEnded = true
      payload = JSON.parse(raw)
    },
  }
  await route.handler({}, res, { body, query: {} })
  return { statusCode, payload }
}

test('engine and admin accept a complete valid graph', () => {
  assert.deepEqual(validateEngineRuleSet(validRuleSet()), { nodeCount: 5, longestPath: 4 })
  assert.deepEqual(validateAdminRuleSet(validRuleSet()), { nodeCount: 5, longestPath: 4 })
})

test('health and evaluation fail closed before published rules are synchronized', async () => {
  const health = await invokeEngineRoute('GET', '/api/health')
  assert.equal(health.statusCode, 503)
  assert.equal(health.payload.status, 'not_ready')
  assert.equal(health.payload.rulesReady, false)
  assert.equal(health.payload.rulesSource, 'builtin-fallback')

  const evaluation = await invokeEngineRoute('POST', '/api/decision/evaluate', baseDecisionRequest)
  assert.equal(evaluation.statusCode, 503)
  assert.equal(evaluation.payload.error.code, 'RULES_NOT_READY')
})

test('graph validation rejects duplicate IDs, illegal types and missing targets', () => {
  const duplicate = validRuleSet()
  duplicate.nodes[2].id = 'decision_installed'
  assertBothReject(duplicate, /重复/)

  const illegalType = validRuleSet()
  illegalType.nodes[1].type = 'script'
  assertBothReject(illegalType, /类型.*不合法/)

  const missingTarget = validRuleSet()
  missingTarget.nodes[1].branches[0].nextNodeId = 'missing'
  assertBothReject(missingTarget, /不存在/)
})

test('graph validation rejects invalid start and outcome definitions', () => {
  const secondStart = validRuleSet()
  secondStart.nodes.push({ id: 'start2', type: 'start', nextNodeId: 'decision_installed' })
  assertBothReject(secondStart, /只能包含一个 start/)

  const unsupportedOutcome = validRuleSet()
  unsupportedOutcome.nodes[2].result = '随意结论'
  assertBothReject(unsupportedOutcome, /不受支持/)

  const directEnd = validRuleSet()
  directEnd.nodes[1].branches[0].nextNodeId = 'end'
  directEnd.nodes = directEnd.nodes.filter(node => node.id !== 'quality')
  assertBothReject(directEnd, /未经过 outcome/)
})

test('graph validation rejects unreachable nodes and cycles in any component', () => {
  const unreachable = validRuleSet()
  unreachable.nodes.push({ id: 'unused', type: 'outcome', result: '非质量问题', nextNodeId: 'end' })
  assertBothReject(unreachable, /不可达/)

  const cycle = validRuleSet()
  cycle.nodes[1].branches[0].nextNodeId = 'decision_installed'
  assertBothReject(cycle, /环路/)

  const unreachableCycle = validRuleSet()
  unreachableCycle.nodes.push({
    id: 'decision_product_factor',
    type: 'decision',
    question: '循环',
    branches: [
      { answer: '是', nextNodeId: 'decision_product_factor' },
      { answer: '否', nextNodeId: 'not_quality' },
    ],
  })
  assertBothReject(unreachableCycle, /环路/)
})

test('graph validation enforces the configured maximum path length', () => {
  const graph = validRuleSet()
  assert.throws(() => validateEngineRuleSet(graph, { maxPathLength: 3 }), /超过上限/)
  assert.throws(() => validateAdminRuleSet(graph, { maxPathLength: 3 }), /超过上限/)
})

test('graph validation bounds node counts and operator-authored text', () => {
  const tooManyNodes = validRuleSet()
  tooManyNodes.nodes = Array.from({ length: ADMIN_MAX_RULE_NODES + 1 }, (_, index) => ({
    id: `end-${index}`,
    type: 'end',
  }))
  assertBothReject(tooManyNodes, /节点数不能超过/)

  const longQuestion = validRuleSet()
  longQuestion.nodes[1].question = 'x'.repeat(501)
  assertBothReject(longQuestion, /问题不能超过/)
})

test('graph validation only accepts decision IDs and answers produced by buildAnswers', () => {
  const unsupportedId = validRuleSet()
  unsupportedId.nodes[1].id = 'decision_custom'
  unsupportedId.nodes[0].nextNodeId = 'decision_custom'
  assertBothReject(unsupportedId, /固定输入支持/)

  const unsupportedAnswer = validRuleSet()
  unsupportedAnswer.nodes[1].branches[0].answer = '已安装'
  assertBothReject(unsupportedAnswer, /分支答案.*引擎输入一致/)
})

test('tracked published rule remains compatible with strict decision semantics', async () => {
  const dataUrl = new URL('../../decision-admin/data/', import.meta.url)
  const index = JSON.parse(await readFile(new URL('index.json', dataUrl), 'utf8'))
  const published = JSON.parse(await readFile(new URL(`${index.publishedId}.json`, dataUrl), 'utf8'))
  assert.doesNotThrow(() => validateAdminRuleSet(published))
  assert.doesNotThrow(() => validateEngineRuleSet(published))
})

test('DecisionTree evaluates valid rules and defensively stops a runtime cycle', () => {
  const tree = new DecisionTree(validRuleSet())
  assert.equal(tree.evaluate({ decision_installed: '是' }).outcome, '质量问题')

  // Simulate mutation after construction, bypassing reload validation.
  tree.ruleSet.nodes.find(node => node.id === 'decision_installed').branches[0].nextNodeId = 'decision_installed'
  assert.throws(() => tree.evaluate({ decision_installed: '是' }), /环路/)
})

test('reload validates before replacing the active rules', () => {
  const tree = new DecisionTree(validRuleSet({ version: 'old' }))
  const invalid = validRuleSet({ version: 'new' })
  invalid.nodes[0].nextNodeId = 'missing'
  assert.throws(() => tree.reloadRuleSet(invalid), RuleValidationError => RuleValidationError.code === 'INVALID_RULE_GRAPH')
  assert.equal(tree.currentVersion, 'old')
})

test('DecisionTree exposes immutable identity and can explicitly restore defaults', () => {
  const tree = new DecisionTree(validRuleSet({ id: 'custom-id', revision: 'custom-revision' }))
  assert.equal(tree.currentRuleId, 'custom-id')
  assert.equal(tree.currentRevision, 'custom-revision')
  tree.resetToDefault()
  assert.equal(tree.currentRuleId, 'builtin-default')
  assert.equal(tree.currentRevision, 'builtin-default-v1')
  const resetRoute = engineRoutes.find(route => route.path === '/api/decision/reset-default')
  assert.equal(resetRoute.auth, 'internal')
})

test('RulesStore validates create, update, publish and derives start by type', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'screen-damage-rules-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const store = new RulesStore({ dataDir })
  await store.ensureReady()

  const nodesWithStartNotFirst = validRuleSet().nodes
  nodesWithStartNotFirst.push(nodesWithStartNotFirst.shift())
  const created = await store.create('存储测试', '', nodesWithStartNotFirst)
  assert.equal(created.startNodeId, 'start')

  const invalidNodes = clone(created.nodes)
  invalidNodes.find(node => node.id === 'decision_installed').branches[0].nextNodeId = 'missing'
  await assert.rejects(store.update(created.id, { nodes: invalidNodes }), /不存在/)

  const fileRule = await store.get(created.id)
  fileRule.nodes.find(node => node.id === 'decision_installed').branches[0].nextNodeId = 'missing'
  await writeFile(join(dataDir, `${created.id}.json`), JSON.stringify(fileRule), 'utf8')
  await assert.rejects(store.publish(created.id), /不存在/)

  await writeFile(join(dataDir, `${created.id}.json`), JSON.stringify(created), 'utf8')
  const published = await store.publish(created.id)
  assert.equal(published.status, 'published')

  await assert.rejects(store.update(created.id, { description: '篡改' }), error => {
    assert.ok(error instanceof RuleConflictError)
    assert.equal(error.code, 'PUBLISHED_RULE_IMMUTABLE')
    assert.equal(error.statusCode, 409)
    return true
  })
  await assert.rejects(store.remove(created.id), error => {
    assert.ok(error instanceof RuleConflictError)
    assert.equal(error.code, 'PUBLISHED_RULE_IMMUTABLE')
    return true
  })
  assert.equal((await store.get(created.id)).status, 'published')

  const successor = await store.create('存储测试', '', clone(validRuleSet().nodes))
  await store.publish(successor.id)
  assert.equal((await store.get(created.id)).status, 'archived')
  await assert.rejects(store.update(created.id, { description: '篡改历史' }), /不可原地修改/)
  await assert.rejects(store.remove(created.id), /审计快照/)

  await assert.rejects(store.create('坏规则', '', []), /至少需要一个节点/)
})

test('failed engine activation restores publishedId and reloads the previous rule', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'screen-damage-publish-rollback-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const rulesStore = new RulesStore({ dataDir })
  await rulesStore.ensureReady()
  const previous = await rulesStore.create('回滚测试', '', clone(validRuleSet().nodes))
  await rulesStore.publish(previous.id)
  const candidate = await rulesStore.create('回滚测试', '', clone(validRuleSet().nodes))
  let reloadCalls = 0

  await assert.rejects(
    publishAndReloadRule(candidate.id, {
      rulesStore,
      reloadEngine: async () => {
        reloadCalls++
        if (reloadCalls === 1) throw new Error('模拟热加载失败')
        const active = await rulesStore.getPublished()
        return {
          success: true,
          version: active.version,
          ruleId: active.id,
          revision: active.revision,
        }
      },
    }),
    error => {
      assert.ok(error instanceof RulePublishActivationError)
      assert.equal(error.code, 'ENGINE_RELOAD_FAILED_ROLLED_BACK')
      assert.equal(error.details.persistedRolledBack, true)
      assert.equal(error.details.engineRolledBack, true)
      return true
    },
  )

  assert.equal(reloadCalls, 2)
  assert.equal(await rulesStore.getPublishedId(), previous.id)
})

test('first publish failure restores the unpublished state via internal default reset', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'screen-damage-first-publish-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const rulesStore = new RulesStore({ dataDir })
  await rulesStore.ensureReady()
  const candidate = await rulesStore.create('首次发布', '', clone(validRuleSet().nodes))
  let resetCalls = 0

  await assert.rejects(
    publishAndReloadRule(candidate.id, {
      rulesStore,
      reloadEngine: async () => { throw new Error('模拟首次热加载失败') },
      resetEngine: async () => {
        resetCalls++
        return {
          success: true,
          version: '1.0',
          ruleId: 'builtin-default',
          revision: 'builtin-default-v1',
        }
      },
    }),
    error => {
      assert.equal(error.code, 'ENGINE_RELOAD_FAILED_ROLLED_BACK')
      assert.equal(error.details.previousPublishedId, null)
      assert.equal(error.details.engineRolledBack, true)
      return true
    },
  )

  assert.equal(resetCalls, 1)
  assert.equal(await rulesStore.getPublishedId(), null)
})

test('engine acknowledgement must match immutable rule identity, not version alone', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'screen-damage-rule-identity-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const rulesStore = new RulesStore({ dataDir })
  await rulesStore.ensureReady()
  const previous = await rulesStore.create('身份校验', '', clone(validRuleSet().nodes))
  await rulesStore.publish(previous.id)
  const candidate = await rulesStore.create('另一规则名', '', clone(validRuleSet().nodes))
  let calls = 0

  await assert.rejects(
    publishAndReloadRule(candidate.id, {
      rulesStore,
      reloadEngine: async () => {
        calls++
        const active = await rulesStore.getPublished()
        if (calls === 1) {
          return { success: true, version: candidate.version, ruleId: 'wrong-id', revision: candidate.revision }
        }
        return { success: true, version: active.version, ruleId: active.id, revision: active.revision }
      },
    }),
    error => {
      assert.equal(error.code, 'ENGINE_RELOAD_FAILED_ROLLED_BACK')
      assert.match(error.message, /规则 ID 不匹配/)
      return true
    },
  )
  assert.equal(await rulesStore.getPublishedId(), previous.id)
})

test('rule versions use max-plus-one and draft rename cannot create a collision', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'screen-damage-rule-version-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const rulesStore = new RulesStore({ dataDir })
  await rulesStore.ensureReady()
  const a0 = await rulesStore.create('A', '', clone(validRuleSet().nodes))
  const a1 = await rulesStore.create('A', '', clone(validRuleSet().nodes))
  const b0 = await rulesStore.create('B', '', clone(validRuleSet().nodes))
  assert.equal(a0.version, '1.0')
  assert.equal(a1.version, '1.1')
  assert.equal(b0.version, '1.0')
  await assert.rejects(rulesStore.update(b0.id, { ruleSetName: 'A' }), error => {
    assert.equal(error.code, 'RULE_VERSION_CONFLICT')
    assert.equal(error.statusCode, 409)
    return true
  })

  const beforeRevision = a1.revision
  const updated = await rulesStore.update(a1.id, { description: '新描述' })
  assert.match(updated.revision, /^[a-f0-9]{64}$/)
  assert.notEqual(updated.revision, beforeRevision)
  const payload = await rulesStore.getDecisionTreePayload(a1.id)
  assert.equal(payload.id, a1.id)
  assert.equal(payload.revision, updated.revision)
})

test('publish reports persistent rollback failure explicitly', async () => {
  const fakeStore = {
    publishWithPrevious: async () => ({
      previousPublishedId: 'previous',
      rule: { id: 'candidate', version: '2.0' },
    }),
    get: async () => ({ id: 'previous', version: '1.0' }),
    restorePublishedId: async () => { throw new Error('磁盘写入失败') },
  }

  await assert.rejects(
    publishAndReloadRule('candidate', {
      rulesStore: fakeStore,
      reloadEngine: async () => { throw new Error('引擎不可用') },
    }),
    error => {
      assert.equal(error.code, 'PUBLISH_ROLLBACK_FAILED')
      assert.equal(error.details.persistedRolledBack, false)
      assert.equal(error.details.requiresManualRecovery, true)
      return true
    },
  )
})

test('publish reports engine rollback reload failure explicitly', async () => {
  const fakeStore = {
    publishWithPrevious: async () => ({
      previousPublishedId: 'previous',
      rule: { id: 'candidate', version: '2.0' },
    }),
    get: async () => ({ id: 'previous', version: '1.0' }),
    restorePublishedId: async () => 'previous',
  }

  await assert.rejects(
    publishAndReloadRule('candidate', {
      rulesStore: fakeStore,
      reloadEngine: async () => { throw new Error('引擎不可用') },
    }),
    error => {
      assert.equal(error.code, 'ENGINE_ROLLBACK_RELOAD_FAILED')
      assert.equal(error.details.persistedRolledBack, true)
      assert.equal(error.details.engineRolledBack, false)
      assert.equal(error.details.requiresManualRecovery, true)
      return true
    },
  )
})

const baseDecisionRequest = {
  caseId: 'case-1',
  installStatus: 'installed',
  authPersonnel: 'yes',
  packageDamage: 'none',
  faultLinks: ['product_factor'],
}

test('decision request schema rejects invalid enums and ambiguous fault links', () => {
  const { faultLinks: _omitted, ...withoutFaultLinks } = baseDecisionRequest
  assert.throws(
    () => validateDecisionRequest(withoutFaultLinks),
    /faultLinks 必须是数组/,
  )
  assert.throws(
    () => validateDecisionRequest({ ...baseDecisionRequest, faultLinks: [] }),
    /faultLinks 不能为空/,
  )
  assert.doesNotThrow(
    () => validateDecisionRequest({ ...baseDecisionRequest, faultLinks: ['unknown'] }),
  )
  assert.throws(
    () => validateDecisionRequest({ ...baseDecisionRequest, installStatus: 'maybe' }),
    DecisionRequestError,
  )
  assert.throws(
    () => validateDecisionRequest({ ...baseDecisionRequest, faultLinks: ['unknown', 'product_factor'] }),
    /unknown 不能与其他选项/,
  )
  assert.throws(
    () => validateDecisionRequest({ ...baseDecisionRequest, conclusion: 'bad' }),
    /conclusion 取值无效/,
  )
})

test('buildAnswers always populates every decision input supported by managed graphs', () => {
  const { answers } = buildAnswers(baseDecisionRequest)
  assert.deepEqual(new Set(Object.keys(answers)), new Set([
    'decision_installed',
    'decision_auth_personnel',
    'decision_package_damage',
    'decision_product_factor',
    'decision_logistics_factor',
    'decision_install_use',
  ]))
})

test('two or more uncertain fields return manual_review', () => {
  const result = evaluateDecision({
    ...baseDecisionRequest,
    installStatus: 'unknown',
    authPersonnel: 'unknown',
    faultLinks: ['product_factor'],
  })
  assert.equal(result.result, 'manual_review')
  assert.equal(result.resultLabel, '转人工复核')
  assert.equal(result.reviewReason, 'insufficient_information')
})

test('damaged package values use the logistics branch', () => {
  for (const packageDamage of ['damaged', 'minor', 'severe']) {
    const result = evaluateDecision({
      ...baseDecisionRequest,
      installStatus: 'not_installed',
      packageDamage,
      faultLinks: ['logistics_transport'],
    })
    assert.ok(result.decisionPath.some(step => step.nodeId === 'decision_logistics_factor'))
    assert.equal(result.result, 'not_product_quality')
  }
})

test('AI cannot unconditionally overwrite rules and trusted conflicts require review', () => {
  const untrusted = evaluateDecision({
    ...baseDecisionRequest,
    conclusion: 'product_quality_issue',
  })
  assert.equal(untrusted.result, 'not_product_quality')
  assert.equal(untrusted.aiAdvisory.status, 'ignored_untrusted')

  const lowConfidence = evaluateDecision({
    ...baseDecisionRequest,
    conclusion: 'product_quality_issue',
    conclusionTrusted: true,
    conclusionConfidence: 0.5,
  })
  assert.equal(lowConfidence.result, 'not_product_quality')
  assert.equal(lowConfidence.aiAdvisory.status, 'ignored_low_confidence')

  const trustedConflict = evaluateDecision({
    ...baseDecisionRequest,
    conclusion: 'product_quality_issue',
    conclusionTrusted: true,
    conclusionConfidence: 0.95,
  })
  assert.equal(trustedConflict.result, 'manual_review')
  assert.equal(trustedConflict.reviewReason, 'ai_rule_conflict')
  assert.equal(trustedConflict.aiAdvisory.status, 'conflict_manual_review')
})

test('rule synchronization is fail-closed until an identified admin rule loads', async () => {
  const failed = await reloadRulesFromAdmin({
    fetcher: async () => { throw new Error('管理中台未就绪') },
  })
  assert.equal(failed.ok, false)
  assert.equal(getRuleSyncStatus().rulesReady, false)
  assert.equal(getRuleSyncStatus().source, 'builtin-fallback')

  const syncedRule = validRuleSet({ id: 'synced-rule', revision: 'synced-revision', version: '9.1' })
  const loaded = await reloadRulesFromAdmin({
    fetcher: async () => ({ success: true, data: syncedRule }),
  })
  assert.deepEqual(loaded, {
    ok: true,
    version: '9.1',
    ruleId: 'synced-rule',
    revision: 'synced-revision',
  })
  assert.equal(getRuleSyncStatus().rulesReady, true)
  assert.equal(getRuleSyncStatus().source, 'admin-published')
  assert.equal(getRuleSyncStatus().ruleId, 'synced-rule')

  assert.equal(ruleReloadRetryDelay(0, { baseMs: 100, maxMs: 350 }), 100)
  assert.equal(ruleReloadRetryDelay(1, { baseMs: 100, maxMs: 350 }), 200)
  assert.equal(ruleReloadRetryDelay(2, { baseMs: 100, maxMs: 350 }), 350)
  assert.equal(ruleReloadRetryDelay(20, { baseMs: 100, maxMs: 350 }), 350)
  stopRuleReloadRetry()
})

test('rule reconciliation interval has a safe minimum and stable default', () => {
  assert.equal(normalizeRuleReconcileInterval(undefined), DEFAULT_RULE_RECONCILE_INTERVAL_MS)
  assert.equal(normalizeRuleReconcileInterval('invalid'), DEFAULT_RULE_RECONCILE_INTERVAL_MS)
  assert.equal(normalizeRuleReconcileInterval(0), MIN_RULE_RECONCILE_INTERVAL_MS)
  assert.equal(normalizeRuleReconcileInterval(10), MIN_RULE_RECONCILE_INTERVAL_MS)
  assert.equal(normalizeRuleReconcileInterval(5000), 5000)
})

test('periodic reconciliation confirms identity, heals split-brain, and degrades without dropping the active rule', async t => {
  const scheduled = []
  const setTimer = (callback, delay) => {
    const handle = { callback, delay, cleared: false, unref() {} }
    scheduled.push(handle)
    return handle
  }
  const clearTimer = handle => { handle.cleared = true }

  // 与上一用例已加载规则身份一致，但故意改动内容：对账应只确认身份，不必要重载。
  let published = validRuleSet({ id: 'synced-rule', revision: 'synced-revision', version: '9.1' })
  published.nodes.find(node => node.id === 'quality').result = '非质量问题'
  let reconcileFailure = null
  const fetcher = async () => {
    if (reconcileFailure) throw reconcileFailure
    return { success: true, data: structuredClone(published) }
  }

  t.after(() => stopRuleReconciliation())
  startRuleReconciliation({
    fetcher,
    intervalMs: 10,
    setTimer,
    clearTimer,
  })

  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0].delay, MIN_RULE_RECONCILE_INTERVAL_MS)
  assert.ok(getRuleSyncStatus().nextReconcileAt)

  await scheduled[0].callback()
  assert.equal(getRuleSyncStatus().lastAction, 'confirmed')
  assert.equal(getRuleSyncStatus().degraded, false)
  assert.equal(evaluateDecision(baseDecisionRequest).result, 'product_quality_issue')
  assert.equal(scheduled.length, 2)

  // 模拟 admin 已落盘新 publishedId，但在调用引擎 reload 前崩溃。
  published = validRuleSet({ id: 'persisted-after-crash', revision: 'revision-after-crash', version: '9.2' })
  published.nodes.find(node => node.id === 'quality').result = '非质量问题'
  await scheduled[1].callback()
  assert.equal(getRuleSyncStatus().lastAction, 'reloaded')
  assert.equal(getRuleSyncStatus().ruleId, 'persisted-after-crash')
  assert.equal(getRuleSyncStatus().version, '9.2')
  assert.equal(getRuleSyncStatus().revision, 'revision-after-crash')
  assert.equal(evaluateDecision(baseDecisionRequest).result, 'not_product_quality')
  assert.equal(scheduled.length, 3)

  reconcileFailure = new Error('管理中台暂时不可用')
  await scheduled[2].callback()
  const degraded = getRuleSyncStatus()
  assert.equal(degraded.rulesReady, true)
  assert.equal(degraded.degraded, true)
  assert.match(degraded.lastError, /暂时不可用/)
  assert.equal(degraded.ruleId, 'persisted-after-crash')
  assert.equal(evaluateDecision(baseDecisionRequest).result, 'not_product_quality')

  const health = await invokeEngineRoute('GET', '/api/health')
  assert.equal(health.statusCode, 200)
  assert.equal(health.payload.status, 'ok')
  assert.equal(health.payload.degraded, true)
  assert.equal(health.payload.ruleSyncStatus, 'degraded')
  assert.match(health.payload.lastError, /暂时不可用/)

  const evaluation = await invokeEngineRoute('POST', '/api/decision/evaluate', baseDecisionRequest)
  assert.equal(evaluation.statusCode, 200)
  assert.equal(evaluation.payload.data.ruleId, 'persisted-after-crash')
  assert.equal(scheduled.length, 4)

  reconcileFailure = null
  await scheduled[3].callback()
  assert.equal(getRuleSyncStatus().lastAction, 'confirmed')
  assert.equal(getRuleSyncStatus().degraded, false)
  assert.equal(getRuleSyncStatus().lastError, null)
  assert.equal(scheduled.length, 5)
})
