/**
 * Supabase store — for team deployments that want state in a shared Postgres (and editable in the
 * Supabase dashboard). Tables come from sql/supabase.sql; rerun it after every upgrade (idempotent).
 *
 * State tables live in config.data.schema (default "public"). mcp_keys and validate_mcp_key stay in "public".
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { getConfig } from '../core/config.js';
import { getSupabase } from './supabase_client.js';
import { generateKey, hashKey, toRole } from './keys.js';
import type {
  KeyCheck, KeyInfo, NewKey, RefreshConsume, SlackChannelPatch, SlackChannelRow, Store, ToolCallRecord, UserRecord,
} from './types.js';

const SLACK_COLS = 'id,channel_name,channel_id,purpose,category,enabled,sort_order';

/** PostgREST/Postgres "column does not exist" — an app_users table created before the scope columns. */
function isMissingColumnError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === '42703' || code === 'PGRST204';
}

function fail(what: string, error: { message: string }): never {
  throw new Error(`[supabase] ${what}: ${error.message}`);
}

export class SupabaseStore implements Store {
  readonly kind = 'supabase' as const;
  readonly location: string;
  private readonly sb: SupabaseClient;
  private readonly schema: string;

  constructor() {
    this.sb = getSupabase();
    this.schema = getConfig().data.schema;
    let host = 'supabase';
    try {
      host = new URL(process.env.SUPABASE_URL ?? '').host;
    } catch {
      /* keep the generic name */
    }
    this.location = `${host} (schema ${this.schema})`;
  }

  private t(table: string) {
    return this.sb.schema(this.schema).from(table);
  }

