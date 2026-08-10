/**
 * OAuth 2.1 Authorization Server + Resource Server (Route X) — Claude 앱 커스텀 커넥터용.
 *
 * 우리 MCP 서버가 AS 이자 RS(같은 프로세스)다:
 *   - AS: /authorize·/token·/register(.well-known 메타) 는 SDK `mcpAuthRouter` 가 깔고,
 *         실제 로직은 이 파일의 `KnowledgeOAuthProvider`(OAuthServerProvider 구현)가 담당.
 *   - 로그인: Google Workspace(OIDC)로 브리지. hd(허용 도메인) + email allowlist 로 조직 제한.
 *   - 토큰: access/refresh 를 HS256 JWT 로 자체 발급(AS=RS 라 JWKS 배포 불필요, 대칭키로 in-process 검증).
 *           access token 의 aud = canonical resource(=우리 /mcp). RFC 8707.
 *   - PKCE(S256): SDK token 핸들러가 challengeForAuthorizationCode() 로 받아 자체 검증.
 *
 * graceful: 필수 env 가 없으면 isOAuthConfigured()=false → index.ts 가 라우터를 안 깐다(기존 Bearer 무손상).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { getSupabase } from './supabase.js';
import { getConfig } from './config.js';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

// ── 설정 (env) ──
const ISSUER = (process.env.MCP_OAUTH_ISSUER || '').replace(/\/$/, ''); // e.g. https://mcp.example.com
const RESOURCE = (process.env.MCP_RESOURCE || (ISSUER ? `${ISSUER}/mcp` : '')).replace(/\/$/, ''); // canonical, = token aud
// 로그인 브리지용 Google 클라이언트. 전용 OAUTH_GOOGLE_* 우선, 없으면 기존 Drive용 GOOGLE_OAUTH_* 재사용.
const GOOGLE_CLIENT_ID = process.env.OAUTH_GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.OAUTH_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const JWT_SECRET = process.env.OAUTH_JWT_SECRET || '';
const ALLOWED_HD = process.env.OAUTH_ALLOWED_HD || getConfig().oauth.allowedDomains[0] || '';
const ALLOWED_EMAILS = (
  process.env.OAUTH_ALLOWED_EMAILS ? process.env.OAUTH_ALLOWED_EMAILS.split(',') : getConfig().oauth.allowedEmails
)
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/**
 * 계정 허용 판정 — allowlist 있으면 그 목록만, 없으면 hd 도메인.
 * 로그인뿐 아니라 **토큰 검증·refresh 마다 재확인**해서, allowlist 에서 빠진 계정은
 * 기존 토큰(특히 30일 refresh)이 남아 있어도 즉시 차단되도록 한다(보안 감사 P1 수정).
 */
function emailAllowed(email: string): boolean {
  const e = (email || '').toLowerCase();
  if (!e) return false;
  if (ALLOWED_EMAILS.length > 0) return ALLOWED_EMAILS.includes(e);
  return ALLOWED_HD ? e.endsWith(`@${ALLOWED_HD.toLowerCase()}`) : true;
}

const GOOGLE_CALLBACK = ISSUER ? `${ISSUER}/oauth/google/callback` : '';
const SCOPE = 'mcp';
const ACCESS_TTL = 3600; // 1h
const REFRESH_TTL = 30 * 24 * 3600; // 30d
const CODE_TTL = 300; // 5m
const STATE_TTL = 600; // 10m

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/** OAuth 활성 조건 — 필수 env 가 모두 있어야 함. 없으면 index 가 라우터 미장착(기존 Bearer 유지). */
export function isOAuthConfigured(): boolean {
  return Boolean(ISSUER && RESOURCE && GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && JWT_SECRET.length >= 32);
}

export const OAUTH_ISSUER_URL = ISSUER;
export const OAUTH_RESOURCE = RESOURCE;
export const OAUTH_SCOPES = [SCOPE];

const jwtKey = () => new TextEncoder().encode(JWT_SECRET);

