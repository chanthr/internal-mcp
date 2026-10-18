#!/usr/bin/env bash
# What a user sees when installing: pack the core, scaffold a project with the generator, install it with an
# empty npm config and cache (no login, nothing cached), and fail on any deprecation warning or audit finding.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export NPM_CONFIG_USERCONFIG="$WORK/empty-npmrc" NPM_CONFIG_CACHE="$WORK/cache"
: > "$NPM_CONFIG_USERCONFIG"

npm run build -w @chnxthr/knowledge-mcp
(cd "$ROOT/packages/knowledge-mcp" && npm pack --silent --ignore-scripts --pack-destination "$WORK" >/dev/null)
TGZ="$(ls "$WORK"/chnxthr-knowledge-mcp-*.tgz)"

(cd "$WORK" && KMCP_CORE_SPEC="file:$TGZ" node "$ROOT/packages/create-knowledge-mcp/index.js" app --no-install --no-git >/dev/null)
cd "$WORK/app"
npm install --no-fund > "$WORK/install.log" 2>&1 || { cat "$WORK/install.log"; exit 1; }
cat "$WORK/install.log"

status=0
if grep -i "deprecated" "$WORK/install.log"; then echo "::error::install printed deprecation warnings" >&2; status=1; fi
if ! npm audit; then echo "::error::npm audit found vulnerabilities" >&2; status=1; fi
echo "packages installed: $(npm ls --all --parseable 2>/dev/null | wc -l | tr -d ' ')"
exit $status
