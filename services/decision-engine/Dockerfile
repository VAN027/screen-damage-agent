FROM node:20-alpine

WORKDIR /app

COPY services/decision-engine/src/ ./services/decision-engine/src/

ENV ENGINE_PORT=8081
ENV ADMIN_URL=http://decision-admin:8082

EXPOSE 8081

CMD ["node", "services/decision-engine/src/index.mjs"]