// ── in-memory 스토어 (단일 replica·짧은 TTL 이라 충분. 재시작 시 코드/상태는 휘발, JWT 는 무상태) ──
interface AuthCodeEntry {
  codeChallenge: string;
  clientId: string;
  redirectUri: string;
  email: string;
  scopes: string[];
  resource?: string;
  exp: number;
}
interface GooglePending {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  clientState?: string;
  scopes: string[];
  resource?: string;
  exp: number;
}

const _authCodes = new Map<string, AuthCodeEntry>();
const _googlePending = new Map<string, GooglePending>();

function sweep<T extends { exp: number }>(m: Map<string, T>): void {
  const now = Date.now() / 1000;
  for (const [k, v] of m) if (v.exp <= now) m.delete(k);
}

// ── 클라이언트 스토어 (DCR — Claude/ChatGPT 자동 등록) ──
// DB 영속화((config.data.schema).mcp_oauth_clients) + 인메모리 캐시.
// 왜: 예전 순수 인메모리 Map 은 서버 재시작(재배포)마다 등록 클라이언트를 통째로 잃어, 커넥터가
//     옛 client_id 로 재접속 시 "invalid_client" 를 냈다(특히 ChatGPT — 자동 재등록 안 함). DB 를
//     정본으로 두면 재시작에도 살아남는다. 캐시는 핫패스(매 authorize/token 의 getClient)용.
// graceful: DB 불가(마이그레이션 전 배포·일시 장애)면 캐시로 폴백 → 그 프로세스 세션 동안만 유효
//           (기존 인메모리 동작과 동일). 배포 순서에 안전 — 테이블 없어도 안 깨진다.
const CLIENTS_SCHEMA = getConfig().data.schema;
const CLIENTS_TABLE = 'mcp_oauth_clients';

class ClientsStore implements OAuthRegisteredClientsStore {
  private cache = new Map<string, OAuthClientInformationFull>();
  private static readonly CACHE_MAX = 500; // 캐시 cap — 정본은 DB 라 evict 돼도 재조회로 복구(안전)

  private putCache(client: OAuthClientInformationFull): void {
    while (this.cache.size >= ClientsStore.CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(client.client_id, client);
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const cached = this.cache.get(clientId);
    if (cached) return cached;
    try {
      const { data, error } = await getSupabase()
        .schema(CLIENTS_SCHEMA)
        .from(CLIENTS_TABLE)
        .select('client_data')
        .eq('client_id', clientId)
        .maybeSingle();
      if (error) {
        console.error('[oauth] client 조회 실패(캐시 폴백):', error.message);
        return undefined;
      }
      if (!data) return undefined;
      const client = data.client_data as OAuthClientInformationFull;
      this.putCache(client);
      // last_used 갱신 (best-effort — cleanup 판단용, 실패 무시)
      void getSupabase()
        .schema(CLIENTS_SCHEMA)
        .from(CLIENTS_TABLE)
        .update({ last_used_at: new Date().toISOString() })
        .eq('client_id', clientId)
        .then(({ error: e }) => {
          if (e) console.error('[oauth] client last_used 갱신 실패:', e.message);
        });
      return client;
    } catch (e) {
      console.error('[oauth] client 조회 예외(캐시 폴백):', e instanceof Error ? e.message : e);
      return undefined;
    }
  }

  // register 핸들러가 client_id/secret 를 이미 생성해 넘김 → 캐시 + DB 저장.
  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    this.putCache(client); // 즉시 사용 가능
    try {
      const { error } = await getSupabase()
        .schema(CLIENTS_SCHEMA)
        .from(CLIENTS_TABLE)
        .upsert(
          {
            client_id: client.client_id,
            client_data: client,
            client_name: typeof client.client_name === 'string' ? client.client_name : null,
            last_used_at: new Date().toISOString(),
          },
          { onConflict: 'client_id' },
        );
      // fail-open: DB 저장 실패해도 등록은 성공(그 세션 동안 캐시로 유효). 커넥터 설정을 하드 실패시키는
      // 것보단 낫다(DB 장애는 드묾). 경고 로그로 노출 — 재시작 시 유실될 수 있음.
      if (error) console.error('[oauth] client 저장 실패(메모리만 유지, 재시작 시 유실 가능):', error.message);
    } catch (e) {
      console.error('[oauth] client 저장 예외(메모리만 유지):', e instanceof Error ? e.message : e);
    }
    return client;
  }
}

