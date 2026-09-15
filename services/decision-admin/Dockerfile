FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

WORKDIR /app

COPY --chown=node:node services/shared/ ./services/shared/
COPY --chown=node:node services/decision-admin/src/ ./services/decision-admin/src/
COPY --chown=node:node services/decision-admin/static/ ./services/decision-admin/static/

RUN mkdir -p /app/services/decision-admin/data \
    && chown node:node /app/services/decision-admin/data

ENV NODE_ENV=production \
    ADMIN_PORT=8082 \
    KNOWLEDGE_AI_URL=http://knowledge-ai:8083 \
    DECISION_ENGINE_URL=http://decision-engine:8081

EXPOSE 8082

USER node

CMD ["node", "services/decision-admin/src/index.mjs"]
