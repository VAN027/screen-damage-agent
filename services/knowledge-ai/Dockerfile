FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS dependencies

WORKDIR /app/services/knowledge-ai

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY services/knowledge-ai/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libstdc++6 \
       libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=dependencies --chown=node:node /app/services/knowledge-ai/node_modules/ ./services/knowledge-ai/node_modules/
COPY --chown=node:node services/shared/ ./services/shared/
COPY --chown=node:node services/knowledge-ai/src/ ./services/knowledge-ai/src/
COPY --chown=node:node services/knowledge-ai/tools/ ./services/knowledge-ai/tools/
COPY --chown=node:node services/knowledge-ai/data/model-config.template.json \
     services/knowledge-ai/data/annotation-config.template.json \
     services/knowledge-ai/data/field-defs.json \
     ./services/knowledge-ai/data-seed/
COPY services/knowledge-ai/docker-entrypoint.sh /usr/local/bin/screen-damage-entrypoint

RUN chmod 0755 /usr/local/bin/screen-damage-entrypoint \
    && mkdir -p /app/services/knowledge-ai/data \
    && chown node:node /app/services/knowledge-ai/data

ENV NODE_ENV=production \
    KNOWLEDGE_PORT=8083 \
    CLIP_SERVICE_URL=http://python-features:8084

EXPOSE 8083

USER node

ENTRYPOINT ["screen-damage-entrypoint"]
CMD ["node", "services/knowledge-ai/src/index.mjs"]
