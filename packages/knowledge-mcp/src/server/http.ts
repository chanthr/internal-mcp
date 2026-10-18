/**
 * Streamable HTTP transport (default). Express app with:
 *   - POST/GET/DELETE /mcp — Authorization: Bearer <API key or OAuth access token>, checked on every request
 *   - GET /health          — no auth
 *   - OAuth 2.1 routes      — only when OAuth is configured (oauth.ts)
 *
 * The auth context reaches tool handlers through AsyncLocalStorage (context.ts).
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request as ExpressRequest, type Response as ExpressResponse } from 'express';
import rateLimit from 'express-rate-limit';
import { randomUUID, createHash } from 'crypto';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';

import { authenticateApiKey, type AuthContext, type Role, type ResourceScopes } from '../core/auth.js';
import { authStore } from '../core/context.js';
import {
  oauthProvider, isOAuthConfigured, oauthConfigProblems, oauthAttempted,
  OAUTH_ISSUER_URL, OAUTH_RESOURCE, OAUTH_SCOPES, CONSENT_COOKIE, CONSENT_PATH, LOGIN_COOKIE, GOOGLE_CALLBACK_PATH,
} from '../core/oauth.js';
import { maskedSecretCount } from '../core/log_mask.js';
import { getConfig, configSource } from '../core/config.js';
import { getStore } from '../store/index.js';
import { VERSION } from '../version.js';
import type { Registry } from '../plugin/registry.js';
import { resolveUser } from './identity.js';
import { createMcpServer } from './mcp.js';

// Claude.ai 웹 커넥터는 브라우저에서 직접 /mcp 를 호출 → CORS 필요. 허용 Origin allowlist(env override).
const MCP_CORS_ORIGINS = (process.env.MCP_CORS_ORIGINS || 'https://claude.ai,https://claude.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// act-as 위임 — 이 key_id(신뢰하는 프록시 키)들에서만 X-MCP-Act-As-Email 을 믿고, 그 사람의 권한으로
// 낮춰 적용한다(최대 member). 일반 키엔 영향 0. 헤더 role 은 믿지 않고 users 에서 서버가 다시 계산한다(위조 차단).
// 헤더가 없으면 viewer 로 낮춘다(fail-safe).
const ACT_AS_ALLOWED_KEY_IDS = new Set(
  (process.env.ACT_AS_ALLOWED_KEY_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** /mcp 응답에 CORS 헤더 부착(허용 Origin 일 때만). 비브라우저 클라이언트(Origin 없음)는 무영향. */
function applyMcpCors(req: ExpressRequest, res: ExpressResponse): void {
  const origin = req.headers.origin;
  if (origin && MCP_CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id',
    );
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

/**
 * 고권한 secret 의 fingerprint(sha256 앞 8자)만 부팅 시 로깅 — 값은 절대 노출하지 않는다(S1).
 * 회전 후 "새 키로 떴는지" 운영이 한눈에 확인하는 용도. fingerprint 가 그대로면 회전 미반영.
 */
function logSecretFingerprints(): void {
  const KEYS = [
    'SUPABASE_SERVICE_ROLE_KEY', 'OAUTH_JWT_SECRET',
    'GITHUB_PAT', 'GITHUB_TOKEN', 'RAILWAY_MCP_TOKEN',
    'SLACK_USER_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_TOKEN',
  ];
  const fp = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 8);
  const parts = KEYS.filter((k) => process.env[k]).map((k) => `${k}=${fp(process.env[k]!)}`);
  if (parts.length) console.error(`[secrets] fingerprints(sha256/8): ${parts.join(' ')}`);
}

