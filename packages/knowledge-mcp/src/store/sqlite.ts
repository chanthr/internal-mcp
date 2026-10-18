/**
 * SQLite store — the default. One file (<data dir>/knowledge-mcp.db), no external service.
 *
 * Uses Node's built-in node:sqlite (Node 22.13+), so there is no native module to compile.
 * WAL mode lets the CLI (`knowledge-mcp keys create`) write while the server is running.
 * The file holds key hashes and OAuth client secrets: the directory is created 0700 and the file 0600.
 */
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { dataDir } from '../core/paths.js';
import { generateKey, hashKey, toRole } from './keys.js';
import type {
  KeyCheck, KeyInfo, NewKey, RefreshConsume, SlackChannelPatch, SlackChannelRow, Store, ToolCallRecord, UserRecord,
} from './types.js';

const SCHEMA_SQL = `
create table if not exists mcp_keys (
  id          text primary key,
  key_hash    text not null unique,
  org_id      text not null default 'org',
  role        text not null default 'member',
  email       text,
  label       text,
  active      integer not null default 1,
  expires_at  text,
  created_at  text not null
);
create table if not exists app_users (
  email                   text primary key,
  role                    text not null default 'member',
  name                    text,
  allowed_slack_channels  text,
  allowed_drive_folders   text,
  allowed_tools           text,
  created_at              text not null
);
create table if not exists mcp_oauth_clients (
  client_id     text primary key,
  client_data   text not null,
  client_name   text,
  created_at    text not null,
  last_used_at  text
);
create table if not exists mcp_refresh_tokens (
  jti         text primary key,
  email       text not null,
  client_id   text not null,
  expires_at  text not null,
  revoked_at  text,
  rotated_to  text,
  created_at  text not null
);
create index if not exists mcp_refresh_tokens_email_idx on mcp_refresh_tokens (email);
create table if not exists mcp_plugin_state (
  namespace   text not null,
  key         text not null,
  value       text not null,
  updated_at  text not null,
  primary key (namespace, key)
);
create table if not exists mcp_tool_calls (
  id           integer primary key autoincrement,
  tool         text not null,
  email        text,
  role         text,
  ok           integer not null,
  error        text,
  duration_ms  integer,
  source       text,
  created_at   text not null
);
create index if not exists mcp_tool_calls_created_idx on mcp_tool_calls (created_at);
create table if not exists slack_channels (
  id            text primary key,
  channel_name  text not null,
  channel_id    text unique,
  purpose       text not null default '',
  category      text,
  enabled       integer not null default 0,
  sort_order    integer not null default 100,
  created_at    text not null
);
`;

const now = () => new Date().toISOString();
const arr = (v: unknown): string[] | null => {
  if (typeof v !== 'string' || !v) return null;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
};
const arrText = (v: string[] | null | undefined): string | null => (v && v.length ? JSON.stringify(v) : null);

type Row = Record<string, unknown>;

const SLACK_PATCH_COLUMNS = new Set<string>(['channel_name', 'channel_id', 'purpose', 'category', 'enabled', 'sort_order']);

/** Loads node:sqlite without its one-time ExperimentalWarning (stable enough for this use, noisy in every CLI run). */
async function openDatabase(path: string): Promise<DatabaseSync> {
  const orig = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    if (msg && msg.includes('SQLite is an experimental feature')) return;
    return (orig as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(path);
  } finally {
    process.emitWarning = orig;
  }
}

export class SqliteStore implements Store {
  readonly kind = 'sqlite' as const;

  private constructor(
    private readonly db: DatabaseSync,
    readonly location: string,
  ) {}

