/**
 * Config for turning your own data into tools without writing code.
 *
 *   connections   named places data lives: a Postgres database, a SQLite file, an HTTP API
 *   tools         what the model may ask of them: one SQL query or one API request each, with typed parameters
 *
 * A connection's name is also its permission group, like a plugin id: a person allowed "shop" may call the tools
 * declared on the connection "shop".
 *
 * No secrets here. A database URL or an API token is named, not written: `urlEnv` holds the NAME of an env var,
 * and header or query values may contain `${ENV_NAME}`, filled in from the environment at call time.
 *
 * A mistake in a tool (a parameter the query does not use, a second statement, an unknown connection) stops the
 * server at boot with the tool's name in the message. A problem outside this file (the database is down, a table
 * does not exist) is reported by `knowledge-mcp setup check` and when the tool is called.
 */
import { z } from 'zod';
import { parseSql, sqlProblem } from './sql.js';

const CONNECTION_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const DEFAULT_MAX_ROWS = 100;
export const DEFAULT_SQL_TIMEOUT_MS = 10_000;
export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
export const DEFAULT_HTTP_MAX_BYTES = 1_000_000;

const maxRows = z.number().int().min(1).max(5000).optional();
const timeoutMs = z.number().int().min(100).max(120_000).optional();
const description = z.string().max(500).optional();

export const ParamSchema = z
  .object({
    type: z.enum(['string', 'integer', 'number', 'boolean']),
    /** Shown to the model. Say what the value is and give an example. */
    description: z.string().max(500).optional(),
    /** Default true. A parameter with a `default` is optional. */
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    /** Allowed values (strings only). */
    enum: z.array(z.string().min(1)).min(1).max(200).optional(),
    /** Bounds for integer and number. */
    min: z.number().optional(),
    max: z.number().optional(),
    /** Longest string accepted. Default 2000. */
    maxLength: z.number().int().positive().max(100_000).optional(),
    /** A regular expression a string must match (unanchored: add ^ and $ to match the whole value). */
    pattern: z.string().max(500).optional(),
  })
  .strict();
export type ParamSpec = z.infer<typeof ParamSchema>;

const PostgresConnectionSchema = z
  .object({
    type: z.literal('postgres'),
    /** NAME of the env var that holds the connection string (postgres://user:password@host:5432/db). */
    urlEnv: z.string().regex(ENV_NAME),
    description,
    /** Also offer `<name>_tables` and `<name>_query`: the model may run any read-only query. Default false. */
    explore: z.boolean().default(false),
    maxRows,
    timeoutMs,
    /** Connections kept open at most. Default 3. */
    pool: z.number().int().min(1).max(10).default(3),
  })
  .strict();

const SqliteConnectionSchema = z
  .object({
    type: z.literal('sqlite'),
    /** Path of the database file, absolute or relative to the project folder. */
    path: z.string().min(1),
    description,
    explore: z.boolean().default(false),
    maxRows,
    timeoutMs,
  })
  .strict();

const HttpConnectionSchema = z
  .object({
    type: z.literal('http'),
    /** Every request of this connection goes under this URL. */
    baseUrl: z.string().regex(/^https?:\/\/[^\s]+$/i, 'must start with http:// or https://'),
    /** Sent with every request. A value may contain ${ENV_NAME}. */
    headers: z.record(z.string(), z.string()).default({}),
    /** Query parameters sent with every request (an API key in the URL). A value may contain ${ENV_NAME}. */
    query: z.record(z.string(), z.string()).default({}),
    description,
    timeoutMs,
    /** Largest response read, in bytes. Default 1,000,000. */
    maxBytes: z.number().int().min(1000).max(20_000_000).optional(),
  })
  .strict();

export const ConnectionSchema = z.discriminatedUnion('type', [PostgresConnectionSchema, SqliteConnectionSchema, HttpConnectionSchema]);
export type ConnectionConfig = z.infer<typeof ConnectionSchema>;
export type PostgresConnection = z.infer<typeof PostgresConnectionSchema>;
export type SqliteConnection = z.infer<typeof SqliteConnectionSchema>;
export type HttpConnection = z.infer<typeof HttpConnectionSchema>;

const RequestSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    /** Path under the connection's baseUrl. `{name}` is replaced by a parameter, URL-encoded. */
    path: z.string().regex(/^\/[^\s?#]*$/, 'must start with "/" and hold no query string (use `query`)'),
    /** Query parameters. A value that is exactly `{name}` is left out when that optional parameter is absent. A value may contain ${ENV_NAME}. */
    query: z.record(z.string(), z.string()).optional(),
    /** Extra headers for this request. A value may contain ${ENV_NAME}. */
    headers: z.record(z.string(), z.string()).optional(),
    /** JSON body. A string that is exactly `{name}` becomes the parameter's value with its type. */
    body: z.unknown().optional(),
    /** Keep only this part of a JSON response: a dot path such as "data.items". */
    pick: z.string().regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/).optional(),
  })
  .strict();
export type RequestSpec = z.infer<typeof RequestSchema>;

export const DataToolSchema = z
  .object({
    /** Tool name shown to the model. Lowercase letters, digits and underscores. */
    name: z.string().regex(TOOL_NAME),
    /** The connection it runs on. */
    connection: z.string().regex(CONNECTION_NAME),
    /** What the tool answers and when to use it. The model picks tools by this text. */
    description: z.string().min(1).max(2000),
    params: z.record(z.string().regex(PARAM_NAME), ParamSchema).default({}),
    /** For a postgres or sqlite connection: one statement, with :name where a parameter goes. */
    sql: z.string().min(1).max(20_000).optional(),
    /** For an http connection. */
    request: RequestSchema.optional(),
    /**
     * Does the tool only read? SQL: default true, and the database is asked to refuse writes. HTTP: default true
     * for GET; any other method has to say true or false, because a POST can be a search or a change.
     */
    readOnly: z.boolean().optional(),
    maxRows,
    timeoutMs,
  })
  .strict();
export type DataToolConfig = z.infer<typeof DataToolSchema>;

export const ConnectionsSchema = z.record(z.string().regex(CONNECTION_NAME), ConnectionSchema).default({});
export const DataToolsSchema = z.array(DataToolSchema).default([]);