// ── Google id_token 검증 (hd + email allowlist 로 사내 제한) ──
async function verifyGoogleIdToken(idToken: string): Promise<{ email: string; hd?: string }> {
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: GOOGLE_CLIENT_ID,
    algorithms: ['RS256'], // alg 고정 (defense-in-depth)
  });
  const email = String(payload.email || '').toLowerCase();
  const hd = payload.hd ? String(payload.hd) : undefined;
  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (!email || !emailVerified) throw new Error('google: email 미검증');
  // 사내 도메인 제한 (hd 클레임 서버 재검증 — hd 파라미터는 힌트일 뿐이라 신뢰 불가)
  if (ALLOWED_HD && hd !== ALLOWED_HD) throw new Error(`google: 허용되지 않은 도메인(hd=${hd ?? 'none'})`);
  if (!emailAllowed(email)) throw new Error('google: allowlist 외 계정');
  return { email, hd };
}

// ── refresh token 상태 (DB: (config.data.schema).mcp_refresh_tokens) ──
// 왜: HS256 JWT 는 무상태라 rotation 해도 옛 refresh 가 만료(30일)까지 유효했다(P2 — 탈취 시 차단 불가).
// jti 를 DB 로 추적해 rotation 시 옛 토큰을 즉시 폐기하고, 폐기된 토큰 재사용(탈취 신호)이 오면
// 그 계정의 활성 refresh 전부를 강제 폐기한다. access token(1h)은 무상태 유지 — 요청 지연 없음.
const REFRESH_SCHEMA = getConfig().data.schema;
const REFRESH_TABLE = 'mcp_refresh_tokens';

/** 발급한 refresh jti 기록. 만료 row 도 김에 정리(테이블 미니 유지). 실패 시 throw — 기록 안 된 토큰은 refresh 불가라 발급 자체를 실패시킨다. */
async function recordRefreshToken(jti: string, email: string, clientId: string): Promise<void> {
  const sb = getSupabase().schema(REFRESH_SCHEMA);
  const { error } = await sb.from(REFRESH_TABLE).insert({
    jti,
    email: email.toLowerCase(),
    client_id: clientId,
    expires_at: new Date(Date.now() + REFRESH_TTL * 1000).toISOString(),
  });
  if (error) throw new Error(`refresh 토큰 기록 실패: ${error.message}`);
  // 만료분 정리 (best-effort)
  void sb.from(REFRESH_TABLE).delete().lt('expires_at', new Date().toISOString())
    .then(({ error: e }) => { if (e) console.error('[oauth] refresh 만료분 정리 실패:', e.message); });
}

/** 계정의 활성 refresh 전부 폐기 — 폐기된 토큰 재사용(탈취 신호) 시 발동. */
async function revokeAllRefreshForEmail(email: string): Promise<void> {
  const { error } = await getSupabase()
    .schema(REFRESH_SCHEMA)
    .from(REFRESH_TABLE)
    .update({ revoked_at: new Date().toISOString() })
    .eq('email', email.toLowerCase())
    .is('revoked_at', null);
  if (error) console.error('[oauth] 계정 refresh 일괄 폐기 실패:', error.message);
}

/**
 * refresh jti 소비(rotation) — 활성 row 만 원자적으로 폐기 표시.
 *   'ok'      : 정상 — 폐기 완료, 새 토큰 발급 진행
 *   'reused'  : 이미 폐기된 jti 재사용(탈취 신호) → 계정 전체 refresh 폐기됨
 *   'unknown' : 기록에 없음(구형 토큰·DB 유실) → 거부(재로그인)
 * DB 오류는 throw — fail-closed (revocation 체크를 못 하면 refresh 를 내주지 않는다).
 */
