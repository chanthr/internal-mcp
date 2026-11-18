/**
 * Tools declared in the config file: `connections` (a Postgres database, a SQLite file, an HTTP API) and `tools`
 * (one SQL query or one API request each). No plugin file to write.
 *
 * Every connection becomes a plugin whose id is the connection's name. That makes the name a permission group like
 * any other: per-person tool lists, `access.viewerTools`, the audit log and `doctor` all work unchanged.
 *
 * A database connection with `explore: true` also gets two tools, `<name>_tables` and `<name>_query`, so the model
 * can answer questions nobody wrote a tool for. The query tool runs read-only (the database refuses writes), with a
 * row limit and a time limit. It can read whatever the database role can read: give it a role that sees only what
 * every permitted person may see.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { appRoot } from '../core/paths.js';
import { definePlugin, defineTool, ToolError, type Plugin, type Tool } from '../plugin/define.js';
import type { SqlAdapter, TableInfo } from './adapter.js';
import { tableResult } from './format.js';
import { callHttp, pingHttp } from './http.js';
import { inputSchemaFor } from './params.js';
import { postgresAdapter } from './postgres.js';
import {
  DEFAULT_MAX_ROWS,
  DEFAULT_SQL_TIMEOUT_MS,
  envRefs,
  exploreToolNames,
  toolReadOnly,
  type ConnectionConfig,
  type DataToolConfig,
} from './schema.js';
import { parseSql, sqlProblem } from './sql.js';
import { sqliteAdapter } from './sqlite.js';

type SqlConnection = Exclude<ConnectionConfig, { type: 'http' }>;

const adapters = new Map<string, SqlAdapter>();

/** The adapter of a database connection (made once; a Postgres pool is opened on first use). */
export function sqlAdapterFor(name: string, c: SqlConnection): SqlAdapter {
  let a = adapters.get(name);
  if (!a) {
    a = c.type === 'postgres' ? postgresAdapter({ name, urlEnv: c.urlEnv, pool: c.pool }) : sqliteAdapter({ name, path: c.path });
    adapters.set(name, a);
  }
  return a;
}

/** Close every open database connection (CLI commands call this so the process can end). */
export async function closeDataConnections(): Promise<void> {
  const all = [...adapters.values()];
  adapters.clear();
  await Promise.all(all.map((a) => a.close()));
}

const sqlitePath = (path: string) => (isAbsolute(path) ? path : resolve(appRoot(), path));

/** Env vars a connection and its tools read. The plugin stays off, naming them, until all are set. */
function envOf(c: ConnectionConfig, tools: DataToolConfig[]): string[] {
  if (c.type === 'postgres') return [c.urlEnv];
  if (c.type === 'sqlite') return [];
  const refs = [...Object.values(c.headers), ...Object.values(c.query), ...tools.flatMap((t) => [...Object.values(t.request?.headers ?? {}), ...Object.values(t.request?.query ?? {})])];
  return [...new Set(refs.flatMap(envRefs))];
}

function declaredSqlTool(name: string, c: SqlConnection, t: DataToolConfig): Tool {
  const parsed = parseSql(t.sql!, c.type);
  const readOnly = toolReadOnly(t);
  const maxRows = t.maxRows ?? c.maxRows ?? DEFAULT_MAX_ROWS;
  const timeoutMs = t.timeoutMs ?? c.timeoutMs ?? DEFAULT_SQL_TIMEOUT_MS;
  return defineTool({
    name: t.name,
    description: t.description,
    input: inputSchemaFor(t.params),
    annotations: readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: true },
    run: async (args) => tableResult(await sqlAdapterFor(name, c).query({ sql: parsed, values: args as Record<string, unknown>, readOnly, maxRows, timeoutMs }), maxRows),
  });
}

function declaredHttpTool(name: string, c: Extract<ConnectionConfig, { type: 'http' }>, t: DataToolConfig): Tool {
  const readOnly = toolReadOnly(t);
  return defineTool({
    name: t.name,
    description: t.description,
    input: inputSchemaFor(t.params),
    annotations: readOnly ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: true },
    run: (args) => callHttp({ name, connection: c, request: t.request!, args: args as Record<string, unknown>, timeoutMs: t.timeoutMs }),
  });
}

