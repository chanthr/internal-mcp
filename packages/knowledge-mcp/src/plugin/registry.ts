/**
 * Registry — turns a list of plugins into the server's tool list, permission groups and call routing.
 *
 * Everything that used to be edited by hand per tool (import, list entry, switch case, permission group,
 * credential check, boot summary) is derived here from the plugin definitions.
 */
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { safeParse } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { AuthContext } from '../core/auth.js';
import { getConfig, type AppConfig, BASE_INSTRUCTIONS } from '../core/config.js';
import { UpstreamManager } from '../core/upstream.js';
import { isSet } from '../core/env.js';
import { getStore } from '../store/index.js';
import type { Plugin, PluginState, ToolContext, ToolSpec, UpstreamSpec } from './define.js';
import { errorResult, formatValidationError, inputJsonSchema, normalizeResult, textResult, type JsonSchemaObject } from './result.js';

export interface ToolStatus {
  name: string;
  enabled: boolean;
  reason?: string;
}

export interface PluginStatus {
  id: string;
  description?: string;
  enabled: boolean;
  reason?: string;
  tools: ToolStatus[];
  upstreams: string[];
}

interface Entry {
  plugin: Plugin;
  tool: ToolSpec;
  inputSchema: JsonSchemaObject;
}

/** The core `ping` tool. It belongs to no group and is always allowed. */
export const PING = 'ping';

