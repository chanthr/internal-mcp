/**
 * Deployment configuration — "what to look at" is kept out of the code.
 *
 * Credentials live in env (Supabase / Qdrant / Drive / Slack / GitHub keys). This module holds the
 * rest: which Drive folders, which Qdrant collection, which Supabase schema, which domains. That
 * lets anyone self-host by supplying their own config file — no code changes.
 *
 * Resolution order (first match wins):
 *   1. MCP_CONFIG_JSON   — inline JSON (deploy-friendly: one env var, no file)
 *   2. MCP_CONFIG_PATH   — explicit path to a JSON file
 *   3. ./mcp.config.json — file in the working directory
 *   4. (none)            — neutral built-in defaults (server boots; Drive indexing stays off until
 *                          `drive.roots` is set)
 *
 * ⚠️ No secrets here. Never put keys/tokens in this file or the config JSON — those belong in env.
 * This is only "what to look at".
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Default server instructions shown to the connecting client (Claude etc.) when branding is unset. */
const DEFAULT_INSTRUCTIONS = `Knowledge MCP — access Drive, Slack, GitHub and Railway data.

Tool routing:
- Meaning/concept search ("how does X work") -> semantic_search_drive. Keyword/filename -> search_drive.
- Exhaustive listing (roster, "list all") -> list_drive_folder(folderName).
- If a chunk lacks context, call read_drive_file with the File ID from the result (pass fileIds=[...] to read several at once).
- Latest discussion -> slack_search / slack_read_channel. Code structure -> repo_tree. Infra -> railway_*.

Principle: answer only from results; do not speculate.`;

/**
 * A Drive folder to index. `source` is an indexing hint:
 *   - "dev": structured knowledge docs (Markdown with frontmatter)
 *   - "biz": general documents (PDF/DOCX/etc.)
 * If you have one kind of content, just use "dev" for everything.
 */
const DriveRootSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  source: z.enum(['dev', 'biz']),
});

const ConfigSchema = z
  .object({
    /** Organization identifier — flows into the auth context as org_id. */
    orgId: z.string().default('org'),
    branding: z
      .object({
        name: z.string().default('Knowledge MCP'),
        instructions: z.string().default(DEFAULT_INSTRUCTIONS),
      })
      .default({}),
    drive: z
      .object({
        /** SSOT for index/search scope. Empty = Drive indexing disabled (tools still gated by credentials). */
        roots: z.array(DriveRootSchema).default([]),
        /** Folder names to exclude from the search index (sensitive/backup). Merged with built-in dev-artifact names (node_modules etc.). */
        excludeFolders: z.array(z.string()).default([]),
      })
      .default({}),
    qdrant: z
      .object({
        /** Vector collection name. If env QDRANT_COLLECTION is set, it takes precedence (zero-downtime swap). */
        collection: z.string().default('knowledge_v1'),
      })
      .default({}),
    data: z
      .object({
        /** Supabase schema holding the server's own tables (oauth clients, refresh tokens, sync_state, tool_calls, app_users). */
        schema: z.string().default('public'),
      })
      .default({}),
    /** Your own domains (used e.g. to distinguish first-party from external sources). */
    selfDomains: z.array(z.string()).default([]),
    oauth: z
      .object({
        /** Allowed login domains (hd). The first entry is used as the Google hd hint. env OAUTH_ALLOWED_HD takes precedence. */
        allowedDomains: z.array(z.string()).default([]),
        /** Allowed email allowlist (if set, wins over domains). env OAUTH_ALLOWED_EMAILS takes precedence. */
        allowedEmails: z.array(z.string()).default([]),
      })
      .default({}),
  })
  .strict();

export type AppConfig = z.infer<typeof ConfigSchema>;
export type DriveRoot = z.infer<typeof DriveRootSchema>;

let _source = 'defaults';

/** Load the raw config object, or null if none is provided. Explicit/inline parse failures throw (fail fast). */
function loadRawConfig(): unknown | null {
  const inline = process.env.MCP_CONFIG_JSON;
  if (inline && inline.trim()) {
    try {
      _source = 'env:MCP_CONFIG_JSON';
      return JSON.parse(inline);
    } catch (e) {
      throw new Error(`[config] failed to parse MCP_CONFIG_JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const explicitPath = process.env.MCP_CONFIG_PATH;
  const path = explicitPath || './mcp.config.json';
  try {
    const raw = readFileSync(path, 'utf8');
    _source = explicitPath ? `file:${path}` : 'file:./mcp.config.json';
    return JSON.parse(raw);
  } catch (e) {
    // Explicit path -> surface the failure. Default path may simply not exist -> fall back to defaults.
    if (explicitPath) {
      throw new Error(`[config] failed to read MCP_CONFIG_PATH (${path}): ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  }
}

let _config: AppConfig | null = null;

/** Validated config (singleton). Loads and validates on first call; invalid config fails fast with a clear error. */
export function getConfig(): AppConfig {
  if (_config) return _config;
  const raw = loadRawConfig();
  try {
    _config = ConfigSchema.parse(raw === null ? {} : raw);
  } catch (e) {
    if (e instanceof z.ZodError) {
      const detail = e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      throw new Error(`[config] validation failed — ${detail}`);
    }
    throw e;
  }
  return _config;
}

/** Which config source was chosen (for boot logs / diagnostics). Valid after getConfig(). */
export function configSource(): string {
  return _source;
}
