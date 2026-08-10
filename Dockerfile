# syntax=docker/dockerfile:1.7
# Knowledge MCP — Multi-stage build
# - Builder: TypeScript compile (npm ci + tsc)
# - Deps: production-only node_modules (smaller final image)
# - Runtime: node 22 alpine + dist + production deps, non-root user

# === Build stage ===
FROM node:22-alpine AS builder

WORKDIR /app

# package.json + lock 먼저 (cache 활용)
COPY package*.json ./
RUN npm ci

# Source + build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# === Production deps stage ===
FROM node:22-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && \
    npm cache clean --force

# === Runtime stage ===
FROM node:22-alpine AS runtime

WORKDIR /app

# 보안: 비-root user 로 실행
RUN addgroup -S app && adduser -S -G app -h /app app

# Production deps + dist 만 copy
COPY --from=deps    --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --chown=app:app package*.json ./

USER app

ENV NODE_ENV=production
ENV MCP_TRANSPORT=http

# Railway 가 PORT env 를 자동 inject. server 가 process.env.PORT || '8080' 사용.
EXPOSE 8080

CMD ["node", "dist/index.js"]
