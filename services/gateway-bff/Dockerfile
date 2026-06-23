FROM node:20-alpine

WORKDIR /app

# 网关源码 & frontend（保持相对路径，兼容代码中的 join(__dirname, '..', '..', '..') ）
COPY services/gateway-bff/src/ ./services/gateway-bff/src/
COPY frontend/ ./frontend/

ENV BFF_PORT=8080
ENV DECISION_ENGINE_URL=http://decision-engine:8081
ENV KNOWLEDGE_AI_URL=http://knowledge-ai:8083

EXPOSE 8080

CMD ["node", "services/gateway-bff/src/index.mjs"]