async function consumeRefreshToken(jti: string, email: string, rotatedTo: string): Promise<'ok' | 'reused' | 'unknown'> {
  const sb = getSupabase().schema(REFRESH_SCHEMA);
  // 활성(미폐기) row 만 update — 동시 refresh 경쟁에서도 한 쪽만 성공(원자성).
  const { data, error } = await sb
    .from(REFRESH_TABLE)
    .update({ revoked_at: new Date().toISOString(), rotated_to: rotatedTo })
    .eq('jti', jti)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('jti');
  if (error) throw new Error(`refresh 상태 확인 실패: ${error.message}`);
  if (data && data.length > 0) return 'ok';

  // 활성 row 가 없음 — 폐기된 jti 인지(재사용) vs 아예 없는지 구분
  const { data: row, error: e2 } = await sb.from(REFRESH_TABLE).select('jti').eq('jti', jti).maybeSingle();
  if (e2) throw new Error(`refresh 상태 확인 실패: ${e2.message}`);
  if (row) {
    console.error(`[oauth] ⚠️ 폐기된 refresh 재사용 감지 — ${email} 의 활성 refresh 전부 폐기`);
    await revokeAllRefreshForEmail(email);
    return 'reused';
  }
  return 'unknown';
}

async function signJwt(claims: Record<string, unknown>, ttl: number, typ: 'access' | 'refresh'): Promise<string> {
  return new SignJWT({ ...claims, typ })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(RESOURCE)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(jwtKey());
}

