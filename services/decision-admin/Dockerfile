FROM node:20-alpine

WORKDIR /app

COPY services/decision-admin/src/ ./services/decision-admin/src/
COPY services/decision-admin/static/ ./services/decision-admin/static/

ENV ADMIN_PORT=8082

EXPOSE 8082

# data 目录通过 volume 挂载，不在镜像内存储
CMD ["node", "services/decision-admin/src/index.mjs"]
