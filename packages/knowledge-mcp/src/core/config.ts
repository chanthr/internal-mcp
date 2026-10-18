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
 *   3. mcp.config.json   — in the working directory, then in the app root (see paths.ts)
 *   4. (none)            — neutral built-in defaults (server boots; Drive indexing stays off until
 *                          `drive.roots` is set)
 *
 * ⚠️ No secrets here. Never put keys/tokens in this file or the config JSON — those belong in env.
 * This is only "what to look at".
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { candidates } from './paths.js';

/** First line of the server instructions. Each enabled plugin appends its own notes (plugin `instructions`). */
export const BASE_INSTRUCTIONS = 'Knowledge MCP — tools over your team\'s data. Answer only from tool results; do not speculate.';

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

const UpstreamConfigSchema = z
  .object({
    /** Permission group and log name. Lowercase letters, digits and dashes. */
    name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    /** Streamable HTTP endpoint, e.g. https://mcp.example.com/mcp */
    url: z.string().url(),
    /** Tool name prefix. Default "<name>_" with dashes turned into underscores. */
    prefix: z.string().regex(/^[a-z][a-z0-9_]*_$/).optional(),
    /** Name of the env var holding the bearer token (the token itself never goes in this file). */
    tokenEnv: z.string().optional(),
    /** Extra request headers (no secrets — use tokenEnv). */
    headers: z.record(z.string()).optional(),
    /** "read" (default): only read-verb tools. "all": everything. Or an explicit list of remote tool names. */
    expose: z.union([z.enum(['read', 'all']), z.array(z.string())]).default('read'),
  })
  .strict();

const ConfigSchema = z
  .object({
    /** Organization identifier — flows into the auth context as org_id. */
    orgId: z.string().default('org'),
    branding: z
      .object({
        name: z.string().default('Knowledge MCP'),
        /** Replaces the generated instructions (base line + each enabled plugin's notes) when set. */
        instructions: z.string().optional(),
      })
      .default({}),
    drive: z
      .object({
        /** SSOT for index/search scope. Empty = Drive indexing disabled (tools still gated by credentials). */
        roots: z.array(DriveRootSchema).default([]),
        /** Folder names to exclude from the search index (sensitive/backup). Merged with built-in dev-artifact names (node_modules etc.). */
        excludeFolders: z.array(z.string()).default([]),
        /**
         * Top-level folders (under a "biz" root) that hold one subfolder per customer: Clients/Acme/... → customer "Acme".
         * Matched case-insensitively, ignoring a leading "01_" style number. Powers the semantic_search_drive `customer` filter.
         */
        customerFolders: z.array(z.string()).default(['Clients', 'Customers', '고객사']),
        /**
         * Optional ranking rules for semantic_search_drive: results whose path starts with `prefix` are labelled and
         * their score multiplied by `weight` (e.g. prefer "Current/" over "Archive/"). First match wins. Default: none.
         */
        rank: z
          .array(z.object({ prefix: z.string().min(1), label: z.string().min(1), weight: z.number().positive().max(10) }).strict())
          .default([]),
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
        /**
         * Google Workspace domains allowed to sign in (the account's `hd` claim must match).
         * env OAUTH_ALLOWED_HD (comma-separated) takes precedence.
         */
        allowedDomains: z.array(z.string()).default([]),
        /**
         * Individual emails allowed to sign in, in addition to the domains (any Google account type).
         * env OAUTH_ALLOWED_EMAILS (comma-separated) takes precedence.
         * If both lists are empty, OAuth stays off — otherwise any Google account could sign in.
         */
        allowedEmails: z.array(z.string()).default([]),
      })
      .default({}),
    access: z
      .object({
        /**
         * Tool groups a signed-in user WITHOUT an app_users row may use (role "viewer").
         * A group is a plugin id (drive, slack, github, railway, or your own) or a config upstream name.
         * Default: none, so unregistered users only get `ping`.
         */
        viewerTools: z.array(z.string()).default([]),
      })
      .default({}),
    /** Per-plugin settings: `plugins.<id>` is passed to that plugin as ctx.config. */
    plugins: z.record(z.unknown()).default({}),
    /** Remote MCP servers to proxy. Their tools are listed as `<prefix><name>` in the group `name`. */
    upstreams: z.array(UpstreamConfigSchema).default([]),
  })
  .strict();

export type AppConfig = z.infer<typeof ConfigSchema>;
export type DriveRoot = z.infer<typeof DriveRootSchema>;
export type UpstreamConfig = z.infer<typeof UpstreamConfigSchema>;

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
  if (explicitPath) {
    try {
      const raw = readFileSync(explicitPath, 'utf8');
      _source = `file:${explicitPath}`;
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`[config] failed to read MCP_CONFIG_PATH (${explicitPath}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Default locations may simply not exist → built-in defaults. A file that exists but is broken fails fast.
  const path = candidates('mcp.config.json').find((p) => existsSync(p));
  if (!path) return null;
  try {
    _source = `file:${path}`;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`[config] failed to parse ${path}: ${e instanceof Error ? e.message : String(e)}`);
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