const MAX_TABLES_SHOWN = 150;

/** Tables as the model reads them: one line per table, columns with their types. */
export function describeTables(tables: TableInfo[], filter?: string): string {
  const f = filter?.trim().toLowerCase();
  const match = f ? tables.filter((t) => t.name.toLowerCase().includes(f) || t.columns.some((c) => c.name.toLowerCase().includes(f))) : tables;
  if (match.length === 0) return f ? `No table or column contains "${filter}". Call again without a filter to see all ${tables.length}.` : 'This connection can read no tables.';
  const shown = match.slice(0, MAX_TABLES_SHOWN);
  const lines = shown.map((t) => {
    const size = t.rows !== undefined ? `, about ${t.rows} rows` : '';
    return `${t.name} (${t.kind}${size}): ${t.columns.map((c) => `${c.name} ${c.type}`).join(', ')}`;
  });
  if (match.length > shown.length) lines.push(`… and ${match.length - shown.length} more. Pass a filter (part of a table or column name) to narrow the list.`);
  return lines.join('\n');
}

function exploreTools(name: string, c: SqlConnection): Tool[] {
  const names = exploreToolNames(name);
  const dialect = c.type === 'postgres' ? 'PostgreSQL' : 'SQLite';
  const limit = c.maxRows ?? DEFAULT_MAX_ROWS;
  const about = c.description ? ` (${c.description})` : '';
  return [
    defineTool({
      name: names.tables,
      description:
        `List the tables and views of the "${name}" database${about} with their columns and types. ` +
        `Call this before ${names.query}: use the real table and column names, never guessed ones.`,
      input: z.object({ filter: z.string().max(100).optional().describe('Optional: part of a table or column name, to narrow a long list') }),
      annotations: { readOnlyHint: true },
      run: async ({ filter }) => describeTables(await sqlAdapterFor(name, c).tables(), filter),
    }),
    defineTool({
      name: names.query,
      description:
        `Run one read-only ${dialect} query on the "${name}" database${about} and get the rows back. ` +
        `Only SELECT (or WITH … SELECT); the database refuses anything that writes. At most ${limit} rows come back, so aggregate ` +
        `(count, sum, group by) in the query rather than fetching rows to count them. Write values into the query; :name parameters are not supported. ` +
        `Call ${names.tables} first for the table and column names.`,
      input: z.object({ sql: z.string().min(1).max(10_000).describe(`One ${dialect} SELECT statement`) }),
      annotations: { readOnlyHint: true },
      run: async ({ sql }) => {
        const parsed = parseSql(sql, c.type);
        const problem = sqlProblem(parsed, true);
        if (problem) throw new ToolError(problem);
        if (parsed.names.length) throw new ToolError(`write the value into the query instead of :${parsed.names[0]} (parameters are not supported here)`);
        try {
          return tableResult(
            await sqlAdapterFor(name, c).query({ sql: parsed, values: {}, readOnly: true, untrusted: true, maxRows: limit, timeoutMs: c.timeoutMs ?? DEFAULT_SQL_TIMEOUT_MS }),
            limit,
          );
        } catch (e) {
          // A name the database does not know is the usual mistake of a query written from memory.
          if (e instanceof ToolError && /no such (table|column)|does not exist|unknown column/i.test(e.message)) throw new ToolError(`${e.message}. Call ${names.tables} for the real table and column names.`);
          throw e;
        }
      },
    }),
  ];
}

export interface CheckLine {
  ok: boolean;
  /** "shop" or "shop › orders_by_customer". */
  what: string;
  text: string;
}

/**
 * Check one connection against the real thing: can it be reached, and does every declared query compile there
 * (unknown tables and columns, syntax errors)? Nothing is executed and nothing is written.
 */
