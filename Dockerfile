# syntax=docker/dockerfile:1.7
# Knowledge MCP — the server with the built-in plugins (Drive, Slack, GitHub, Railway).
# To ship your own plugins, scaffold a project with `npx create-knowledge-mcp` (it has its own Dockerfile).
#
# Published image: ghcr.io/chanthr/knowledge-mcp (built by .github/workflows/docker.yml)
#   docker run -d --name kmcp -p 8080:8080 -v kmcp-data:/data -v ./mcp.config.json:/app/mcp.config.json:ro \
#     --env-file .env ghcr.io/chanthr/knowledge-mcp
#   docker exec kmcp knowledge-mcp keys create --email you@example.com --role admin
#   docker exec kmcp knowledge-mcp doctor
#   docker exec kmcp knowledge-mcp drive reindex     # first full Drive index (uses the same config)

# === Build stage — workspace install + tsc ===
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/knowledge-mcp/package.json packages/knowledge-mcp/
COPY packages/create-knowledge-mcp/package.json packages/create-knowledge-mcp/
RUN npm ci
COPY packages/knowledge-mcp/tsconfig.json packages/knowledge-mcp/tsconfig.build.json packages/knowledge-mcp/
COPY packages/knowledge-mcp/src packages/knowledge-mcp/src
RUN npm run build -w @chnxthr/knowledge-mcp

# === Production deps — only what the core package needs ===
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/knowledge-mcp/package.json packages/knowledge-mcp/
COPY packages/create-knowledge-mcp/package.json packages/create-knowledge-mcp/
RUN npm ci --omit=dev -w @chnxthr/knowledge-mcp && npm cache clean --force

# === Runtime ===
FROM node:22-alpine AS runtime

LABEL org.opencontainers.image.title="knowledge-mcp" \
      org.opencontainers.image.description="Self-hostable MCP server: plugins, API keys and OAuth, Drive, Slack, GitHub and Railway" \
      org.opencontainers.image.source="https://github.com/chanthr/internal-mcp" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Non-root user. /data holds the SQLite store (keys, users, OAuth tokens, plugin state) — mount a volume there.
RUN addgroup -S app && adduser -S -G app -h /app app && mkdir -p /data && chown app:app /data

# Config (mcp.config.json) and secrets are never baked in: mount /app/mcp.config.json or set MCP_CONFIG_JSON,
# and pass secrets as env.
COPY --from=deps    --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/packages/knowledge-mcp/dist ./packages/knowledge-mcp/dist
COPY --chown=app:app packages/knowledge-mcp/package.json ./packages/knowledge-mcp/
COPY --chown=app:app packages/knowledge-mcp/sql ./packages/knowledge-mcp/sql
RUN chmod +x packages/knowledge-mcp/dist/cli.js && ln -s /app/packages/knowledge-mcp/dist/cli.js /usr/local/bin/knowledge-mcp

USER app

ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV PORT=8080
ENV MCP_DATA_DIR=/data

VOLUME /data
EXPOSE 8080

# /health needs no auth. In stdio mode (serve --stdio) this check reports unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

# Any knowledge-mcp command works as arguments: keys, users, doctor, drive reindex ...
ENTRYPOINT ["knowledge-mcp"]
CMD ["serve"]
