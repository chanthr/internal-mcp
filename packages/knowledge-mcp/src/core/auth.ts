/**
 * Knowledge MCP — API key auth.
 *
 * Keys are checked against the store (SQLite file or Supabase `validate_mcp_key`). Only a SHA-256 hash
 * of each key is stored. Create keys with `knowledge-mcp keys create`.
 */
import { createHash, timingSafeEqual } from 'crypto';
import { getStore } from '../store/index.js';
import { getConfig } from './config.js';

/**
 * admin  = every tool.
 * member = a registered user (app_users row); limited by allowed_tools when set. Called "engineer" before 0.3.
 * viewer = signed in but not registered; only `ping` and the groups in config access.viewerTools.
 */
export type Role = 'admin' | 'member' | 'viewer';

/**
 * Constant-time string comparison: normalizes length with sha256, then timingSafeEqual (prevents timing leaks).
 * Also used by oauth.ts.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Per-user resource scopes (from the allowed_* columns of app_users).
 * A field that is null/undefined/an empty array means that dimension is fully allowed (unset). The admin role
 * ignores scopes and gets everything.
 */
export type ResourceScopes = {
  slackChannels?: string[] | null; // allowed Slack channel ids
  driveFolders?: string[] | null; // allowed Drive folder path prefixes
  tools?: string[] | null; // allowed tool groups = plugin ids (drive, slack, github, railway, your own plugins)
};

export type AuthContext = {
  ok: boolean;
  reason?: string;
  org_id?: string;
  role?: Role;
  email?: string;
  key_id?: string;
  scopes?: ResourceScopes;
  /**
   * Whether this is an act-as request (a trusted proxy stands in for a person through X-MCP-Act-As-Email).
   * The role on this path never exceeds member (http.ts).
   */
  actAs?: boolean;
  /** The key could not be checked because the store is down (not a wrong key). HTTP returns 503 instead of 401. */
  unavailable?: boolean;
};

// ── TTL cache of auth results ──
// On the HTTP transport, one tool call = one request = one validate_mcp_key RPC.
// A chatbot ReAct loop (several tools) or several users at once fire many RPCs with the same key, so
// a short TTL cache cuts DB round trips. (A key revoke takes effect after at most the TTL.)
const AUTH_CACHE_TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS ?? 60_000);
const AUTH_CACHE_MAX = 500; // hard cap as a backstop: prevents unbounded growth even with frequent key rotation
const _authCache = new Map<string, { auth: AuthContext; expiresAt: number }>();

/** Removes expired entries and, over the cap, evicts the oldest first (prevents a leak in the single-instance cache). */
function setAuthCache(key: string, auth: AuthContext): void {
  const now = Date.now();
  for (const [k, v] of _authCache) if (v.expiresAt <= now) _authCache.delete(k);
  while (_authCache.size >= AUTH_CACHE_MAX) {
    const oldest = _authCache.keys().next().value; // Map insertion order = oldest first
    if (oldest === undefined) break;
    _authCache.delete(oldest);
  }
  _authCache.set(key, { auth, expiresAt: now + AUTH_CACHE_TTL_MS });
}

export async function authenticateApiKey(
  key: string | undefined
): Promise<AuthContext> {
  if (!key) {
    return { ok: false, reason: 'MCP_API_KEY not provided' };
  }

  // Cache hit (only successes are cached; failures are rechecked every time so a newly activated key works quickly)
  const cached = _authCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.auth;
  }

  // Look up by hash in the store (SQLite file or Supabase validate_mcp_key RPC)
  try {
    const store = await getStore();
    const r = await store.validateKey(key);
    if (!r.ok) return { ok: false, reason: r.reason };
    const auth: AuthContext = {
      ok: true,
      org_id: r.orgId ?? getConfig().orgId,
      role: r.role,
      email: r.email ?? undefined,
      key_id: r.keyId,
    };
    setAuthCache(key, auth);
    return auth;
  } catch (e: unknown) {
    // Store outage. The internal error text goes to the server log only and is not sent to the client.
    console.error('[auth] key check failed (store unavailable):', e instanceof Error ? e.message : e);
    return { ok: false, reason: 'authentication backend unavailable', unavailable: true };
  }
}
