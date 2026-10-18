/**
 * Knowledge MCP — API key auth.
 *
 * stdio dev: single dev key (env MCP_DEV_KEY).
 * http prod: Supabase `validate_mcp_key(p_key)` RPC — hashed keys with revoke/expiry.
 */
import { createHash, timingSafeEqual } from 'crypto';
import { getSupabase } from './supabase.js';
import { getConfig } from './config.js';

export type Role = 'admin' | 'engineer' | 'viewer';

/** 상수시간 문자열 비교 — sha256 으로 길이 정규화 후 timingSafeEqual (타이밍 누출 방지). oauth.ts 도 사용. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * 직원별 리소스 스코프 (app_users 의 allowed_* 컬럼에서 옴).
 * 각 필드 null/undefined/빈배열 = 그 차원은 전체 허용(미설정). admin role 은 scope 무시 전체.
 */
export type ResourceScopes = {
  slackChannels?: string[] | null; // 허용 Slack 채널 id
  driveFolders?: string[] | null; // 허용 Drive 폴더 path prefix
  tools?: string[] | null; // 허용 도구군 (slack·drive·github·railway·secret)
};

export type AuthContext = {
  ok: boolean;
  reason?: string;
  org_id?: string;
  role?: Role;
  email?: string;
  key_id?: string;
  scopes?: ResourceScopes;
  /** act-as(내부 프록시 위임) 경로로 들어온 요청인가. 프록시 키 유출에 대비해 고권한 도구를 막을 때 쓴다. */
  actAs?: boolean;
};

// ── 인증 결과 TTL 캐시 ──
// HTTP transport 는 도구 호출 1건 = 요청 1건 = validate_mcp_key RPC 1회.
// 챗봇 ReAct 루프(여러 도구)·여러 사용자가 몰리면 같은 key 로 RPC 가 다발 →
// 짧은 TTL 캐시로 DB 왕복을 줄인다. (key revoke 반영 지연은 최대 TTL 초)
const AUTH_CACHE_TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS ?? 60_000);
const AUTH_CACHE_MAX = 500; // hard cap 백스톱 — key 회전이 많아도 무한 증가 방지(B-15)
const _authCache = new Map<string, { auth: AuthContext; expiresAt: number }>();

/** 만료 항목 제거 + cap 초과 시 가장 오래된 것부터 정리 (단일 인스턴스 in-memory 캐시 누수 방지). */
function setAuthCache(key: string, auth: AuthContext): void {
  const now = Date.now();
  for (const [k, v] of _authCache) if (v.expiresAt <= now) _authCache.delete(k);
  while (_authCache.size >= AUTH_CACHE_MAX) {
    const oldest = _authCache.keys().next().value; // Map 삽입 순서 = 오래된 것 먼저
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

  // Day 1 호환: 단일 dev key — **stdio(로컬 dev) 전용**.
  // HTTP(production)에선 비활성(P2): 정적 문자열 1개가 감사 식별자 없는 admin 백도어가 되므로,
  // 프로덕션 인증은 mcp_keys(해시 저장·revoke·expiry) 경로만 허용한다.
  const devKey = process.env.MCP_DEV_KEY;
  const transport = (process.env.MCP_TRANSPORT || 'http').toLowerCase();
  if (devKey && transport === 'stdio' && timingSafeEqualStr(key, devKey)) {
    return {
      ok: true,
      org_id: getConfig().orgId,
      role: 'admin',
      email: 'dev@local',
    };
  }

  // 캐시 hit (성공 결과만 캐시 — 실패는 매번 재검증해 빠른 키 활성화 반영)
  const cached = _authCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.auth;
  }

  // Day 2+: Supabase mcp_keys 테이블 lookup via validate_mcp_key RPC
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc('validate_mcp_key', {
      p_key: key,
    });

    if (error) {
      return {
        ok: false,
        reason: `validate_mcp_key RPC failed: ${error.message}`,
      };
    }
    if (!data || (Array.isArray(data) && data.length === 0)) {
      return { ok: false, reason: 'validate_mcp_key returned no row' };
    }

    // RPC 가 table 반환 → 첫 row
    const row = Array.isArray(data) ? data[0] : data;

    if (!row.ok) {
      return { ok: false, reason: row.reason ?? 'auth failed' };
    }

    const auth: AuthContext = {
      ok: true,
      org_id: row.org_id ?? getConfig().orgId,
      role: (row.role as Role) ?? 'viewer',
      email: row.email ?? undefined,
      key_id: row.key_id ?? undefined,
    };
    setAuthCache(key, auth);
    return auth;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `auth error: ${msg}` };
  }
}

/**
 * 도구별 role 가드. 예: read_secret 은 admin 만.
 *
 * 사용 예:
 *   if (!requireRole(auth, 'admin', 'engineer')) {
 *     return errorResponse('forbidden — role insufficient');
 *   }
 */
export function requireRole(auth: AuthContext, ...allowed: Role[]): boolean {
  if (!auth.ok || !auth.role) return false;
  return allowed.includes(auth.role);
}
