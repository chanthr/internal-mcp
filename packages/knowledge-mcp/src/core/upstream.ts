/**
 * MCP gateway — connects to remote MCP servers as a client and re-exposes their tools under a name prefix,
 * so one connector gives the user both local plugin tools and remote ones.
 *
 * Design:
 *   - graceful (fail-open): a remote that fails to connect only drops its own tools; the server keeps running.
 *   - best-effort connect after listen + tools/list cache. Each MCP session reads the cache.
 *   - names: `{prefix}{remote name}` (e.g. github_search_code). The prefix routes calls back.
 *   - read-only by default: only tools whose first word is a read verb are listed and callable, so the
 *     shared server token can't be used to edit code, merge or delete through the gateway.
 *
 * Remotes come from plugins (`upstreams` in a plugin) and from the config file (`upstreams: [...]`).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { UpstreamSpec } from '../plugin/define.js';
import { VERSION } from '../version.js';

/**
 * Allowlist (default-deny) of read verbs. A blocklist of write verbs used to let unknown verbs
 * (set_, enable_, dispatch_, assign_, submit_ ...) through as "read-only"; now an unknown verb is blocked.
 * A read tool blocked by a missing verb is a lost feature, but the safe side. Set `expose` to open more.
 */
const READ_VERBS = new Set<string>([
  'get', 'list', 'search', 'read', 'fetch', 'find', 'show', 'describe', 'view',
  // 'resolve' is not here — it names state-changing tools such as resolving a review thread.
  'query', 'count', 'check', 'status', 'ping', 'download', 'export',
  'lookup', 'diff', 'blame', 'compare', 'log', 'history', 'scan', 'inspect',
]);

/** First word of a remote tool name: get_file_contents → get, getFile → get, notion-search → notion. */
function firstWord(remoteName: string): string {
  return remoteName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_\-.\s]/)[0]!.toLowerCase();
}

export function isExposed(spec: UpstreamSpec, remoteName: string): boolean {
  const expose = spec.expose ?? 'read';
  if (expose === 'all') return true;
  if (Array.isArray(expose)) return expose.includes(remoteName);
  return READ_VERBS.has(firstWord(remoteName));
}

class Upstream {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private tools: Tool[] = []; // prefixed, exposed only
  private connected = false;
  private lastError: string | null = null;
  private connecting: Promise<void> | null = null; // single-flight: concurrent reconnects share one attempt

  constructor(
    public readonly spec: UpstreamSpec,
    public readonly group: string,
  ) {}

  /** best-effort connect + tools/list cache. Never throws. */
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    // Close the previous transport before replacing it so sockets and SSE streams don't leak.
    const prev = this.transport;
    this.client = null;
    this.transport = null;
    this.connected = false;
    if (prev) await prev.close().catch(() => {});

    try {
      const headers: Record<string, string> = { ...(this.spec.headers ?? {}) };
      const token = typeof this.spec.token === 'function' ? this.spec.token() : this.spec.token;
      if (token) headers.Authorization = `Bearer ${token}`;

      const transport = new StreamableHTTPClientTransport(new URL(this.spec.url), { requestInit: { headers } });
      const client = new Client({ name: 'knowledge-mcp-gateway', version: VERSION }, { capabilities: {} });
      await client.connect(transport);
      const res = await client.listTools();

      this.tools = res.tools
        .filter((t) => isExposed(this.spec, t.name))
        .map((t) => ({ ...t, name: `${this.spec.prefix}${t.name}`, description: `[${this.spec.name}] ${t.description ?? ''}` }));
      // Commit only after success so a failed reconnect never exposes a half-built state.
      this.transport = transport;
      this.client = client;
      this.connected = true;
      this.lastError = null;
      const hidden = res.tools.length - this.tools.length;
      console.error(
        `[upstream:${this.spec.name}] connected · ${this.tools.length} tools (prefix ${this.spec.prefix})` +
          (hidden ? ` · ${hidden} hidden (not read-only)` : ''),
      );
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.connected = false;
      console.error(`[upstream:${this.spec.name}] connect failed (skipped): ${this.lastError}`);
    }
  }

  getTools(): Tool[] {
    return this.connected ? this.tools : [];
  }

  /** Whether this remote handles the name: prefix matches and the remote tool is exposed. */
  claims(toolName: string): boolean {
    return toolName.startsWith(this.spec.prefix) && isExposed(this.spec, toolName.slice(this.spec.prefix.length));
  }

  /** Strip the prefix and forward. Reconnects once if the link dropped. */
  async callTool(toolName: string, args: Record<string, unknown>) {
    const remoteName = toolName.slice(this.spec.prefix.length);
    if (!this.client || !this.connected) {
      await this.connect();
      if (!this.client || !this.connected) {
        throw new Error(`[upstream:${this.spec.name}] not connected${this.lastError ? ` (${this.lastError})` : ''}`);
      }
    }
    try {
      return await this.client.callTool({ name: remoteName, arguments: args });
    } catch (e) {
      // The remote answered (JSON-RPC error) or timed out: the call may have run. Do not replay it, and do not
      // tear down the shared connection under other users' calls. Only a broken link is reconnected and retried.
      if (e instanceof McpError && e.code !== ErrorCode.ConnectionClosed) throw e;
      this.connected = false;
      await this.connect();
      if (!this.client || !this.connected) throw e;
      return await this.client.callTool({ name: remoteName, arguments: args });
    }
  }

  status() {
    return { name: this.spec.name, connected: this.connected, toolCount: this.tools.length, error: this.lastError };
  }
}

export class UpstreamManager {
  private upstreams: Upstream[] = [];

  constructor(entries: Array<{ spec: UpstreamSpec; group: string }>) {
    const prefixes = new Set<string>();
    for (const { spec, group } of entries) {
      if (!spec.prefix) throw new Error(`[upstream:${spec.name}] prefix is required`);
      if (prefixes.has(spec.prefix)) throw new Error(`[upstream] two remotes share the prefix "${spec.prefix}"`);
      prefixes.add(spec.prefix);
      this.upstreams.push(new Upstream(spec, group));
    }
  }

  get size(): number {
    return this.upstreams.length;
  }

  async connectAll(): Promise<void> {
    await Promise.all(this.upstreams.map((u) => u.connect()));
  }

  /** Tools of connected remotes, with their permission group. */
  tools(): Array<{ tool: Tool; group: string }> {
    return this.upstreams.flatMap((u) => u.getTools().map((tool) => ({ tool, group: u.group })));
  }

  /** The remote that owns this name, if any. */
  owner(toolName: string): { group: string; call: (args: Record<string, unknown>) => Promise<unknown> } | null {
    const u = this.upstreams.find((x) => x.claims(toolName));
    return u ? { group: u.group, call: (args) => u.callTool(toolName, args) } : null;
  }

  /** Prefix match only — used to tell "blocked remote write tool" apart from "unknown tool". */
  prefixOwner(toolName: string): string | null {
    return this.upstreams.find((u) => toolName.startsWith(u.spec.prefix))?.spec.name ?? null;
  }

  statuses() {
    return this.upstreams.map((u) => u.status());
  }
}
