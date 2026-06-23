import { readFile, writeFile, readdir, mkdir, unlink, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '..', 'data')
const INDEX_FILE = join(DATA_DIR, 'index.json')

export class RulesStore {
  constructor() {
    this.index = null
    this.initPromise = this.init()
  }

  async init() {
    await mkdir(DATA_DIR, { recursive: true })
    try {
      const raw = await readFile(INDEX_FILE, 'utf-8')
      this.index = JSON.parse(raw)
    } catch {
      this.index = { rules: [], publishedId: null }
      await this.saveIndex()
    }
  }

  async ensureReady() {
    await this.initPromise
  }

  async saveIndex() {
    await writeFile(INDEX_FILE, JSON.stringify(this.index, null, 2), 'utf-8')
  }

  async list() {
    await this.ensureReady()
    return this.index.rules.map(r => ({
      id: r.id,
      ruleSetName: r.ruleSetName,
      version: r.version,
      status: r.id === this.index.publishedId ? 'published' : 'draft',
      updatedAt: r.updatedAt,
    }))
  }

  async get(id) {
    await this.ensureReady()
    const meta = this.index.rules.find(r => r.id === id)
    if (!meta) return null
    const filePath = join(DATA_DIR, `${id}.json`)
    const raw = await readFile(filePath, 'utf-8')
    return {
      ...JSON.parse(raw),
      status: id === this.index.publishedId ? 'published' : 'draft',
    }
  }

  async getPublished() {
    await this.ensureReady()
    if (!this.index.publishedId) return null
    return this.get(this.index.publishedId)
  }

  async create(ruleSetName, description, nodes) {
    await this.ensureReady()
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const existedVersions = this.index.rules.filter(r => r.ruleSetName === ruleSetName)
    const nextVer = existedVersions.length + 1

    const meta = {
      id,
      ruleSetName,
      version: `1.${nextVer - 1}`,
      description,
      updatedAt: now,
      status: 'draft',
    }

    const ruleSet = {
      id,
      ruleSetName,
      version: meta.version,
      description,
      startNodeId: nodes[0]?.id || 'node_start',
      nodes,
      updatedAt: now,
      status: 'draft',
    }

    await writeFile(join(DATA_DIR, `${id}.json`), JSON.stringify(ruleSet, null, 2), 'utf-8')
    this.index.rules.push({
      id: meta.id,
      ruleSetName: meta.ruleSetName,
      version: meta.version,
      updatedAt: meta.updatedAt,
    })
    await this.saveIndex()
    return ruleSet
  }

  async update(id, updates) {
    await this.ensureReady()
    const meta = this.index.rules.find(r => r.id === id)
    if (!meta) throw new Error(`规则 ${id} 不存在`)

    const existing = await this.get(id)
    const now = new Date().toISOString()

    const updated = {
      ...existing,
      ruleSetName: updates.ruleSetName ?? existing.ruleSetName,
      description: updates.description ?? existing.description,
      nodes: updates.nodes ?? existing.nodes,
      startNodeId: updates.nodes ? updates.nodes[0]?.id : existing.startNodeId,
      updatedAt: now,
      status: existing.status,
    }

    await writeFile(join(DATA_DIR, `${id}.json`), JSON.stringify(updated, null, 2), 'utf-8')
    meta.updatedAt = now
    if (updates.ruleSetName) meta.ruleSetName = updates.ruleSetName
    await this.saveIndex()
    return updated
  }

  async publish(id) {
    await this.ensureReady()
    const meta = this.index.rules.find(r => r.id === id)
    if (!meta) throw new Error(`规则 ${id} 不存在`)

    this.index.publishedId = id
    await this.saveIndex()
    return this.get(id)
  }

  async remove(id) {
    await this.ensureReady()
    const idx = this.index.rules.findIndex(r => r.id === id)
    if (idx === -1) return false

    if (this.index.publishedId === id) {
      this.index.publishedId = null
    }

    this.index.rules.splice(idx, 1)
    await this.saveIndex()

    try {
      await unlink(join(DATA_DIR, `${id}.json`))
    } catch { /* file already gone */ }

    return true
  }

  async getDecisionTreePayload(id) {
    await this.ensureReady()
    const targetId = id || this.index.publishedId
    if (!targetId) return null

    const rule = await this.get(targetId)
    if (!rule) return null

    return {
      ruleSetName: rule.ruleSetName,
      version: rule.version,
      description: rule.description,
      startNodeId: rule.startNodeId,
      nodes: rule.nodes,
    }
  }
}

export const store = new RulesStore()
