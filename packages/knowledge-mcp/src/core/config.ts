/**
 * Deployment configuration — "what to look at" is kept out of the code.
 *
 * Credentials live in env (Supabase / Qdrant / Drive / Slack / GitHub keys, database URLs, API tokens). This module
 * holds the rest: which Drive folders, which Qdrant collection, which Supabase schema, which domains, which queries. That
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
import { dirname } from 'node:path';
import { z } from 'zod';
import { candidates, home } from './paths.js';
import { ConnectionsSchema, DataToolsSchema, dataConfigProblems } from '../connections/schema.js';

/** First line of the server instructions. Each enabled plugin appends its own notes (plugin `instructions`). */
export const BASE_INSTRUCTIONS = 'Knowledge MCP — tools over your team\'s data. Answer only from tool results; do not speculate.';

/**
 * A Drive folder to index.
 *   - `source` is a label of your choice ("handbook", "sales", "wiki", …). It is stored with every chunk and is the
 *     `source` filter of search_knowledge. Default "docs".
 *   - `metadata` says where document metadata comes from: "frontmatter" (Markdown with a YAML header: status, tags,
 *     type, date) or "path" (category, customer and tags derived from folder and file names — for PDFs, Office and
 *     Google files). Default "path". The label "dev" defaults to "frontmatter" so configs written for 0.3 keep working.
 */
