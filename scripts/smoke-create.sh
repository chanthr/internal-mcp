#!/usr/bin/env bash
# End-to-end check of the "install and build your own" path, with nothing from the npm registry for our packages:
#   pack @chanthr/knowledge-mcp → scaffold with create-knowledge-mcp → npm install → build →
#   doctor → serve over HTTP → create a key → call the example plugin with the MCP client.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'kill ${SERVER_PID:-0} 2>/dev/null || true; rm -rf "$WORK"' EXIT

echo "== pack"
npm run build -w @chanthr/knowledge-mcp >/dev/null
(cd "$ROOT/packages/knowledge-mcp" && npm pack --silent --ignore-scripts --pack-destination "$WORK" >/dev/null)
TGZ="$(ls "$WORK"/chanthr-knowledge-mcp-*.tgz)"
tar -tzf "$TGZ" | grep -q 'package/dist/cli.js'
if tar -tzf "$TGZ" | grep -E 'package/(src|test)/' >/dev/null; then echo "tarball contains src or test" >&2; exit 1; fi

echo "== scaffold"
(cd "$WORK" && KMCP_CORE_SPEC="file:$TGZ" node "$ROOT/packages/create-knowledge-mcp/index.js" my-mcp --no-git >/dev/null)
cd "$WORK/my-mcp"
test -f .gitignore && test -f src/plugins/notes.ts

echo "== build and doctor"
npm run build >/dev/null
node dist/server.js doctor | tee "$WORK/doctor.txt"
grep -q '✓ notes' "$WORK/doctor.txt"

echo "== serve"
export MCP_DATA_DIR="$WORK/data" PORT=18931
node dist/server.js serve >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/health"; echo
KEY="$(node dist/server.js keys create --email me@example.com --role admin 2>/dev/null)"

echo "== call notes_add / notes_list through MCP"
cat > "$WORK/call.mjs" <<'JS'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const [url, key] = process.argv.slice(2);
const c = new Client({ name: 'smoke', version: '1.0.0' });
await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
const names = (await c.listTools()).tools.map((t) => t.name);
if (!names.includes('notes_add')) throw new Error(`notes_add missing: ${names}`);
await c.callTool({ name: 'notes_add', arguments: { text: 'smoke test note' } });
const r = await c.callTool({ name: 'notes_list', arguments: {} });
const text = r.content[0].text;
if (!text.includes('smoke test note') || !text.includes('me@example.com')) throw new Error(text);
console.log('tools:', names.join(', '));
await c.close();
JS
cp "$WORK/call.mjs" ./call.mjs
node ./call.mjs "http://127.0.0.1:$PORT/mcp" "$KEY"
echo "== ok"
