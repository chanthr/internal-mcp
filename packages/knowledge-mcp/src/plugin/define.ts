/**
 * Plugin API — the only thing you need to add tools to Knowledge MCP.
 *
 * A plugin is one connector (Drive, Slack, your internal API, ...). Its `id` is also its permission group:
 * admins see every plugin, members see the groups in their allowed_tools (all when unset), and viewers see
 * only the groups listed in config `access.viewerTools`.
 *
 *   export default definePlugin({
 *     id: 'weather',
 *     env: ['WEATHER_API_KEY'],            // tools stay hidden until every name here is set
 *     tools: [
 *       defineTool({
 *         name: 'weather_now',
 *         description: 'Current weather for a city',
 *         input: z.object({ city: z.string().describe('City name') }),
 *         run: async ({ city }) => fetchWeather(city),   // return a string, any JSON value, or an MCP result
 *       }),
 *     ],
 *   });
 *
 * The core lists the tools, validates input against the zod schema (zod 3 or 4), checks the caller's
 * permission, logs the call, and turns return values and thrown errors into MCP results.
 */
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { AnySchema, SchemaOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { AuthContext, Role } from '../core/auth.js';

export const PLUGIN_BRAND = Symbol.for('knowledge-mcp.plugin');
const TOOL_BRAND = Symbol.for('knowledge-mcp.tool');

/** MCP tool result. Returned as is when a tool returns an object with a `content` array. */
export type ToolResult = {
  content: Array<{ type: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
};

/** What `run` may return: text, any JSON-serializable value (sent as pretty JSON), or a full MCP result. */
export type ToolReturn = string | ToolResult | Record<string, unknown> | unknown[] | number | boolean | null | undefined;

/** Small key-value storage, kept per plugin in the server's store (SQLite file or Supabase). */
export interface PluginState {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ToolContext {
  /** The caller. `role` is admin, member or viewer. */
  user: { email?: string; role: Role; keyId?: string };
  /** Full auth context (scopes for Slack channels and Drive folders, act-as flag). */
  auth: AuthContext;
  /** This plugin's section of the config file (`plugins.<id>`), validated by `configSchema` when given. */
  config: unknown;
  /** Persistent key-value storage for this plugin. */
  state: PluginState;
  /** Log to stderr with the plugin prefix. Secrets are masked. Never use console.log in stdio mode. */
  log: (...args: unknown[]) => void;
}

export interface ToolSpec<S extends AnySchema = AnySchema> {
  /** Tool name shown to the model. Lowercase letters, digits and underscores; unique across all plugins. */
  name: string;
  /** What the tool does and when to use it. The model reads this to pick the tool. */
  description: string;
  /** zod object schema for the arguments. Describe each field with `.describe()`. Omit for no arguments. */
  input?: S;
  /** MCP tool hints (readOnlyHint, destructiveHint, ...). */
  annotations?: ToolAnnotations;
  /** Extra condition on top of the plugin's. Return true, or a short reason why the tool is off. */
  enabled?: () => boolean | string;
  run: (input: SchemaOutput<S>, ctx: ToolContext) => Promise<ToolReturn> | ToolReturn;
}

/** A remote MCP server whose tools are re-exposed under a name prefix (the server is a gateway). */
export interface UpstreamSpec {
  /** Name for logs. */
  name: string;
  /** Streamable HTTP endpoint of the remote MCP server. */
  url: string;
  /** Prefix added to every remote tool name, e.g. "github_" turns get_me into github_get_me. */
  prefix: string;
  /** Bearer token sent to the remote server. A function is read at connect time. */
  token?: string | (() => string | undefined);
  headers?: Record<string, string>;
  /**
   * Which remote tools to expose. "read" (default) keeps tools whose first word is a read verb
   * (get, list, search, ...) and blocks the rest. "all" exposes everything. A list exposes exactly
   * those remote names (without the prefix).
   */
  expose?: 'read' | 'all' | string[];
}

/** A CLI subcommand: `knowledge-mcp <plugin id> <command> [args]`. */
export interface PluginCommand {
  description: string;
  run: (args: string[]) => Promise<void> | void;
}

export interface PluginSpec {
  /** Permission group and config key. Lowercase letters, digits and dashes. */
  id: string;
  /** One line shown by `knowledge-mcp doctor`. */
  description?: string;
  /** Env vars that must all be set (non-empty) for the plugin to turn on. */
  env?: string[];
  /** Extra condition, checked after `env`. Return true, or a short reason why the plugin is off. */
  enabled?: () => boolean | string;
  tools?: ToolSpec<any>[];
  /** Remote MCP servers to proxy. Their tools join this plugin's permission group. */
  upstreams?: UpstreamSpec[] | (() => UpstreamSpec[]);
  /** Usage notes appended to the server instructions the client receives. */
  instructions?: string;
  /** zod schema for `plugins.<id>` in the config file. */
  configSchema?: AnySchema;
  /**
   * Runs once after the HTTP server is listening (background jobs, warm-up). Errors are logged, not fatal.
   * Not run in stdio mode, where each client session is its own process.
   */
  start?: (ctx: { config: unknown; state: PluginState; log: (...args: unknown[]) => void }) => Promise<void> | void;
  /** Extra CLI commands. */
  commands?: Record<string, PluginCommand>;
}

export type Plugin = PluginSpec & { readonly [PLUGIN_BRAND]: true };
export type Tool<S extends AnySchema = AnySchema> = ToolSpec<S> & { readonly [TOOL_BRAND]: true };

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Define a tool. Gives `run` a typed `input` from the zod schema. */
export function defineTool<S extends AnySchema = AnySchema>(spec: ToolSpec<S>): Tool<S> {
  if (!TOOL_NAME_RE.test(spec.name)) {
    throw new Error(`[plugin] invalid tool name "${spec.name}": use lowercase letters, digits and underscores (max 64)`);
  }
  if (!spec.description?.trim()) throw new Error(`[plugin] tool "${spec.name}" needs a description`);
  if (typeof spec.run !== 'function') throw new Error(`[plugin] tool "${spec.name}" needs a run function`);
  return Object.assign({}, spec, { [TOOL_BRAND]: true as const });
}

/** Define a plugin. Validates the shape early so mistakes fail at boot with a clear message. */
export function definePlugin(spec: PluginSpec): Plugin {
  if (!PLUGIN_ID_RE.test(spec.id)) {
    throw new Error(`[plugin] invalid plugin id "${spec.id}": use lowercase letters, digits and dashes (max 32)`);
  }
  const names = new Set<string>();
  for (const t of spec.tools ?? []) {
    if (!(t as Partial<Tool>)[TOOL_BRAND]) defineTool(t); // validates plain objects too
    if (names.has(t.name)) throw new Error(`[plugin] ${spec.id}: duplicate tool name "${t.name}"`);
    names.add(t.name);
  }
  return Object.assign({}, spec, { [PLUGIN_BRAND]: true as const });
}

export function isPlugin(v: unknown): v is Plugin {
  return !!v && typeof v === 'object' && (v as Record<symbol, unknown>)[PLUGIN_BRAND] === true;
}

/**
 * Throw this from `run` for an expected failure (not found, bad state, missing permission).
 * The model receives `[error] <message>` and the call is logged as failed.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