  // ── API keys ──
  async validateKey(rawKey: string): Promise<KeyCheck> {
    const { data, error } = await this.sb.rpc('validate_mcp_key', { p_key: rawKey });
    // A failed lookup is an outage, not a bad key: throw so auth answers 503 instead of 401.
    if (error) throw new Error(`validate_mcp_key RPC failed: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { ok: false, reason: 'validate_mcp_key returned no row' };
    if (!row.ok) return { ok: false, reason: row.reason ?? 'auth failed' };
    return {
      ok: true,
      keyId: String(row.key_id),
      orgId: row.org_id ?? getConfig().orgId,
      role: toRole(row.role),
      email: row.email ?? null,
    };
  }

  async createKey(input: NewKey): Promise<{ id: string; key: string }> {
    const key = generateKey();
    const { data, error } = await this.sb
      .from('mcp_keys')
      .insert({
        key_hash: hashKey(key),
        org_id: input.orgId,
        role: input.role ?? 'member',
        email: input.email?.toLowerCase() ?? null,
        label: input.label ?? null,
        expires_at: input.expiresAt ?? null,
      })
      .select('id')
      .single();
    if (error) fail('create key (rerun sql/supabase.sql if the label column is missing)', error);
    return { id: String(data.id), key };
  }

  async listKeys(): Promise<KeyInfo[]> {
    const { data, error } = await this.sb
      .from('mcp_keys')
      .select('id, org_id, role, email, label, active, expires_at, created_at')
      .order('created_at');
    if (error) fail('list keys', error);
    return (data ?? []).map((r) => ({
      id: String(r.id),
      orgId: String(r.org_id),
      role: toRole(r.role),
      email: r.email ?? null,
      label: r.label ?? null,
      active: !!r.active,
      expiresAt: r.expires_at ?? null,
      createdAt: String(r.created_at),
    }));
  }

  async revokeKey(id: string): Promise<boolean> {
    const { data, error } = await this.sb.from('mcp_keys').update({ active: false }).eq('id', id).eq('active', true).select('id');
    if (error) fail('revoke key', error);
    return (data ?? []).length > 0;
  }

  // ── Users ──
  async getUser(email: string): Promise<UserRecord | null> {
    const e = email.toLowerCase();
    const { data, error } = await this.t('app_users')
      .select('email, role, name, allowed_slack_channels, allowed_drive_folders, allowed_tools')
      .eq('email', e)
      .maybeSingle();
    if (error) {
      if (!isMissingColumnError(error)) fail('read app_users', error);
      // Older table without the scope columns → role only, scopes unknown (= no limit).
      const r2 = await this.t('app_users').select('email, role').eq('email', e).maybeSingle();
      if (r2.error) fail('read app_users', r2.error);
      return r2.data ? { email: e, role: String(r2.data.role), scopesKnown: false } : null;
    }
    if (!data) return null;
    return {
      email: String(data.email),
      role: String(data.role),
      name: data.name ?? null,
      allowedSlackChannels: (data.allowed_slack_channels as string[] | null) ?? null,
      allowedDriveFolders: (data.allowed_drive_folders as string[] | null) ?? null,
      allowedTools: (data.allowed_tools as string[] | null) ?? null,
      scopesKnown: true,
    };
  }

  async upsertUser(u: UserRecord): Promise<void> {
    const { error } = await this.t('app_users').upsert(
      {
        email: u.email.toLowerCase(),
        role: u.role,
        name: u.name ?? null,
        allowed_slack_channels: u.allowedSlackChannels?.length ? u.allowedSlackChannels : null,
        allowed_drive_folders: u.allowedDriveFolders?.length ? u.allowedDriveFolders : null,
        allowed_tools: u.allowedTools?.length ? u.allowedTools : null,
      },
      { onConflict: 'email' },
    );
    if (error) fail('save user', error);
  }

  async listUsers(): Promise<UserRecord[]> {
    const { data, error } = await this.t('app_users')
      .select('email, role, name, allowed_slack_channels, allowed_drive_folders, allowed_tools')
      .order('email');
    if (error) fail('list users', error);
    return (data ?? []).map((r) => ({
      email: String(r.email),
      role: String(r.role),
      name: r.name ?? null,
      allowedSlackChannels: r.allowed_slack_channels ?? null,
      allowedDriveFolders: r.allowed_drive_folders ?? null,
      allowedTools: r.allowed_tools ?? null,
      scopesKnown: true,
    }));
  }

  async removeUser(email: string): Promise<boolean> {
    const { data, error } = await this.t('app_users').delete().eq('email', email.toLowerCase()).select('email');
    if (error) fail('remove user', error);
    return (data ?? []).length > 0;
  }

  // ── Audit log ──
  async logToolCall(row: ToolCallRecord): Promise<void> {
    try {
      const { error } = await this.t('mcp_tool_calls').insert({
        tool: row.tool,
        email: row.email,
        role: row.role,
        ok: row.ok,
        error: row.error ? row.error.slice(0, 2000) : null,
        duration_ms: row.durationMs,
        source: 'knowledge-mcp',
      });
      if (error) console.error('[tool-log] insert failed:', error.message);
    } catch (e) {
      console.error('[tool-log] insert failed:', e instanceof Error ? e.message : e);
    }
  }

  async pruneToolCalls(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data, error } = await this.t('mcp_tool_calls').delete().lt('created_at', cutoff).select('id');
    if (error) fail('prune tool calls', error);
    return (data ?? []).length;
  }

  // ── OAuth ──
  async getOAuthClient(clientId: string): Promise<OAuthClientInformationFull | null> {
    const { data, error } = await this.t('mcp_oauth_clients').select('client_data').eq('client_id', clientId).maybeSingle();
    if (error) fail('read oauth client', error);
    return data ? (data.client_data as OAuthClientInformationFull) : null;
  }

  async saveOAuthClient(client: OAuthClientInformationFull): Promise<void> {
    const { error } = await this.t('mcp_oauth_clients').upsert(
      {
        client_id: client.client_id,
        client_data: client,
        client_name: typeof client.client_name === 'string' ? client.client_name : null,
        last_used_at: new Date().toISOString(),
      },
      { onConflict: 'client_id' },
    );
    if (error) fail('save oauth client', error);
  }

  async touchOAuthClient(clientId: string): Promise<void> {
    const { error } = await this.t('mcp_oauth_clients').update({ last_used_at: new Date().toISOString() }).eq('client_id', clientId);
    if (error) fail('touch oauth client', error);
  }

  async recordRefreshToken(jti: string, email: string, clientId: string, expiresAt: string): Promise<void> {
    const { error } = await this.t('mcp_refresh_tokens').insert({ jti, email: email.toLowerCase(), client_id: clientId, expires_at: expiresAt });
    if (error) fail('record refresh token', error);
  }

  async consumeRefreshToken(jti: string, rotatedTo: string): Promise<RefreshConsume> {
    const t = new Date().toISOString();
    // Update only an active row — of two concurrent refreshes, one wins.
    const { data, error } = await this.t('mcp_refresh_tokens')
      .update({ revoked_at: t, rotated_to: rotatedTo })
      .eq('jti', jti)
      .is('revoked_at', null)
      .gt('expires_at', t)
      .select('jti');
    if (error) fail('consume refresh token', error);
    if (data && data.length > 0) return 'ok';
    const r2 = await this.t('mcp_refresh_tokens').select('jti').eq('jti', jti).maybeSingle();
    if (r2.error) fail('consume refresh token', r2.error);
    return r2.data ? 'revoked' : 'unknown';
  }

  async revokeAllRefreshForEmail(email: string): Promise<void> {
    const { error } = await this.t('mcp_refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('email', email.toLowerCase())
      .is('revoked_at', null);
    if (error) fail('revoke refresh tokens', error);
  }

  async purgeExpiredRefreshTokens(): Promise<void> {
    const { error } = await this.t('mcp_refresh_tokens').delete().lt('expires_at', new Date().toISOString());
    if (error) fail('purge refresh tokens', error);
  }

  // ── Plugin state ──
  async getState(namespace: string, key: string): Promise<unknown | null> {
    const { data, error } = await this.t('mcp_plugin_state').select('value').eq('namespace', namespace).eq('key', key).maybeSingle();
    if (error) fail('read plugin state (rerun sql/supabase.sql if mcp_plugin_state is missing)', error);
    return data ? data.value : null;
  }

  async setState(namespace: string, key: string, value: unknown): Promise<void> {
    const { error } = await this.t('mcp_plugin_state').upsert(
      { namespace, key, value: value ?? null, updated_at: new Date().toISOString() },
      { onConflict: 'namespace,key' },
    );
    if (error) fail('save plugin state', error);
  }

  async deleteState(namespace: string, key: string): Promise<void> {
    const { error } = await this.t('mcp_plugin_state').delete().eq('namespace', namespace).eq('key', key);
    if (error) fail('delete plugin state', error);
  }

  // ── Slack channel map ──
  async listSlackChannels(): Promise<SlackChannelRow[]> {
    const { data, error } = await this.t('slack_channels').select(SLACK_COLS).order('sort_order');
    if (error) fail('read slack_channels', error);
    return (data ?? []) as SlackChannelRow[];
  }

  async insertSlackChannels(rows: Array<Omit<SlackChannelRow, 'id'>>): Promise<void> {
    if (!rows.length) return;
    const { error } = await this.t('slack_channels').insert(rows);
    if (error) fail('insert slack_channels', error);
  }

  async updateSlackChannel(id: string, patch: SlackChannelPatch): Promise<void> {
    const { error } = await this.t('slack_channels').update(patch).eq('id', id);
    if (error) fail('update slack_channels', error);
  }
}
