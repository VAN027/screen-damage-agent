FROM node:20-alpine

WORKDIR /app

COPY services/knowledge-ai/src/ ./services/knowledge-ai/src/

ENV KNOWLEDGE_PORT=8083

EXPOSE 8083

# data 目录通过 volume 挂载
CMD ["node", "services/knowledge-ai/src/index.mjs"]
