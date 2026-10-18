/** API key format and hashing, shared by both stores (Supabase's validate_mcp_key uses the same hash). */
import { createHash, randomBytes } from 'node:crypto';
import type { Role } from '../core/auth.js';

/** `kmcp_` + 32 random bytes (base64url). The prefix lets log masking and secret scanners spot it. */
export function generateKey(): string {
  return `kmcp_${randomBytes(32).toString('base64url')}`;
}

/** Hex SHA-256 of the UTF-8 key — same as encode(sha256(convert_to(key,'UTF8')),'hex') in Postgres. */
export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Stored role text → Role. 'engineer' is the pre-0.3 name of 'member'. Unknown values are treated as viewer. */
export function toRole(v: unknown): Role {
  if (v === 'admin') return 'admin';
  if (v === 'member' || v === 'engineer') return 'member';
  return 'viewer';
}

/** "90d", "12h", "30m" or an ISO date → ISO timestamp. */
export function parseExpiry(v: string): string {
  const m = /^(\d+)([dhm])$/.exec(v.trim());
  if (m) {
    const n = Number(m[1]);
    const ms = m[2] === 'd' ? n * 86_400_000 : m[2] === 'h' ? n * 3_600_000 : n * 60_000;
    return new Date(Date.now() + ms).toISOString();
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid expiry "${v}" — use 90d, 12h, 30m or a date`);
  return d.toISOString();
}