export class KnowledgeOAuthProvider implements OAuthServerProvider {
  private _clients = new ClientsStore();
  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clients;
  }
  // PKCE 는 우리(AS)가 자체 검증 (Google 으로 넘기지 않음)
  skipLocalPkceValidation = false;

  /** authorize: Google 로그인으로 브리지. 우리 code 는 Google 콜백에서 발급. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    sweep(_googlePending);
    const state = randomBytes(24).toString('base64url');
    _googlePending.set(state, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      clientState: params.state,
      scopes: params.scopes && params.scopes.length ? params.scopes : [SCOPE],
      resource: params.resource?.href,
      exp: Date.now() / 1000 + STATE_TTL,
    });
    const u = new URL(GOOGLE_AUTH_URL);
    u.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    u.searchParams.set('redirect_uri', GOOGLE_CALLBACK);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('access_type', 'online');
    u.searchParams.set('prompt', 'select_account');
    if (ALLOWED_HD) u.searchParams.set('hd', ALLOWED_HD);
    u.searchParams.set('state', state);
    res.redirect(u.toString());
  }

  /**
   * Google 콜백 처리 (index.ts 의 /oauth/google/callback 라우트가 호출).
   * 성공/실패 모두 client redirect_uri 로 돌려보낼 URL 을 반환한다.
   */
  async completeGoogleLogin(googleCode: string, state: string): Promise<string> {
    sweep(_googlePending);
    const pending = _googlePending.get(state);
    if (!pending) throw new Error('알 수 없거나 만료된 state');
    _googlePending.delete(state);

    const redirectErr = (err: string, desc: string) => {
      const u = new URL(pending.redirectUri);
      u.searchParams.set('error', err);
      u.searchParams.set('error_description', desc);
      if (pending.clientState) u.searchParams.set('state', pending.clientState);
      return u.toString();
    };

    let email: string;
    try {
      // Google code → id_token 교환
      const body = new URLSearchParams({
        code: googleCode,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_CALLBACK,
        grant_type: 'authorization_code',
      });
      const r = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const j = (await r.json()) as { id_token?: string; error?: string; error_description?: string };
      if (!r.ok || !j.id_token) throw new Error(j.error_description || j.error || `google token ${r.status}`);
      ({ email } = await verifyGoogleIdToken(j.id_token));
    } catch (e) {
      return redirectErr('access_denied', e instanceof Error ? e.message : '로그인 실패');
    }

    // 우리 authorization code 발급 (one-time, 짧은 TTL)
    sweep(_authCodes);
    const code = randomBytes(24).toString('base64url');
    _authCodes.set(code, {
      codeChallenge: pending.codeChallenge,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      email,
      scopes: pending.scopes,
      resource: pending.resource,
      exp: Date.now() / 1000 + CODE_TTL,
    });
    const u = new URL(pending.redirectUri);
    u.searchParams.set('code', code);
    if (pending.clientState) u.searchParams.set('state', pending.clientState);
    return u.toString();
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const entry = _authCodes.get(authorizationCode);
    if (!entry || entry.exp <= Date.now() / 1000) throw new Error('invalid_grant: 코드 없음/만료');
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string, // SDK 가 challengeForAuthorizationCode 와 PKCE 검증 완료
    redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const entry = _authCodes.get(authorizationCode);
    if (!entry || entry.exp <= Date.now() / 1000) throw new Error('invalid_grant: 코드 없음/만료');
    _authCodes.delete(authorizationCode); // one-time
    if (entry.clientId !== client.client_id) throw new Error('invalid_grant: client 불일치');
    if (redirectUri && redirectUri !== entry.redirectUri) throw new Error('invalid_grant: redirect_uri 불일치');

    const scope = entry.scopes.join(' ') || SCOPE;
    const claims = { sub: entry.email, email: entry.email, scope, client_id: client.client_id };
    const access_token = await signJwt(claims, ACCESS_TTL, 'access');
    // refresh 는 jti 발급 + DB 기록 — rotation 시 즉시 폐기 가능하게 (P2)
    const jti = randomUUID();
    const refresh_token = await signJwt({ ...claims, jti }, REFRESH_TTL, 'refresh');
    await recordRefreshToken(jti, entry.email, client.client_id);
    return { access_token, token_type: 'Bearer', expires_in: ACCESS_TTL, scope, refresh_token };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    let email = '';
    let jti = '';
    try {
      const { payload } = await jwtVerify(refreshToken, jwtKey(), {
        issuer: ISSUER,
        audience: RESOURCE,
        algorithms: ['HS256'],
      });
      if (payload.typ !== 'refresh') throw new Error('not a refresh token');
      email = String(payload.email || payload.sub || '');
      jti = typeof payload.jti === 'string' ? payload.jti : '';
    } catch {
      throw new Error('invalid_grant: refresh token 무효');
    }
    // P1: refresh 시 allowlist 재확인 — 빠진 계정은 30일 refresh 가 남아도 즉시 차단.
    if (!emailAllowed(email)) throw new Error('invalid_grant: 계정이 더 이상 허용되지 않음');
    // P2: jti 없는 구형 refresh 는 거부(재로그인 1회 유도). jti 는 DB 에서 소비(rotation) —
    // 옛 토큰 즉시 폐기, 폐기된 토큰 재사용(탈취 신호)이면 계정 전체 refresh 폐기.
    if (!jti) throw new Error('invalid_grant: refresh token 무효(구형) — 재로그인 필요');
    const newJti = randomUUID();
    const state = await consumeRefreshToken(jti, email, newJti);
    if (state !== 'ok') throw new Error('invalid_grant: refresh token 무효(폐기됨) — 재로그인 필요');

    const scope = (scopes && scopes.length ? scopes.join(' ') : SCOPE);
    const claims = { sub: email, email, scope, client_id: client.client_id };
    const access_token = await signJwt(claims, ACCESS_TTL, 'access');
    const refresh_token = await signJwt({ ...claims, jti: newJti }, REFRESH_TTL, 'refresh'); // rotation
    await recordRefreshToken(newJti, email, client.client_id);
    return { access_token, token_type: 'Bearer', expires_in: ACCESS_TTL, scope, refresh_token };
  }

  /** RS: access token 검증 (requireBearerAuth + 우리 /mcp dual-auth 가 사용) */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { payload } = await jwtVerify(token, jwtKey(), {
      issuer: ISSUER,
      audience: RESOURCE,
      algorithms: ['HS256'], // alg 고정 (none/RS256 confusion 차단)
    });
    if (payload.typ === 'refresh') throw new Error('refresh token 으로 접근 불가');
    const email = typeof payload.sub === 'string' ? payload.sub : '';
    // P1: 매 요청 allowlist 재확인 — allowlist 에서 빠지면 미만료 토큰도 즉시 거부.
    if (!emailAllowed(email)) throw new Error('계정이 더 이상 허용되지 않음');
    const scopes = String(payload.scope || '').split(' ').filter(Boolean);
    return {
      token,
      clientId: String(payload.client_id || ''),
      scopes,
      expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
      resource: new URL(RESOURCE),
      extra: { email, hd: ALLOWED_HD },
    };
  }
}

export const oauthProvider = new KnowledgeOAuthProvider();