export async function checkConnection(name: string, c: ConnectionConfig, tools: DataToolConfig[], env: NodeJS.ProcessEnv = process.env): Promise<CheckLine[]> {
  const mine = tools.filter((t) => t.connection === name);
  const missing = envOf(c, mine).filter((n) => !env[n]?.trim());
  if (missing.length) return [{ ok: false, what: name, text: `set ${missing.join(', ')} in .env (the ${c.type} connection reads ${missing.length === 1 ? 'it' : 'them'})` }];
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const out: CheckLine[] = [];
  if (c.type === 'http') {
    try {
      out.push({ ok: true, what: name, text: `${await pingHttp(name, c, env)}, ${mine.length} tool${mine.length === 1 ? '' : 's'}` });
    } catch (e) {
      out.push({ ok: false, what: name, text: msg(e) });
    }
    return out;
  }
  const adapter = sqlAdapterFor(name, c);
  try {
    const version = await adapter.ping();
    const tables = await adapter.tables();
    out.push({ ok: true, what: name, text: `${version}, ${tables.length} table${tables.length === 1 ? '' : 's'} readable${c.explore ? ', explore on (any read-only query)' : ''}` });
  } catch (e) {
    return [{ ok: false, what: name, text: msg(e) }];
  }
  for (const t of mine) {
    try {
      await adapter.validate(parseSql(t.sql!, c.type));
      out.push({ ok: true, what: `${name} › ${t.name}`, text: 'the query compiles' });
    } catch (e) {
      out.push({ ok: false, what: `${name} › ${t.name}`, text: msg(e) });
    }
  }
  return out;
}

/** One plugin per connection, carrying the tools declared on it. */
export function dataPlugins(config: { connections: Record<string, ConnectionConfig>; tools: DataToolConfig[] }): Plugin[] {
  return Object.entries(config.connections).map(([name, c]) => {
    const mine = config.tools.filter((t) => t.connection === name);
    const tools: Tool[] = c.type === 'http' ? mine.map((t) => declaredHttpTool(name, c, t)) : [...mine.map((t) => declaredSqlTool(name, c, t)), ...(c.explore ? exploreTools(name, c) : [])];
    const explore = c.type !== 'http' && c.explore ? { ...exploreToolNames(name), limit: c.maxRows ?? DEFAULT_MAX_ROWS } : null;
    return definePlugin({
      id: name,
      description: c.description ?? (c.type === 'http' ? `HTTP API at ${new URL(c.baseUrl).host}` : c.type === 'postgres' ? 'Postgres database' : 'SQLite database'),
      env: envOf(c, mine),
      enabled: () => {
        if (c.type === 'sqlite' && !existsSync(sqlitePath(c.path))) return `the database file does not exist: ${sqlitePath(c.path)}`;
        if (tools.length === 0) return 'no tools yet: declare one in `tools`, or set "explore": true on the connection';
        return true;
      },
      tools,
      instructions: explore
        ? `"${name}" database${c.description ? ` (${c.description})` : ''}: call ${explore.tables} to see the tables, then ${explore.query} with one SELECT. Aggregate in SQL; results are limited to ${explore.limit} rows.`
        : undefined,
      commands: {
        check: {
          description: `check the "${name}" connection and its tools against the real ${c.type === 'http' ? 'API' : 'database'} (nothing is executed)`,
          run: async () => {
            const lines = await checkConnection(name, c, config.tools);
            for (const l of lines) console.log(`${l.ok ? '✓' : '✗'} ${l.what}  ${l.text}`);
            await closeDataConnections();
            if (lines.some((l) => !l.ok)) process.exitCode = 1;
          },
        },
        ...(c.type === 'http'
          ? {}
          : {
              tables: {
                description: `list the tables and columns "${name}" can read (for writing tools)`,
                run: async (args: string[]) => {
                  try {
                    console.log(describeTables(await sqlAdapterFor(name, c).tables(), args[0]));
                  } finally {
                    await closeDataConnections();
                  }
                },
              },
            }),
      },
    });
  });
}
