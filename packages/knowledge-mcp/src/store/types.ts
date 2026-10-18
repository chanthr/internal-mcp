/**
 * Server state behind one interface, so the same server runs on a local SQLite file (default, zero setup)
 * or on Supabase (shared Postgres for a team deployment).
 */
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Role } from '../core/auth.js';

export type KeyCheck =
  | { ok: true; keyId: string; orgId: string; role: Role; email: string | null }
  | { ok: false; reason: string };

export interface KeyInfo {
  id: string;
  orgId: string;
  role: Role;
  email: string | null;
  label: string | null;
  active: boolean;
  expiresAt: string | null;
  createdAt: string;
}

export interface NewKey {
  email?: string | null;
  role?: Role;
  orgId: string;
  label?: string | null;
  expiresAt?: string | null;
}

/** app_users row. Array fields: null or empty = no limit on that dimension. */
export interface UserRecord {
  email: string;
  /** 'admin' = every tool. Anything else = member, limited by the allowed_* fields. */
  role: string;
  name?: string | null;
  allowedSlackChannels?: string[] | null;
  allowedDriveFolders?: string[] | null;
  /** Plugin ids (permission groups). */
  allowedTools?: string[] | null;
  /** False when the Supabase table predates the scope columns (role only). */
  scopesKnown?: boolean;
}

export interface ToolCallRecord {
  tool: string;
  email: string | null;
  role: string | null;
  ok: boolean;
  error: string | null;
  durationMs: number;
}

export interface SlackChannelRow {
  id: string;
  channel_name: string;
  channel_id: string | null;
  purpose: string;
  category: string | null;
  enabled: boolean;
  sort_order: number;
}

export type SlackChannelPatch = Partial<Pick<SlackChannelRow, 'channel_name' | 'channel_id' | 'purpose' | 'category' | 'enabled' | 'sort_order'>>;

export type RefreshConsume = 'ok' | 'revoked' | 'unknown';

export interface Store {
  readonly kind: 'sqlite' | 'supabase';
  /** Human-readable location for logs (file path or project host). Never contains secrets. */
  readonly location: string;

  // API keys (only a SHA-256 hash is stored)
  validateKey(rawKey: string): Promise<KeyCheck>;
  createKey(input: NewKey): Promise<{ id: string; key: string }>;
  listKeys(): Promise<KeyInfo[]>;
  revokeKey(id: string): Promise<boolean>;

  // Users (RBAC). getUser throws when the lookup itself fails, so callers can fail closed.
  getUser(email: string): Promise<UserRecord | null>;
  upsertUser(user: UserRecord): Promise<void>;
  listUsers(): Promise<UserRecord[]>;
  removeUser(email: string): Promise<boolean>;

  // Audit log (best effort: implementations swallow and log their own errors)
  logToolCall(row: ToolCallRecord): Promise<void>;
  /** Delete tool-call log rows older than `days`. Returns how many were removed. */
  pruneToolCalls(days: number): Promise<number>;

  // OAuth
  getOAuthClient(clientId: string): Promise<OAuthClientInformationFull | null>;
  saveOAuthClient(client: OAuthClientInformationFull): Promise<void>;
  touchOAuthClient(clientId: string): Promise<void>;
  recordRefreshToken(jti: string, email: string, clientId: string, expiresAt: string): Promise<void>;
  /** Atomically revoke an active refresh token. 'revoked' = it existed but was already revoked (reuse). */
  consumeRefreshToken(jti: string, rotatedTo: string): Promise<RefreshConsume>;
  revokeAllRefreshForEmail(email: string): Promise<void>;
  purgeExpiredRefreshTokens(): Promise<void>;

  // Plugin key-value state. getState throws when the lookup fails (null = not set).
  getState(namespace: string, key: string): Promise<unknown | null>;
  setState(namespace: string, key: string, value: unknown): Promise<void>;
  deleteState(namespace: string, key: string): Promise<void>;

  // Slack channel purpose map (slack plugin)
  listSlackChannels(): Promise<SlackChannelRow[]>;
  insertSlackChannels(rows: Array<Omit<SlackChannelRow, 'id'>>): Promise<void>;
  updateSlackChannel(id: string, patch: SlackChannelPatch): Promise<void>;
}
