# API server for Fly.io. The web app is static and deploys to Vercel.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# Workspace manifests first for layer caching.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server -w shared --include-workspace-root=false

COPY shared/src shared/src
COPY server/src server/src
COPY tsconfig.base.json ./
COPY server/tsconfig.json server/

ENV PORT=8080 DB_PATH=/data/msl.db
EXPOSE 8080
CMD ["npm", "start", "-w", "server"]
