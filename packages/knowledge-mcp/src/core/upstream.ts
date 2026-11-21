/**
 * MCP gateway — connects to remote MCP servers as a client and re-exposes their tools under a name prefix,
 * so one connector gives the user both local plugin tools and remote ones.
 *
 * Design:
 *   - graceful (fail-open): a remote that fails to connect only drops its own tools; the server keeps running.
 *   - best-effort connect after listen + tools/list cache. Each MCP session reads the cache.
 *   - names: `{prefix}{remote name}` (e.g. github_search_code). The prefix routes calls back.
 *   - read-only by default: only tools that read are listed and callable, so the shared server token can't be
 *     used to edit code, merge or delete through the gateway. A tool reads when the remote says so
 *     (readOnlyHint), or, when the remote says nothing, when its first word is a read verb.
 *
 * Remotes come from plugins (`upstreams` in a plugin) and from the config file (`upstreams: [...]`).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
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

/**
 * First word of a remote tool name: get_file_contents → get, getFile → get. A leading word that is the name of
 * the service itself says nothing about what the tool does and is skipped: notion-search → search.
 */
function firstWord(remoteName: string, service: string): string {
  const words = remoteName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_\-.\s]/).map((w) => w.toLowerCase());
  const own = service.toLowerCase().split(/[_\-.\s]/)[0];
  return (words.length > 1 && words[0] === own ? words[1] : words[0]) ?? '';
}

/**
 * Is this remote tool exposed? `readOnlyHint` is what the remote says about the tool, when its listing is at
 * hand: a tool it marks as read-only is a read tool, one it marks as changing things is not, whatever the name.
 */
export function isExposed(spec: UpstreamSpec, remoteName: string, readOnlyHint?: boolean): boolean {
  const expose = spec.expose ?? 'read';
  if (expose === 'all') return true;
  if (Array.isArray(expose)) return expose.includes(remoteName);
  if (typeof readOnlyHint === 'boolean') return readOnlyHint;
  return READ_VERBS.has(firstWord(remoteName, spec.name));
}

/**
 * The transport to a remote: its headers, and its token. A fixed token is a header. A sign-in is asked for on
 * every request, because it runs out: when the remote refuses the token (401) it is renewed once and the request
 * is sent again.
 */
function transportFor(spec: UpstreamSpec): StreamableHTTPClientTransport {
  const headers: Record<string, string> = { ...(spec.headers ?? {}) };
  const fixed = typeof spec.token === 'function' ? spec.token() : spec.token;
  if (fixed && !spec.bearer) headers.Authorization = `Bearer ${fixed}`;
  const bearer = spec.bearer;
  const withSignIn: FetchLike | undefined = bearer
    ? async (url, init) => {
        const send = (token: string) => {
          const h = new Headers(init?.headers);
          h.set('Authorization', `Bearer ${token}`);
          return fetch(url, { ...init, headers: h });
        };
        const token = await bearer();
        const res = await send(token);
        if (res.status !== 401) return res;
        await res.body?.cancel().catch(() => {});
        return send(await bearer(token));
      }
    : undefined;
  return new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers }, ...(withSignIn ? { fetch: withSignIn } : {}) });
}

/**
 * Connect once, list the tools, and hang up: what adding a remote from the console checks before it is saved.
 * Returns how many tools there are and how many of them the read-only gateway would show.
 */
export async function probeUpstream(spec: UpstreamSpec): Promise<{ tools: number; shown: number }> {
  const transport = transportFor(spec);
  const client = new Client({ name: 'knowledge-mcp-gateway', version: VERSION }, { capabilities: {} });
  try {
    await client.connect(transport);
    const res = await client.listTools();
    return { tools: res.tools.length, shown: res.tools.filter((t) => isExposed({ ...spec, expose: 'read' }, t.name, t.annotations?.readOnlyHint)).length };
  } finally {
    await transport.close().catch(() => {});
  }
}

class Upstream {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private tools: Tool[] = []; // prefixed, exposed only
  /** What the remote's own listing decided for each tool it listed (remote name → exposed). */
  private listed = new Map<string, boolean>();
  private hidden = 0;
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

    let opened: { client: Client; transport: StreamableHTTPClientTransport } | null = null;
    try {
      const transport = transportFor(this.spec);
      const client = new Client({ name: 'knowledge-mcp-gateway', version: VERSION }, { capabilities: {} });
      opened = { client, transport };
      await client.connect(transport);
      const res = await client.listTools();

      const listed = new Map(res.tools.map((t) => [t.name, isExposed(this.spec, t.name, t.annotations?.readOnlyHint)]));
      const shown = res.tools.filter((t) => listed.get(t.name));
      this.tools = shown.map((t) => ({ ...t, name: `${this.spec.prefix}${t.name}`, description: `[${this.spec.name}] ${t.description ?? ''}` }));
      this.listed = listed;
      // Commit only after success so a failed reconnect never exposes a half-built state.
      this.transport = transport;
      this.client = client;
      this.connected = true;
      this.lastError = null;
      opened = null;
      const hidden = res.tools.length - this.tools.length;
      this.hidden = hidden;
      console.error(
        `[upstream:${this.spec.name}] connected · ${this.tools.length} tools (prefix ${this.spec.prefix})` +
          (hidden ? ` · ${hidden} hidden (not read-only)` : ''),
      );
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.connected = false;
      console.error(`[upstream:${this.spec.name}] connect failed (skipped): ${this.lastError}`);
      // A connection made before the failure (the remote answered, then could not list its tools) is closed: kept by
      // nobody, it held its stream to the remote open, and a broken remote is tried again on every call to it.
      if (opened) {
        const { client, transport } = opened;
        await client.close().catch(() => transport.close().catch(() => {}));
      }
    }
  }

  getTools(): Tool[] {
    return this.connected ? this.tools : [];
  }

  /**
   * Whether this remote handles the name: prefix matches and the remote tool is exposed. For a tool the remote
   * has listed, its listing decided (it carries what the remote says the tool does). For any other name (the
   * remote has not answered yet, or does not list the tool), the name decides, as it always did.
   */
  claims(toolName: string): boolean {
    if (!toolName.startsWith(this.spec.prefix)) return false;
    const remoteName = toolName.slice(this.spec.prefix.length);
    return this.listed.get(remoteName) ?? isExposed(this.spec, remoteName);
  }

  /** Strip the prefix and forward. Reconnects once if the link dropped. */
  async callTool(toolName: string, args: Record<string, unknown>) {
    const remoteName = toolName.slice(this.spec.prefix.length);
    if (!this.client || !this.connected) {
      await this.connect();
      if (!this.client || !this.connected) {
        throw new Error(`[upstream:${this.spec.name}] not connected${this.lastError ? ` (${this.lastError})` : ''}`);
      }
      // The name was let through on its looks while the remote was away. Now that it has listed its tools, they decide.
      if (this.listed.get(remoteName) === false) throw new Error(`[upstream:${this.spec.name}] ${remoteName} is not exposed by the gateway (only read tools are, unless the upstream sets expose).`);
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
    return { name: this.spec.name, connected: this.connected, toolCount: this.tools.length, hidden: this.hidden, error: this.lastError };
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
