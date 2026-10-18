# syntax=docker/dockerfile:1.7
# Knowledge MCP — Multi-stage build
# - Builder: TypeScript compile (npm ci + tsc) for the server and the reindex script
# - Deps: production-only node_modules (smaller final image)
# - Runtime: node 22 alpine + dist + production deps, non-root user
#
# Published image: ghcr.io/chanthr/knowledge-mcp (built by .github/workflows/docker.yml)
#   Server :  docker run --env-file .env -v ./mcp.config.json:/app/mcp.config.json:ro -p 8080:8080 <image>
#   Reindex:  docker run --rm --env-file .env -v ./mcp.config.json:/app/mcp.config.json:ro <image> \
#               node dist-scripts/scripts/index_drive.js

# === Build stage ===
FROM node:22-alpine AS builder

WORKDIR /app

# package.json + lock 먼저 (cache 활용)
COPY package*.json ./
RUN npm ci

# Source + build (서버 + 재색인 스크립트)
COPY tsconfig.json tsconfig.scripts.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm run build:scripts

# === Production deps stage ===
FROM node:22-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && \
    npm cache clean --force

# === Runtime stage ===
FROM node:22-alpine AS runtime

LABEL org.opencontainers.image.title="knowledge-mcp" \
      org.opencontainers.image.description="Self-hostable MCP server for Google Drive, Slack, GitHub and Railway" \
      org.opencontainers.image.source="https://github.com/chanthr/internal-mcp" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# 보안: 비-root user 로 실행
RUN addgroup -S app && adduser -S -G app -h /app app

# Production deps + dist 만 copy. 설정(mcp.config.json)과 비밀값은 이미지에 넣지 않는다 —
# 실행할 때 MCP_CONFIG_JSON 이나 /app/mcp.config.json 마운트, 그리고 env 로 넣는다.
COPY --from=deps    --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/dist-scripts ./dist-scripts
COPY --chown=app:app package*.json ./

USER app

ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV PORT=8080

# 호스트(Railway 등)가 PORT 를 넣으면 그 값을 쓴다. 기본 8080.
EXPOSE 8080

# /health 는 인증 없이 열린다. stdio 모드(MCP_TRANSPORT=stdio)로 돌리면 이 검사는 unhealthy 로 나온다.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["node", "dist/index.js"]
