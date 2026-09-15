FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

WORKDIR /app
COPY --chown=node:node services/shared/ ./services/shared/
COPY --chown=node:node services/decision-engine/src/ ./services/decision-engine/src/

ENV NODE_ENV=production \
    ENGINE_PORT=8081 \
    ADMIN_URL=http://decision-admin:8082

EXPOSE 8081

USER node

CMD ["node", "services/decision-engine/src/index.mjs"]