/** `{name}` placeholders in a template string. `${NAME}` is an env reference, not a placeholder. */
export function placeholders(text: string): string[] {
  return [...text.matchAll(/(?<!\$)\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
}

/** `${NAME}` env references in a string. */
export function envRefs(text: string): string[] {
  return [...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
}

/** Every string inside a JSON-like value. */
export function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

/** Names of the tools a connection with `explore` adds. */
export function exploreToolNames(connection: string): { tables: string; query: string } {
  const base = connection.replace(/-/g, '_');
  return { tables: `${base}_tables`, query: `${base}_query` };
}

/** Is a parameter optional (may be absent in a call)? */
export const isOptional = (p: ParamSpec): boolean => p.required === false || p.default !== undefined;

/** Does the tool only read? See DataToolSchema.readOnly. */
export function toolReadOnly(tool: DataToolConfig): boolean {
  if (tool.readOnly !== undefined) return tool.readOnly;
  return true; // SQL, and GET (other methods are required to say; see dataConfigProblems)
}

function paramProblems(name: string, p: ParamSpec): string[] {
  const out: string[] = [];
  const numeric = p.type === 'integer' || p.type === 'number';
  if (p.enum && p.type !== 'string') out.push(`param ${name}: enum is for strings`);
  if ((p.min !== undefined || p.max !== undefined) && !numeric) out.push(`param ${name}: min and max are for integer and number`);
  if (p.min !== undefined && p.max !== undefined && p.min > p.max) out.push(`param ${name}: min is larger than max`);
  if ((p.maxLength !== undefined || p.pattern !== undefined) && p.type !== 'string') out.push(`param ${name}: maxLength and pattern are for strings`);
  if (p.pattern !== undefined) {
    try {
      new RegExp(p.pattern);
    } catch {
      out.push(`param ${name}: pattern is not a valid regular expression`);
    }
  }
  if (p.default !== undefined) {
    const ok =
      (p.type === 'string' && typeof p.default === 'string' && (!p.enum || p.enum.includes(p.default))) ||
      (p.type === 'boolean' && typeof p.default === 'boolean') ||
      (p.type === 'number' && typeof p.default === 'number') ||
      (p.type === 'integer' && typeof p.default === 'number' && Number.isInteger(p.default));
    if (!ok) out.push(`param ${name}: default does not match the type${p.enum ? ' or the enum' : ''}`);
    if (numeric && typeof p.default === 'number' && ((p.min !== undefined && p.default < p.min) || (p.max !== undefined && p.default > p.max))) {
      out.push(`param ${name}: default is outside min and max`);
    }
  }
  return out;
}

export interface DataConfigProblem {
  path: Array<string | number>;
  message: string;
}

/** Everything wrong with `connections` and `tools` that can be told without touching a database or an API. */
export function dataConfigProblems(connections: Record<string, ConnectionConfig>, tools: DataToolConfig[]): DataConfigProblem[] {
  const out: DataConfigProblem[] = [];
  const add = (path: Array<string | number>, message: string) => out.push({ path, message });

  const taken = new Map<string, string>(); // tool name → who defines it
  for (const [name, c] of Object.entries(connections)) {
    if (c.type === 'http') {
      try {
        const u = new URL(c.baseUrl);
        if (u.search || u.hash) add(['connections', name, 'baseUrl'], 'must not hold a query string or a fragment (use `query`)');
        if (u.username || u.password) add(['connections', name, 'baseUrl'], 'must not hold a user name or password (use a header with ${ENV_NAME})');
      } catch {
        add(['connections', name, 'baseUrl'], 'is not a valid URL');
      }
    } else if (c.explore) {
      const t = exploreToolNames(name);
      for (const n of [t.tables, t.query]) taken.set(n, `connection "${name}" (explore)`);
    }
  }

  tools.forEach((tool, i) => {
    const at = (...p: Array<string | number>) => ['tools', i, ...p];
    const label = `tool "${tool.name}"`;
    const other = taken.get(tool.name);
    if (other) add(at('name'), `${label} is already defined by ${other}`);
    else taken.set(tool.name, label);

    for (const [pn, p] of Object.entries(tool.params)) for (const m of paramProblems(pn, p)) add(at('params', pn), `${label}: ${m}`);

    const c = connections[tool.connection];
    if (!c) {
      add(at('connection'), `${label}: there is no connection named "${tool.connection}"`);
      return;
    }
    const declared = new Set(Object.keys(tool.params));
    const used = new Set<string>();

    if (c.type === 'http') {
      if (tool.sql) add(at('sql'), `${label}: "${tool.connection}" is an http connection, so the tool needs \`request\`, not \`sql\``);
      const r = tool.request;
      if (!r) {
        add(at('request'), `${label}: an http connection needs \`request\``);
        return;
      }
      if (r.method !== 'GET' && tool.readOnly === undefined) {
        add(at('readOnly'), `${label}: a ${r.method} request must say "readOnly": true (it only reads) or false (it changes something)`);
      }
      for (const n of placeholders(r.path)) {
        used.add(n);
        const p = tool.params[n];
        if (p && p.required === false && p.default === undefined) add(at('request', 'path'), `${label}: {${n}} is in the path, so the parameter cannot be optional`);
      }
      for (const s of [...Object.values(r.query ?? {}), ...Object.values(r.headers ?? {}), ...stringsIn(r.body)]) for (const n of placeholders(s)) used.add(n);
      for (const s of stringsIn(r.body)) if (envRefs(s).length) add(at('request', 'body'), `${label}: \${ENV_NAME} is allowed in headers and query values, not in the body`);
      if (envRefs(r.path).length) add(at('request', 'path'), `${label}: \${ENV_NAME} is not allowed in the path`);
    } else {
      if (tool.request) add(at('request'), `${label}: "${tool.connection}" is a ${c.type} connection, so the tool needs \`sql\`, not \`request\``);
      if (!tool.sql) {
        add(at('sql'), `${label}: a ${c.type} connection needs \`sql\``);
        return;
      }
      const parsed = parseSql(tool.sql, c.type);
      const problem = sqlProblem(parsed, toolReadOnly(tool));
      if (problem) add(at('sql'), `${label}: ${problem}${toolReadOnly(tool) && parsed.statements === 1 ? ' (set "readOnly": false if this tool is meant to change data)' : ''}`);
      for (const n of parsed.names) used.add(n);
    }

    for (const n of used) if (!declared.has(n)) add(at('params'), `${label}: uses ${c.type === 'http' ? `{${n}}` : `:${n}`} but \`params\` has no "${n}"`);
    for (const n of declared) if (!used.has(n)) add(at('params', n), `${label}: the parameter "${n}" is declared but never used`);
  });

  return out;
}