  static async open(path = join(dataDir(), 'knowledge-mcp.db')): Promise<SqliteStore> {
    const dir = join(path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fresh = !existsSync(path);
    const db = await openDatabase(path);
    if (fresh) {
      try {
        chmodSync(path, 0o600);
      } catch {
        /* not supported on this filesystem */
      }
    }
    db.exec('pragma journal_mode = wal; pragma busy_timeout = 5000; pragma foreign_keys = on;');
    db.exec(SCHEMA_SQL);
    const store = new SqliteStore(db, path);
    store.pruneToolCalls();
    return store;
  }

  /** Keep the audit log bounded: MCP_TOOL_LOG_DAYS (default 90) days. */
  private pruneToolCalls(): void {
    const days = Number(process.env.MCP_TOOL_LOG_DAYS ?? 90);
    if (!Number.isFinite(days) || days <= 0) return;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    this.db.prepare('delete from mcp_tool_calls where created_at < ?').run(cutoff);
  }

  close(): void {
    this.db.close();
  }

  // ── API keys ──
  async validateKey(rawKey: string): Promise<KeyCheck> {
    const r = this.db.prepare('select * from mcp_keys where key_hash = ?').get(hashKey(rawKey)) as Row | undefined;
    if (!r) return { ok: false, reason: 'key not found' };
    if (!r.active) return { ok: false, reason: 'key inactive' };
    if (r.expires_at && String(r.expires_at) < now()) return { ok: false, reason: 'key expired' };
    return {
      ok: true,
      keyId: String(r.id),
      orgId: String(r.org_id),
      role: toRole(r.role),
      email: (r.email as string | null) ?? null,
    };
  }

  async createKey(input: NewKey): Promise<{ id: string; key: string }> {
    const id = randomUUID();
    const key = generateKey();
    this.db
      .prepare(
        'insert into mcp_keys (id, key_hash, org_id, role, email, label, active, expires_at, created_at) values (?, ?, ?, ?, ?, ?, 1, ?, ?)',
      )
      .run(id, hashKey(key), input.orgId, input.role ?? 'member', input.email?.toLowerCase() ?? null, input.label ?? null, input.expiresAt ?? null, now());
    return { id, key };
  }

  async listKeys(): Promise<KeyInfo[]> {
    const rows = this.db.prepare('select * from mcp_keys order by created_at').all() as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      orgId: String(r.org_id),
      role: toRole(r.role),
      email: (r.email as string | null) ?? null,
      label: (r.label as string | null) ?? null,
      active: !!r.active,
      expiresAt: (r.expires_at as string | null) ?? null,
      createdAt: String(r.created_at),
    }));
  }

  async revokeKey(id: string): Promise<boolean> {
    return Number(this.db.prepare('update mcp_keys set active = 0 where id = ? and active = 1').run(id).changes) > 0;
  }

  // ── Users ──
  async getUser(email: string): Promise<UserRecord | null> {
    const r = this.db.prepare('select * from app_users where email = ?').get(email.toLowerCase()) as Row | undefined;
    return r ? this.userFromRow(r) : null;
  }

  private userFromRow(r: Row): UserRecord {
    return {
      email: String(r.email),
      role: String(r.role),
      name: (r.name as string | null) ?? null,
      allowedSlackChannels: arr(r.allowed_slack_channels),
      allowedDriveFolders: arr(r.allowed_drive_folders),
      allowedTools: arr(r.allowed_tools),
      scopesKnown: true,
    };
  }

  async upsertUser(u: UserRecord): Promise<void> {
    this.db
      .prepare(
        `insert into app_users (email, role, name, allowed_slack_channels, allowed_drive_folders, allowed_tools, created_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict (email) do update set role = excluded.role, name = excluded.name,
           allowed_slack_channels = excluded.allowed_slack_channels,
           allowed_drive_folders = excluded.allowed_drive_folders, allowed_tools = excluded.allowed_tools`,
      )
      .run(
        u.email.toLowerCase(), u.role, u.name ?? null,
        arrText(u.allowedSlackChannels), arrText(u.allowedDriveFolders), arrText(u.allowedTools), now(),
      );
  }

  async listUsers(): Promise<UserRecord[]> {
    return (this.db.prepare('select * from app_users order by email').all() as Row[]).map((r) => this.userFromRow(r));
  }

  async removeUser(email: string): Promise<boolean> {
    return Number(this.db.prepare('delete from app_users where email = ?').run(email.toLowerCase()).changes) > 0;
  }

  // ── Audit log ──
  async logToolCall(row: ToolCallRecord): Promise<void> {
    try {
      this.db
        .prepare(
          'insert into mcp_tool_calls (tool, email, role, ok, error, duration_ms, source, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(row.tool, row.email, row.role, row.ok ? 1 : 0, row.error ? row.error.slice(0, 2000) : null, row.durationMs, 'knowledge-mcp', now());
    } catch (e) {
      console.error('[tool-log] insert failed:', e instanceof Error ? e.message : e);
    }
  }

  // ── OAuth ──
  async getOAuthClient(clientId: string): Promise<OAuthClientInformationFull | null> {
    const r = this.db.prepare('select client_data from mcp_oauth_clients where client_id = ?').get(clientId) as Row | undefined;
    return r ? (JSON.parse(String(r.client_data)) as OAuthClientInformationFull) : null;
  }

  async saveOAuthClient(client: OAuthClientInformationFull): Promise<void> {
    this.db
      .prepare(
        `insert into mcp_oauth_clients (client_id, client_data, client_name, created_at, last_used_at) values (?, ?, ?, ?, ?)
         on conflict (client_id) do update set client_data = excluded.client_data, client_name = excluded.client_name,
           last_used_at = excluded.last_used_at`,
      )
      .run(client.client_id, JSON.stringify(client), typeof client.client_name === 'string' ? client.client_name : null, now(), now());
  }

  async touchOAuthClient(clientId: string): Promise<void> {
    this.db.prepare('update mcp_oauth_clients set last_used_at = ? where client_id = ?').run(now(), clientId);
  }

  async recordRefreshToken(jti: string, email: string, clientId: string, expiresAt: string): Promise<void> {
    this.db
      .prepare('insert into mcp_refresh_tokens (jti, email, client_id, expires_at, created_at) values (?, ?, ?, ?, ?)')
      .run(jti, email.toLowerCase(), clientId, expiresAt, now());
  }

  async consumeRefreshToken(jti: string, rotatedTo: string): Promise<RefreshConsume> {
    const t = now();
    // One statement, so two concurrent refreshes with the same token cannot both succeed.
    const changed = this.db
      .prepare('update mcp_refresh_tokens set revoked_at = ?, rotated_to = ? where jti = ? and revoked_at is null and expires_at > ?')
      .run(t, rotatedTo, jti, t).changes;
    if (Number(changed) > 0) return 'ok';
    const row = this.db.prepare('select jti from mcp_refresh_tokens where jti = ?').get(jti);
    return row ? 'revoked' : 'unknown';
  }

  async revokeAllRefreshForEmail(email: string): Promise<void> {
    this.db.prepare('update mcp_refresh_tokens set revoked_at = ? where email = ? and revoked_at is null').run(now(), email.toLowerCase());
  }

  async purgeExpiredRefreshTokens(): Promise<void> {
    this.db.prepare('delete from mcp_refresh_tokens where expires_at < ?').run(now());
  }

  // ── Plugin state ──
  async getState(namespace: string, key: string): Promise<unknown | null> {
    const r = this.db.prepare('select value from mcp_plugin_state where namespace = ? and key = ?').get(namespace, key) as Row | undefined;
    return r ? JSON.parse(String(r.value)) : null;
  }

  async setState(namespace: string, key: string, value: unknown): Promise<void> {
    this.db
      .prepare(
        `insert into mcp_plugin_state (namespace, key, value, updated_at) values (?, ?, ?, ?)
         on conflict (namespace, key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(namespace, key, JSON.stringify(value ?? null), now());
  }

  async deleteState(namespace: string, key: string): Promise<void> {
    this.db.prepare('delete from mcp_plugin_state where namespace = ? and key = ?').run(namespace, key);
  }

  // ── Slack channel map ──
  async listSlackChannels(): Promise<SlackChannelRow[]> {
    const rows = this.db.prepare('select * from slack_channels order by sort_order, channel_name').all() as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      channel_name: String(r.channel_name),
      channel_id: (r.channel_id as string | null) ?? null,
      purpose: String(r.purpose ?? ''),
      category: (r.category as string | null) ?? null,
      enabled: !!r.enabled,
      sort_order: Number(r.sort_order),
    }));
  }

  async insertSlackChannels(rows: Array<Omit<SlackChannelRow, 'id'>>): Promise<void> {
    const stmt = this.db.prepare(
      'insert or ignore into slack_channels (id, channel_name, channel_id, purpose, category, enabled, sort_order, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of rows) {
      stmt.run(randomUUID(), r.channel_name, r.channel_id, r.purpose, r.category, r.enabled ? 1 : 0, r.sort_order, now());
    }
  }

  async updateSlackChannel(id: string, patch: SlackChannelPatch): Promise<void> {
    // Column names go into the SQL text, so only known columns pass.
    const cols = (Object.keys(patch) as Array<keyof SlackChannelPatch>).filter((c) => SLACK_PATCH_COLUMNS.has(c));
    if (!cols.length) return;
    const values = cols.map((c) => {
      const v = patch[c];
      return typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? null);
    });
    this.db.prepare(`update slack_channels set ${cols.map((c) => `${c} = ?`).join(', ')} where id = ?`).run(...values, id);
  }
}
