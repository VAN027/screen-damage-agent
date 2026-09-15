const fs = require('node:fs')
const path = require('node:path')

const root = __dirname

function requireSecret(name) {
  const value = process.env[name]
  if (!value || !value.trim()) {
    throw new Error(`${name} is required; refusing to start services without authentication`)
  }
  return value
}

function optionalEnvironment(name) {
  const value = process.env[name]
  return value && value.trim() ? { [name]: value } : {}
}

const adminApiToken = requireSecret('ADMIN_API_TOKEN')
const internalServiceToken = requireSecret('INTERNAL_SERVICE_TOKEN')

if (!process.env.LLM_API_KEY) {
  console.warn('[ecosystem] LLM_API_KEY is not set; LLM analysis will be unavailable')
}

const venvCandidates = [
  path.join(root, 'services/knowledge-ai/python/.venv/bin/python'),
  path.join(root, 'services/knowledge-ai/python/venv/bin/python'),
]
const pythonInterpreter = process.env.PYTHON_EXECUTABLE
  || venvCandidates.find(candidate => fs.existsSync(candidate))
  || 'python3'

const appDefaults = {
  cwd: root,
  autorestart: true,
  max_restarts: 10,
  min_uptime: 5000,
  restart_delay: 3000,
  kill_timeout: 10000,
  log_date_format: 'YYYY-MM-DD HH:mm:ss',
}

module.exports = {
  apps: [
    {
      ...appDefaults,
      name: 'screen-python-features',
      script: 'services/knowledge-ai/python/main.py',
      interpreter: pythonInterpreter,
      env: {
        SERVICE_HOST: '127.0.0.1',
        CLIP_PORT: '8084',
        ORIENTATION_OCR_ENABLED: process.env.ORIENTATION_OCR_ENABLED || 'true',
        ORIENTATION_OCR_LANG: process.env.ORIENTATION_OCR_LANG || 'ch',
        PADDLE_PDX_CACHE_HOME: process.env.PADDLE_PDX_CACHE_HOME || path.join(root, 'services', 'knowledge-ai', '.paddlex'),
        PADDLE_PDX_MODEL_SOURCE: process.env.PADDLE_PDX_MODEL_SOURCE || 'BOS',
        PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT: '0',
        INTERNAL_SERVICE_TOKEN: internalServiceToken,
        VECTOR_DATA_DIR: path.join(root, 'services/knowledge-ai/data'),
        DINO_MODEL_NAME: process.env.DINO_MODEL_NAME || 'facebook/dinov2-small',
        DINO_LOCAL_FILES_ONLY: process.env.DINO_LOCAL_FILES_ONLY || 'false',
        MILVUS_HOST: process.env.MILVUS_HOST || 'localhost',
        MILVUS_PORT: process.env.MILVUS_PORT || '19530',
        MILVUS_REST_PORT: process.env.MILVUS_REST_PORT || '9091',
      },
    },
    {
      ...appDefaults,
      name: 'screen-knowledge-ai',
      script: 'services/knowledge-ai/src/index.mjs',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--dns-result-order=ipv4first',
        SERVICE_HOST: '127.0.0.1',
        KNOWLEDGE_PORT: '8083',
        REVIEW_IMAGE_RETENTION_DAYS: process.env.REVIEW_IMAGE_RETENTION_DAYS || '90',
        CLIP_SERVICE_URL: 'http://localhost:8084',
        ADMIN_API_TOKEN: adminApiToken,
        INTERNAL_SERVICE_TOKEN: internalServiceToken,
        ...optionalEnvironment('LLM_API_KEY'),
        ...optionalEnvironment('LLM_ANNO_API_KEY'),
        ...optionalEnvironment('LLM_ALLOWED_HOSTS'),
      },
    },
    {
      ...appDefaults,
      name: 'screen-decision-admin',
      script: 'services/decision-admin/src/index.mjs',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        // The administration UI is currently accessed directly on :8082.
        // Its API routes remain protected by ADMIN_API_TOKEN.
        SERVICE_HOST: '0.0.0.0',
        ADMIN_PORT: '8082',
        KNOWLEDGE_AI_URL: 'http://localhost:8083',
        DECISION_ENGINE_URL: 'http://localhost:8081',
        ADMIN_API_TOKEN: adminApiToken,
        INTERNAL_SERVICE_TOKEN: internalServiceToken,
      },
    },
    {
      ...appDefaults,
      name: 'screen-read-only-mcp',
      script: 'services/read-only-mcp/src/index.mjs',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        SERVICE_HOST: '127.0.0.1',
        MCP_PORT: process.env.MCP_PORT || '8090',
        MCP_API_TOKEN: process.env.MCP_API_TOKEN || adminApiToken,
        MCP_ALLOWED_HOSTS: process.env.MCP_ALLOWED_HOSTS || 'localhost,127.0.0.1,::1',
        MCP_REQUESTS_PER_MINUTE: process.env.MCP_REQUESTS_PER_MINUTE || '120',
        KNOWLEDGE_DB_PATH: path.join(root, 'services', 'knowledge-ai', 'data', 'knowledge.db'),
      },
    },
    {
      ...appDefaults,
      name: 'screen-decision-engine',
      script: 'services/decision-engine/src/index.mjs',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        SERVICE_HOST: '127.0.0.1',
        ENGINE_PORT: '8081',
        ADMIN_URL: 'http://localhost:8082',
        INTERNAL_SERVICE_TOKEN: internalServiceToken,
      },
    },
    {
      ...appDefaults,
      name: 'screen-gateway-bff',
      script: 'services/gateway-bff/src/index.mjs',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        // Frontline users currently access the BFF directly on :8080.
        // Internal services stay loopback-only; only this public edge binds all interfaces.
        SERVICE_HOST: '0.0.0.0',
        TRUST_PROXY: '1',
        TRUSTED_PROXY_IPS: '127.0.0.1,::1',
        BFF_PORT: '8080',
        DECISION_ENGINE_URL: 'http://localhost:8081',
        KNOWLEDGE_AI_URL: 'http://localhost:8083',
        INTERNAL_SERVICE_TOKEN: internalServiceToken,
        LLM_GLOBAL_REQUESTS_PER_MINUTE: process.env.LLM_GLOBAL_REQUESTS_PER_MINUTE || '30',
        LLM_GLOBAL_REQUESTS_PER_DAY: process.env.LLM_GLOBAL_REQUESTS_PER_DAY || '500',
        LLM_GLOBAL_CONCURRENCY: process.env.LLM_GLOBAL_CONCURRENCY || '3',
        VECTOR_GLOBAL_CONCURRENCY: process.env.VECTOR_GLOBAL_CONCURRENCY || '4',
        ...optionalEnvironment('CORS_ALLOWED_ORIGINS'),
      },
    },
  ],
}
