FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS dependencies

WORKDIR /app/services/read-only-mcp

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY services/read-only-mcp/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=dependencies --chown=node:node /app/services/read-only-mcp/node_modules/ ./services/read-only-mcp/node_modules/
COPY --chown=node:node services/read-only-mcp/src/ ./services/read-only-mcp/src/

ENV NODE_ENV=production \
    SERVICE_HOST=0.0.0.0 \
    MCP_PORT=8090 \
    KNOWLEDGE_DB_PATH=/app/services/knowledge-ai/data/knowledge.db

EXPOSE 8090

USER node

CMD ["node", "services/read-only-mcp/src/index.mjs"]