function check(fn: (() => boolean | string) | undefined): true | string {
  if (!fn) return true;
  try {
    const r = fn();
    if (r === true) return true;
    return typeof r === 'string' && r ? r : 'disabled';
  } catch (e) {
    return `check failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function stateFor(namespace: string): PluginState {
  return {
    get: async <T>(key: string) => ((await (await getStore()).getState(namespace, key)) as T | null),
    set: async (key, value) => (await getStore()).setState(namespace, key, value),
    delete: async (key) => (await getStore()).deleteState(namespace, key),
  };
}

export class Registry {
  readonly plugins: Plugin[];
  readonly upstreams: UpstreamManager;
  private readonly entries = new Map<string, Entry>();
  private readonly pluginConfig = new Map<string, unknown>();
  /** Remote tool names already reported as shadowed by a local tool (log once). */
  private readonly warned = new Set<string>();
  private readonly upstreamGroups = new Map<string, string>();
  private readonly config: AppConfig;

  constructor(plugins: Plugin[], config: AppConfig = getConfig()) {
    this.plugins = plugins;
    this.config = config;
    const ids = new Set<string>();
    for (const p of plugins) {
      if (ids.has(p.id)) throw new Error(`[plugin] two plugins use the id "${p.id}"`);
      ids.add(p.id);
      for (const t of p.tools ?? []) {
        if (t.name === PING) throw new Error(`[plugin] ${p.id}: the tool name "ping" is reserved`);
        const other = this.entries.get(t.name);
        if (other) throw new Error(`[plugin] tool "${t.name}" is defined by both "${other.plugin.id}" and "${p.id}"`);
        this.entries.set(t.name, { plugin: p, tool: t, inputSchema: inputJsonSchema(t.name, t.input) });
      }
      this.pluginConfig.set(p.id, this.parsePluginConfig(p));
    }
    for (const u of config.upstreams) {
      if (ids.has(u.name)) throw new Error(`[config] upstream "${u.name}" has the same name as a plugin; pick another name`);
    }
    const remotes = this.collectUpstreams();
    for (const r of remotes) this.upstreamGroups.set(r.spec.name, r.group);
    this.upstreams = new UpstreamManager(remotes);
  }

  private parsePluginConfig(p: Plugin): unknown {
    const raw = this.config.plugins[p.id];
    if (!p.configSchema) return raw;
    const r = safeParse(p.configSchema, raw ?? {});
    if (!r.success) throw new Error(`[config] plugins.${p.id}: ${formatValidationError(r.error)}`);
    return r.data;
  }

  private collectUpstreams(): Array<{ spec: UpstreamSpec; group: string }> {
    const out: Array<{ spec: UpstreamSpec; group: string }> = [];
    for (const p of this.plugins) {
      if (!p.upstreams || this.pluginEnabled(p) !== true) continue;
      const specs = typeof p.upstreams === 'function' ? p.upstreams() : p.upstreams;
      for (const spec of specs) out.push({ spec, group: p.id });
    }
    for (const u of this.config.upstreams) {
      out.push({
        group: u.name,
        spec: {
          name: u.name,
          url: u.url,
          prefix: u.prefix ?? `${u.name.replace(/-/g, '_')}_`,
          token: u.tokenEnv ? () => process.env[u.tokenEnv!] : undefined,
          headers: u.headers,
          expose: u.expose,
        },
      });
    }
    return out;
  }

  /** true, or why the plugin is off (missing env names, failed check). */
  pluginEnabled(p: Plugin): true | string {
    const missing = (p.env ?? []).filter((name) => !isSet(process.env[name]));
    if (missing.length) return `missing env ${missing.join(', ')}`;
    return check(p.enabled);
  }

  private toolEnabled(e: Entry): true | string {
    const pe = this.pluginEnabled(e.plugin);
    return pe === true ? check(e.tool.enabled) : pe;
  }

  status(): PluginStatus[] {
    return this.plugins.map((p) => {
      const pe = this.pluginEnabled(p);
      return {
        id: p.id,
        description: p.description,
        enabled: pe === true,
        reason: pe === true ? undefined : pe,
        tools: (p.tools ?? []).map((t) => {
          const te = this.toolEnabled(this.entries.get(t.name)!);
          return { name: t.name, enabled: te === true, reason: te === true ? undefined : te };
        }),
        upstreams: [...this.upstreamGroups].filter(([, g]) => g === p.id).map(([name]) => name),
      };
    });
  }

  /** One line for the boot log: drive=on slack=off ... */
  summary(): string {
    const parts = this.status().map((s) => {
      if (!s.enabled) return `${s.id}=off`;
      const off = s.tools.filter((t) => !t.enabled).length;
      return off ? `${s.id}=on(${s.tools.length - off}/${s.tools.length})` : `${s.id}=on`;
    });
    const remote = this.config.upstreams.map((u) => `${u.name}=remote`);
    return [...parts, ...remote].join(' ') || '(no plugins)';
  }

  /** Server instructions: config branding.instructions, or the base line plus each enabled plugin's notes. */
  instructions(): string {
    if (this.config.branding.instructions) return this.config.branding.instructions;
    const notes = this.plugins
      .filter((p) => p.instructions && this.pluginEnabled(p) === true)
      .map((p) => `- ${p.instructions!.trim()}`);
    return notes.length ? `${BASE_INSTRUCTIONS}\n\n${notes.join('\n')}` : BASE_INSTRUCTIONS;
  }

  /** Permission group of a tool: plugin id, upstream group, or null (ping, unknown names). */
  groupOf(name: string): string | null {
    const e = this.entries.get(name);
    if (e) return e.plugin.id;
    return this.upstreams.owner(name)?.group ?? null;
  }

  /** Every tool to show (before permission filtering): ping, enabled local tools, connected remote tools. */
  listTools(pingTool: McpTool): McpTool[] {
    const out: McpTool[] = [pingTool];
    for (const e of this.entries.values()) {
      if (this.toolEnabled(e) !== true) continue;
      out.push({
        name: e.tool.name,
        description: e.tool.description,
        inputSchema: e.inputSchema as McpTool['inputSchema'],
        ...(e.tool.annotations ? { annotations: e.tool.annotations } : {}),
      });
    }
    for (const { tool } of this.upstreams.tools()) {
      if (this.entries.has(tool.name) || tool.name === PING) {
        if (!this.warned.has(tool.name)) {
          this.warned.add(tool.name);
          console.error(`[upstream] remote tool ${tool.name} hidden: a local tool has the same name`);
        }
        continue;
      }
      out.push(tool);
    }
    return out;
  }

  /** Validate, run and normalize. Permission is checked by the caller (server/mcp.ts) before this. */
  async call(name: string, args: Record<string, unknown> | undefined, auth: AuthContext): Promise<ReturnType<typeof normalizeResult>> {
    const e = this.entries.get(name);
    if (e) {
      const enabled = this.toolEnabled(e);
      if (enabled !== true) return textResult(`[error] 도구 '${name}' 이 설정되지 않았습니다 (${enabled}).`, true);
      const parsed = e.tool.input ? safeParse(e.tool.input, args ?? {}) : { success: true as const, data: args ?? {} };
      if (!parsed.success) {
        return textResult(`[invalid_input] 도구 '${name}' 입력이 스키마에 맞지 않습니다 — ${formatValidationError(parsed.error)}`, true);
      }
      const ctx: ToolContext = {
        user: { email: auth.email, role: auth.role ?? 'viewer', keyId: auth.key_id },
        auth,
        config: this.pluginConfig.get(e.plugin.id),
        state: stateFor(e.plugin.id),
        log: (...a: unknown[]) => console.error(`[${e.plugin.id}]`, ...a),
      };
      try {
        return normalizeResult(await e.tool.run(parsed.data as never, ctx));
      } catch (err) {
        return errorResult(name, err);
      }
    }
    const remote = this.upstreams.owner(name);
    if (remote) {
      try {
        return (await remote.call(args ?? {})) as ReturnType<typeof normalizeResult>;
      } catch (err) {
        return errorResult(name, err);
      }
    }
    const blockedBy = this.upstreams.prefixOwner(name);
    if (blockedBy) {
      console.error(`[upstream] blocked (not exposed by the read-only gateway): ${name}`);
      return textResult(`[forbidden] write/미허용 도구는 비활성화됨(read-only gateway): ${name}`, true);
    }
    return textResult(`Unknown tool: ${name}`, true);
  }

  /**
   * After listen: connect remotes and, on HTTP, run plugin start hooks (background jobs such as the Drive
   * sync). stdio skips the hooks: every client session spawns its own process and would start its own jobs.
   * Failures are logged and skipped.
   */
  async start(opts: { jobs: boolean } = { jobs: true }): Promise<void> {
    try {
      await this.upstreams.connectAll();
    } catch (e) {
      console.error('[knowledge-mcp] upstream connect failed (local tools keep working):', e);
    }
    if (!opts.jobs) return;
    for (const p of this.plugins) {
      if (!p.start || this.pluginEnabled(p) !== true) continue;
      try {
        await p.start({
          config: this.pluginConfig.get(p.id),
          state: stateFor(p.id),
          log: (...a: unknown[]) => console.error(`[${p.id}]`, ...a),
        });
      } catch (e) {
        console.error(`[${p.id}] start failed (plugin tools stay listed):`, e);
      }
    }
  }
}
