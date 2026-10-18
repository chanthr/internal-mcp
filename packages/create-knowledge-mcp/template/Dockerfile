# Your Knowledge MCP server as a container.
#   docker build -t my-mcp .
#   docker run -d -p 8080:8080 -v my-mcp-data:/data --env-file .env my-mcp
#   docker exec <container> node dist/server.js keys create --email you@example.com --role admin
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S -G app -h /app app && mkdir -p /data && chown app:app /data
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./
USER app
ENV NODE_ENV=production MCP_TRANSPORT=http PORT=8080 MCP_DATA_DIR=/data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
ENTRYPOINT ["node", "dist/server.js"]
CMD ["serve"]