const SOURCE_LABEL = /^[a-z][a-z0-9_-]{0,31}$/;
const DriveRootSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  source: z.string().regex(SOURCE_LABEL).default('docs'),
  metadata: z.enum(['frontmatter', 'path']).optional(),
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
    /**
     * true: the server was signed in to from the console, and the gateway uses that sign-in
     * (<data dir>/mcp-logins/<name>.json), renewing it by itself. Not together with tokenEnv.
     */
    signIn: z.boolean().optional(),
    /** Extra request headers (no secrets — use tokenEnv). */
    headers: z.record(z.string(), z.string()).optional(),
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
      .prefault({}),
    drive: z
      .object({
        /** SSOT for index/search scope. Empty = Drive indexing disabled (tools still gated by credentials). */
        roots: z.array(DriveRootSchema).default([]),
        /**
         * Which Drive documents the tools and the index cover.
         *   - "shared" (default): everything shared with the service account. That is the roots plus any file or
         *     folder shared with it separately. Sharing a document with the account is all it takes to make it searchable.
         *   - "roots": only files under `roots` (the behaviour up to 0.3.x).
         * Excluded folders stay hidden either way. env DRIVE_SCOPE takes precedence.
         */
        scope: z.enum(['shared', 'roots']).default('shared'),
        /**
         * Whose documents count when they are shared with the service account outside the roots.
         * Anyone who learns the account's address can share a document with it, and a shared document shows up in
         * every user's search results. So with drive.scope "shared" only documents whose top shared item is owned
         * by one of these are shown and indexed. Entries: an email ("ann@acme.com"), a domain ("acme.com"), a
         * shared drive ("drive:<id>"), or "*" for everyone (not recommended). Empty: nothing outside the roots.
         * env DRIVE_TRUSTED_OWNERS (comma-separated) takes precedence. `knowledge-mcp setup` fills this in.
         */
        trustedOwners: z.array(z.string()).default([]),
        /** `source` label for documents shared outside the roots (drive.scope "shared"). */
        sharedSource: z.string().regex(SOURCE_LABEL).default('shared'),
        /** Folder names to exclude from the search index, in Drive and in local folders (sensitive/backup). Merged with built-in dev-artifact names (node_modules etc.). */
        excludeFolders: z.array(z.string()).default([]),
        /**
         * Top-level folders (under a "biz" root) that hold one subfolder per customer: Clients/Acme/... → customer "Acme".
         * Matched case-insensitively, ignoring a leading "01_" style number. Powers the search_knowledge `customer` filter.
         */
        customerFolders: z.array(z.string()).default(['Clients', 'Customers', '고객사']),
        /**
         * Optional ranking rules for search_knowledge: results whose path starts with `prefix` are labelled and
         * their score multiplied by `weight` (e.g. prefer "Current/" over "Archive/"). First match wins. Default: none.
         */
        rank: z
          .array(z.object({ prefix: z.string().min(1), label: z.string().min(1), weight: z.number().positive().max(10) }).strict())
          .default([]),
      })
      .prefault({}),
    /**
     * Local folders to index and search (the `knowledge` plugin): Markdown, text, PDF, Word, PowerPoint and Excel
     * files under each path, subfolders included. `name` is how the folder appears in results and in document ids
     * (default: the folder's own name). `source` is the label for the `source` search filter (default "files").
     * A relative path is resolved against the project folder. env KNOWLEDGE_FOLDERS (comma-separated paths) adds more.
     */
    /**
     * `knowledge.index`: how documents are cut into passages and what the embedding model is given
     * (plugins/drive/index_profile.ts). Everything is optional: left out, documents are cut at headings into
     * passages of up to 800 tokens, and an embedding model known to need a prefix gets it.
     */
    knowledge: z
      .object({
        index: z
          .object({
            cut: z.enum(['sections', 'windows']).optional(),
            maxTokens: z.number().int().min(100).max(4000).optional(),
            minTokens: z.number().int().min(0).max(500).optional(),
            overlapTokens: z.number().int().min(0).max(1000).optional(),
            header: z.enum(['heading', 'document', 'none']).optional(),
            queryPrefix: z.string().max(500).optional(),
            passagePrefix: z.string().max(500).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    folders: z
      .array(
        z
          .object({
            path: z.string().min(1),
            name: z.string().regex(/^[^/\\]{1,64}$/).optional(),
            source: z.string().regex(SOURCE_LABEL).optional(),
          })
          .strict(),
      )
      .default([]),
    qdrant: z
      .object({
        /** Vector collection name. If env QDRANT_COLLECTION is set, it takes precedence (zero-downtime swap). */
        collection: z.string().default('knowledge_v1'),
      })
      .prefault({}),
    data: z
      .object({
        /** Supabase schema holding the server's own tables (oauth clients, refresh tokens, sync_state, tool_calls, app_users). */
        schema: z.string().default('public'),
      })
      .prefault({}),
    /** Unused. Still accepted so config files written for 0.3.0 and 0.3.1 keep loading (the schema is strict). */
    selfDomains: z.array(z.string()).optional(),
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
      .prefault({}),
    access: z
      .object({
        /**
         * Tool groups a signed-in user WITHOUT an app_users row may use (role "viewer").
         * A group is a plugin id (drive, slack, github, railway, or your own) or a config upstream name.
         * Default: none, so unregistered users only get `ping`.
         */
        viewerTools: z.array(z.string()).default([]),
      })
      .prefault({}),
    /** Per-plugin settings: `plugins.<id>` is passed to that plugin as ctx.config. */
    plugins: z.record(z.string(), z.unknown()).default({}),
    /** Remote MCP servers to proxy. Their tools are listed as `<prefix><name>` in the group `name`. */
    upstreams: z.array(UpstreamConfigSchema).default([]),
    /**
     * Your own data as tools, without a plugin file (see connections/schema.ts). `connections` names a Postgres database, a
     * SQLite file or an HTTP API; the name is the permission group. `tools` declares one SQL query or one API
     * request each. Secrets stay in env: a connection names the env var that holds them.
     */
    connections: ConnectionsSchema,
    tools: DataToolsSchema,
  })
  .strict()
  .superRefine((cfg, ctx) => {
    for (const p of dataConfigProblems(cfg.connections, cfg.tools)) ctx.addIssue({ code: 'custom', path: p.path, message: p.message });
  });

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
/** Folder that holds .env and mcp.config.json: where the loaded config file is, else the home folder or the working directory. */
export function settingsDir(): string {
  const source = configSource();
  return source.startsWith('file:') ? dirname(source.slice(5)) : (home() ?? process.cwd());
}

export function configSource(): string {
  return _source;
}