/** 요청의 쿠키 하나를 읽는다(없으면 ''). */
function readCookie(req: ExpressRequest, name: string): string {
  const hit = String(req.headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : '';
}

/** TRUST_PROXY env → express 'trust proxy' 값. 숫자=홉 수, true/false, 그 밖=서브넷 목록 문자열. */
function trustProxySetting(): number | boolean | string {
  const v = (process.env.TRUST_PROXY ?? '1').trim();
  if (/^\d+$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

export async function runHttp(registry: Registry): Promise<{ port: number; close: () => Promise<void> }> {
  // 어떤 플러그인이 켜졌는지(자격증명 갖춰진 것만), 어느 저장소를 쓰는지 부팅 시 1줄 로그 — ops 가시성.
  const store = await getStore();
  console.error(`[knowledge-mcp] config=${configSource()} · store=${store.kind} (${store.location}) · plugins · ${registry.summary()}`);
  console.error(`[log-mask] env 시크릿 ${maskedSecretCount()}개 + 일반 패턴 마스킹 중`);
  if (configSource() === 'defaults') {
    console.error(
      '[knowledge-mcp] ⚠️ no config found, running on defaults (no Drive roots, no excluded folders, no login allowlist). ' +
        'Set MCP_CONFIG_JSON or put mcp.config.json in the working directory (/app/mcp.config.json in the container).',
    );
  }
  logSecretFingerprints(); // 고권한 키 fingerprint(값 비노출) — 회전 검증용 (S1)

  const app = express();
  // 프록시 뒤라면 X-Forwarded-For 를 몇 홉까지 믿을지. 기본 1(Railway·Fly·Cloud Run 같은 앞단 프록시 1개).
  // 프록시 없이 직접 노출하면 TRUST_PROXY=false 로 — 그래야 클라이언트가 보낸 헤더로 IP 를 바꿔 한도를 피하지 못한다.
  app.set('trust proxy', trustProxySetting());
  app.use(express.json({ limit: '4mb' }));

  // Health check — 인증 X
  app.get('/health', (_req, res) => {
    res.json({ ok: true, server: 'knowledge-mcp', version: VERSION });
  });

  // ── OAuth 2.1 (Claude 앱 커스텀 커넥터용) — env 갖춰졌을 때만 (없으면 기존 Bearer 만) ──
  const oauthEnabled = isOAuthConfigured();
  let resourceMetadataUrl: string | undefined;
  if (oauthEnabled) {
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(OAUTH_RESOURCE));
    const secureCookie = OAUTH_ISSUER_URL.startsWith('https://') ? '; Secure' : '';
    // Google 로그인 콜백 — 우리 AS 가 Google(OIDC)로 브리지 후 client 로 우리 code 발급.
    // 동의를 승인한 브라우저의 로그인 쿠키가 있어야 한다(oauth.ts consumeConsent 설명).
    app.get(GOOGLE_CALLBACK_PATH, async (req, res) => {
      const q = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : '');
      const state = q('state');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Set-Cookie', `${LOGIN_COOKIE}=; Path=${GOOGLE_CALLBACK_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secureCookie}`);
      if (!state) {
        res.status(400).type('text').send('missing state');
        return;
      }
      try {
        const url = await oauthProvider.completeGoogleLogin({
          code: q('code') || undefined,
          error: q('error') || undefined,
          state,
          binding: readCookie(req, LOGIN_COOKIE),
        });
        res.redirect(url);
      } catch (e) {
        res.status(400).type('text').send(`OAuth sign-in error: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    // AS 엔드포인트 + .well-known(authorize·token·register·AS메타·PRM). 루트에 장착.
    app.use(
      mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: new URL(OAUTH_ISSUER_URL),
        scopesSupported: OAUTH_SCOPES,
        resourceName: getConfig().branding.name,
        resourceServerUrl: new URL(OAUTH_RESOURCE),
      }),
    );
    // 동의 화면의 승인/취소 — oauth.ts consumeConsent. 쿠키(SameSite=Lax)와 폼 csrf 가 모두 맞아야 진행.
    app.post(CONSENT_PATH, express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const cookies = [`${CONSENT_COOKIE}=; Path=${CONSENT_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secureCookie}`];
      res.setHeader('Cache-Control', 'no-store');
      try {
        const { redirect, loginBinding } = oauthProvider.consumeConsent(
          String(body.id ?? ''),
          String(body.csrf ?? ''),
          readCookie(req, CONSENT_COOKIE),
          body.action === 'approve',
        );
        // Google 다녀오는 동안 이 브라우저임을 증명할 쿠키. SameSite=Lax 라 Google 에서 돌아오는 최상위 이동에 실린다.
        if (loginBinding) {
          cookies.push(`${LOGIN_COOKIE}=${loginBinding}; Path=${GOOGLE_CALLBACK_PATH}; Max-Age=600; HttpOnly; SameSite=Lax${secureCookie}`);
        }
        res.setHeader('Set-Cookie', cookies);
        res.redirect(redirect);
      } catch (e) {
        res.setHeader('Set-Cookie', cookies);
        res.status(400).type('text').send(e instanceof Error ? e.message : String(e));
      }
    });
    console.error(
      `[knowledge-mcp] OAuth enabled · issuer=${OAUTH_ISSUER_URL} · resource=${OAUTH_RESOURCE}`,
    );
  } else if (oauthAttempted()) {
    // 반쯤 설정된 상태는 조용히 끄지 않고 빠진 값을 이름으로 알린다(값은 노출 안 함).
    console.error(`[knowledge-mcp] ⚠️ OAuth off — missing: ${oauthConfigProblems().join(', ')}`);
  } else {
    console.error('[knowledge-mcp] OAuth 미설정 (Bearer 전용)');
  }

  // CORS preflight — Claude.ai 웹 커넥터 브라우저 요청용.
  app.options('/mcp', (req, res) => {
    applyMcpCors(req, res);
    res.status(204).end();
  });

  // GET(SSE 상시 스트림)·DELETE(세션 종료) 는 아래 rate-limit 정의 후 세션 라우팅 핸들러로 등록한다
  // (하이브리드 stateful — 활성 세션이 있을 때만 그 transport 로 처리, 없으면 405).

  // ── /mcp rate-limit (S2) ── IP 기준(trust proxy 1 로 req.ip 정확). 한도는 env override.
  // 목적: 잘못된 키 폭주가 validate_mcp_key RPC 를 증폭(DB 부하·비용)시키는 것 차단 + 일반 abuse 완화.
  // 2단: ① 전체 넉넉한 한도(정상 챗봇/IDE 무영향) ② 인증 실패(401)에만 더 강한 한도.
  const RL_WINDOW_MS = Number(process.env.MCP_RATE_LIMIT_WINDOW_MS ?? 60_000);
  const rlHandler =
    (status: number, message: string) => (req: ExpressRequest, res: ExpressResponse) => {
      applyMcpCors(req, res);
      res.status(status).json({ jsonrpc: '2.0', error: { code: -32029, message }, id: null });
    };
  const mcpRateLimit = rateLimit({
    windowMs: RL_WINDOW_MS,
    limit: Number(process.env.MCP_RATE_LIMIT_MAX ?? 120),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: rlHandler(429, 'rate limit exceeded — slow down'),
  });
  const mcpAuthFailRateLimit = rateLimit({
    windowMs: RL_WINDOW_MS,
    limit: Number(process.env.MCP_RATE_LIMIT_FAIL_MAX ?? 20),
    // 401 만 센다 — 재배포 뒤 세션 만료(404), 세션 없는 GET(405), 끊긴 SSE 까지 "인증 실패"로 세면
    // 같은 출구 IP(사내 NAT 등)의 정상 사용자가 함께 429 를 받는다.
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: rlHandler(429, 'too many failed auth attempts — slow down'),
  });

  // ── 인증 해석 (POST·GET·DELETE 공용) ──
  // 세션 방식이어도 인증은 매 요청 수행한다(권한을 세션에 묶지 않음 — 세션ID 가 유출돼도 각 요청의
  // Bearer/OAuth 토큰으로 재인증하므로 세션 하이재킹으로 권한 상승 불가). ok:false 면 send401.
  const extractKey = (req: ExpressRequest): { key?: string; looksJwt: boolean } => {
    const authHeader = req.headers.authorization;
    const key = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
    return { key, looksJwt: !!key && key.split('.').length === 3 };
  };
  const resolveAuth = async (req: ExpressRequest): Promise<AuthContext> => {
    const { key, looksJwt } = extractKey(req);
    let auth: AuthContext;
    // dual-auth (순서 최적화): OAuth access token 은 JWT(점 3개) → 로컬 HS256 검증을 *먼저*.
    // 기존 mcp_key/dev key 는 JWT 형식 아니라 충돌 없음. 커넥터(OAuth) 호출이 validate_mcp_key RPC 를
    // 헛왕복(매번 실패, 캐시 안 됨)하지 않게 한다 — 호출 지연·DB 부하 제거.
    if (oauthEnabled && looksJwt) {
      try {
        const info = await oauthProvider.verifyAccessToken(key!);
        const oauthEmail = typeof info.extra?.email === 'string' ? info.extra.email : undefined;
        // OAuth 사용자도 app_users role 반영(act-as 와 일관). email 은 Google 로그인+allowlist 검증값이라
        // 신뢰. 없음/미등록/조회 실패 → viewer (P2 — 미등록 계정에 PII 도구 미개방).
        let oauthRole: Role = 'viewer';
        let oauthScopes: ResourceScopes | undefined;
        if (oauthEmail) {
          const r = await resolveUser(info.clientId ?? 'oauth', oauthEmail);
          oauthRole = r.role;
          oauthScopes = r.scopes;
        }
        auth = {
          ok: true, org_id: getConfig().orgId, role: oauthRole,
          email: oauthEmail, key_id: info.clientId, scopes: oauthScopes,
        };
      } catch {
        auth = { ok: false, reason: 'invalid oauth token' };
      }
    } else {
      // 기존 Bearer 경로(IDE·내부 프록시·dev key)
      auth = await authenticateApiKey(key);
      // 직접 키(IDE)도 직원 email 로 role+scope 를 app_users 에서 재계산(act-as·OAuth 와 통일).
      // P1: role 도 재계산해 퇴사·강등 즉시 반영(옛 구멍: revoke 전까지 admin 유지). dev key 는 제외.
      if (auth.ok && auth.email && auth.email !== 'dev@local') {
        const { role, scopes } = await resolveUser(auth.key_id ?? 'direct', auth.email);
        auth = { ...auth, role, scopes };
      }
    }
    if (!auth.ok) return auth;
    // ── act-as (내부 프록시 → 로그인 직원 권한 전파) ──
    // 위임 key_id 일 때만. 헤더 role 은 안 읽고 app_users 서버 재계산(위조 방지). 헤더 없으면 viewer.
    if (auth.key_id && ACT_AS_ALLOWED_KEY_IDS.has(auth.key_id)) {
      const hdr = req.headers['x-mcp-act-as-email'];
      const actAsEmail = typeof hdr === 'string' ? hdr.trim() : '';
      if (!actAsEmail) {
        auth = { ...auth, role: 'viewer', email: undefined, actAs: true };
      } else {
        const resolved = await resolveUser(auth.key_id, actAsEmail);
        // 프록시는 member 까지만 대신할 수 있다. 프록시 키가 새도 admin 이메일을 대 관리자 권한을 얻지 못한다.
        const role: Role = resolved.role === 'admin' ? 'member' : resolved.role;
        auth = { ...auth, role, email: actAsEmail, scopes: resolved.scopes, actAs: true };
        console.error(`[act-as] key_id=${auth.key_id} email=${actAsEmail} role=${role}${resolved.role === 'admin' ? ' (capped from admin)' : ''}`);
      }
    }
    return auth;
  };
  const send401 = (req: ExpressRequest, res: ExpressResponse, auth: AuthContext): void => {
    const { key, looksJwt } = extractKey(req);
    // OAuth 진입 조건(토큰 없음 또는 JWT)에만 discovery 트리거 헤더 부착(IDE 오유입 방지).
    if (oauthEnabled && resourceMetadataUrl && (!key || looksJwt)) {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"`);
    }
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: `auth failed: ${auth.reason ?? 'unauthorized'}` },
      id: null,
    });
  };

  // ── 세션 스토어 (하이브리드 stateful) ──
  // 왜: Claude·ChatGPT 커스텀 커넥터는 initialize 시 Mcp-Session-Id 를 받고 이후 요청·GET SSE 상시
  // 스트림을 그 세션으로 유지한다. stateless(세션ID 없음)면 GET 스트림이 405 로 막혀 "연결이 자꾸
  // 끊긴다"로 보인다. → initialize 는 세션 생성(Mcp-Session-Id 발급), 이후 요청·GET 을 그 세션 transport
  // 로 라우팅. 세션ID 없는 비-initialize 는 기존 one-shot 클라이언트(IDE·프록시) 보존 위해 stateless 폴백.
  // ⚠️ 인메모리라 단일 replica 전제 — 멀티 replica 는 sticky routing·공유 세션 스토어 필요.
  interface McpSession { transport: StreamableHTTPServerTransport; lastActive: number }
  const sessions = new Map<string, McpSession>();
  const SESSION_IDLE_MS = Number(process.env.MCP_SESSION_IDLE_MS ?? 30 * 60_000);
  const SESSION_MAX = Number(process.env.MCP_SESSION_MAX ?? 1000);
  const dropSession = (sid: string): void => {
    const s = sessions.get(sid);
    if (s) {
      sessions.delete(sid);
      s.transport.close().catch(() => {});
    }
  };
  // 유휴 세션 청소 — DELETE 없이 사라진 커넥터의 세션을 만료(메모리 누수 방지). unref → 프로세스 유지 안 함.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) if (now - s.lastActive > SESSION_IDLE_MS) dropSession(sid);
  }, 5 * 60_000);
  sweeper.unref();

  // GET(SSE 상시 스트림)·DELETE(세션 종료) — 활성 세션이 있을 때만 그 transport 로 라우팅.
  // 세션 없으면 stateless 서버엔 스트림이 없으므로 405(기존 동작 유지).
  const handleSessionStream = async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    applyMcpCors(req, res);
    const auth = await resolveAuth(req);
    if (!auth.ok) return send401(req, res, auth);
    const sidHeader = req.headers['mcp-session-id'];
    const sid = typeof sidHeader === 'string' ? sidHeader : undefined;
    const s = sid ? sessions.get(sid) : undefined;
    if (!s) {
      res.setHeader('Allow', 'POST, OPTIONS');
      res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'no active session for this stream' },
        id: null,
      });
      return;
    }
    s.lastActive = Date.now();
    try {
      await authStore.run(auth, () => s.transport.handleRequest(req, res));
    } catch (e) {
      console.error('[knowledge-mcp] GET/DELETE handler error:', e);
      if (!res.headersSent) res.status(500).end();
    }
  };
  app.get('/mcp', mcpRateLimit, mcpAuthFailRateLimit, handleSessionStream);
  app.delete('/mcp', mcpRateLimit, mcpAuthFailRateLimit, handleSessionStream);

  // MCP endpoint (POST) — 세션 라우팅 + stateless 폴백
  app.post('/mcp', mcpRateLimit, mcpAuthFailRateLimit, async (req, res) => {
    applyMcpCors(req, res);
    const auth = await resolveAuth(req);
    if (!auth.ok) return send401(req, res, auth);

    const sidHeader = req.headers['mcp-session-id'];
    const sid = typeof sidHeader === 'string' ? sidHeader : undefined;

    try {
      // 1) 기존 세션 → 그 transport 로 라우팅 (인증은 위에서 매 요청 수행)
      if (sid) {
        const s = sessions.get(sid);
        if (!s) {
          // 만료/미지 세션 — 클라이언트가 재init 하도록 404
          res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'session not found — reinitialize' },
            id: null,
          });
          return;
        }
        s.lastActive = Date.now();
        await authStore.run(auth, () => s.transport.handleRequest(req, res, req.body));
        return;
      }

      // 2) initialize (세션ID 없음) → 새 stateful 세션 생성 (Mcp-Session-Id 발급)
      if (isInitializeRequest(req.body)) {
        if (sessions.size >= SESSION_MAX) {
          // 백스톱 — 가장 오래된 세션 정리 (무한 증가 방지)
          let oldestSid: string | undefined;
          let oldest = Infinity;
          for (const [k, v] of sessions) if (v.lastActive < oldest) { oldest = v.lastActive; oldestSid = k; }
          if (oldestSid) dropSession(oldestSid);
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSid) => {
            sessions.set(newSid, { transport, lastActive: Date.now() });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        const server = createMcpServer(registry);
        await server.connect(transport);
        await authStore.run(auth, () => transport.handleRequest(req, res, req.body));
        return;
      }

      // 3) stateless 폴백 (비-initialize + 세션ID 없음) — 기존 IDE·프록시 one-shot 보존.
      const server = createMcpServer(registry);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close().catch(() => {});
      });
      await server.connect(transport);
      await authStore.run(auth, () => transport.handleRequest(req, res, req.body));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[knowledge-mcp] /mcp handler error:`, e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: msg },
          id: null,
        });
      }
    }
  });

  // PORT=0 은 빈 포트를 고른다(시험용). 실제 포트는 반환값으로 알린다.
  const wanted = parseInt(process.env.PORT || '8080', 10);
  const httpServer = await new Promise<import('node:http').Server>((resolveListen, rejectListen) => {
    const srv = app.listen(wanted, () => resolveListen(srv));
    srv.once('error', rejectListen);
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : wanted;
  console.error(`[knowledge-mcp] HTTP mode · listening on :${port} · version=${VERSION}`);

  // 외부 연결은 포트를 연 뒤 백그라운드로 — upstream·Qdrant 가 응답하지 않아도 /health 가 먼저 뜬다
  // (예전엔 listen 전에 기다려 healthcheck 시간 안에 포트가 안 열리고 재시작이 반복될 수 있었다).
  // 원격 MCP 는 연결되기 전 tools/list 에서 빠져 있다가, 연결되면 다음 목록부터 나온다.
  void registry.start();

  return {
    port,
    close: () =>
      new Promise<void>((done) => {
        clearInterval(sweeper);
        for (const sid of [...sessions.keys()]) dropSession(sid);
        httpServer.close(() => done());
        httpServer.closeAllConnections?.();
      }),
  };
}

