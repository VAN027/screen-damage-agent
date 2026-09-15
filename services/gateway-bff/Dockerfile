FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

WORKDIR /app
COPY --chown=node:node services/shared/ ./services/shared/
COPY --chown=node:node services/gateway-bff/src/ ./services/gateway-bff/src/
COPY --chown=node:node frontend/ ./frontend/

ENV NODE_ENV=production \
    BFF_PORT=8080 \
    DECISION_ENGINE_URL=http://decision-engine:8081 \
    KNOWLEDGE_AI_URL=http://knowledge-ai:8083

EXPOSE 8080

USER node

CMD ["node", "services/gateway-bff/src/index.mjs"]
