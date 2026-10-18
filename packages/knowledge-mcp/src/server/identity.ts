/**
 * Effective role and scopes of a person, recomputed from app_users on every request path
 * (direct key with an email, OAuth, act-as). Demotions and removals take effect within the cache TTL.
 */
import type { Role, ResourceScopes } from '../core/auth.js';
import { getStore } from '../store/index.js';
import type { UserRecord } from '../store/types.js';

const ACT_AS_TTL_MS = Number(process.env.ACT_AS_CACHE_TTL_MS ?? 60_000);
const _cache = new Map<string, { role: Role; scopes?: ResourceScopes; expiresAt: number }>();

/** app_users row → role. No row = viewer. 'admin' = admin. Anything else = member. */
export function roleFromUser(row: Pick<UserRecord, 'role'> | null | undefined): Role {
  if (!row) return 'viewer';
  return row.role === 'admin' ? 'admin' : 'member';
}

/**
 * Role + scopes for `email`. Never trusts a role sent by the client.
 * A failed lookup does not widen access: the result is viewer and is not cached, so a short outage
 * does not stick for the TTL (fail-closed).
 */
export async function resolveUser(keyId: string, email: string): Promise<{ role: Role; scopes?: ResourceScopes }> {
  const cacheKey = `${keyId}:${email.toLowerCase()}`;
  const now = Date.now();
  const cached = _cache.get(cacheKey);
  if (cached && cached.expiresAt > now) return { role: cached.role, scopes: cached.scopes };

  let role: Role;
  let scopes: ResourceScopes | undefined;
  try {
    const row = await (await getStore()).getUser(email);
    role = roleFromUser(row);
    scopes =
      row && row.scopesKnown !== false
        ? {
            slackChannels: row.allowedSlackChannels ?? null,
            driveFolders: row.allowedDriveFolders ?? null,
            tools: row.allowedTools ?? null,
          }
        : undefined;
  } catch (e) {
    console.error('[identity] app_users lookup failed → viewer:', e instanceof Error ? e.message : e);
    return { role: 'viewer' };
  }

  if (_cache.size > 500) {
    for (const [k, v] of _cache) if (v.expiresAt <= now) _cache.delete(k);
  }
  _cache.set(cacheKey, { role, scopes, expiresAt: now + ACT_AS_TTL_MS });
  return { role, scopes };
}
