/**
 * Side effects that must run before any other module of the package is evaluated.
 * index.ts imports this first: ESM evaluates imports in order, and several modules read process.env
 * when they load, so .env has to be in place before them.
 *
 *   1. Load .env — MCP_ENV_FILE if set, else ./.env and <app root>/.env. Existing env vars win.
 *      A named file that does not exist stops the process: running on the wrong settings is worse.
 *      MCP_ENV_FILE=none loads no file at all.
 *   2. Mask secrets in every console.* line.
 */
import { existsSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { candidates } from './core/paths.js';
import { installLogMasking } from './core/log_mask.js';

const explicit = process.env.MCP_ENV_FILE?.trim();
if (explicit && explicit !== 'none' && !existsSync(explicit)) {
  console.error(`[knowledge-mcp] MCP_ENV_FILE points to a file that does not exist: ${explicit}`);
  process.exit(1);
}
const files = explicit === 'none' ? [] : explicit ? [explicit] : candidates('.env').filter((f) => existsSync(f));
for (const path of files) loadDotenv({ path, quiet: true });

installLogMasking();
