#!/usr/bin/env node
/**
 * Knowledge MCP Server — entry point.
 *
 * 듀얼 transport:
 *   - MCP_TRANSPORT=http (default, production): Streamable HTTP via Express
 *       - POST /mcp — Authorization: Bearer <key> 헤더 인증
 *       - GET  /health — health check (인증 X)
 *   - MCP_TRANSPORT=stdio (local dev): stdio
 *       - env MCP_API_KEY 로 1회 인증
 *
 * 디자인:
 *   - Per-request 인증 (HTTP) — Express middleware 가 validate_mcp_key RPC 호출
 *   - AsyncLocalStorage 로 auth context 를 tool handler 까지 전달
 *   - Tool handler 는 getAuth() / requireRole() 로 권한 검증
 */
// .env 를 가장 먼저 읽는다. ESM 은 import 한 모듈을 본문보다 먼저 실행하고, oauth·config·qdrant 등이
// import 시점에 process.env 를 읽어 값을 고정하므로, 본문에서 dotenv 를 부르면 .env 값이 무시된다.
import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import express, { type Request as ExpressRequest, type Response as ExpressResponse } from 'express';
import rateLimit from 'express-rate-limit';
import { randomUUID, createHash } from 'crypto';

import { authenticateApiKey, type AuthContext, type Role, type ResourceScopes } from './lib/auth.js';
import { getSupabase } from './lib/supabase.js';
import { logToolCall } from './lib/tool_log.js';
import { authStore, getAuthMaybe, setProcessAuth } from './lib/context.js';
import { isToolAllowed } from './lib/scope.js';
import { pingTool, handlePing } from './tools/ping.js';
import { searchDriveTool, handleSearchDrive } from './tools/search_drive.js';
import { readDriveFileTool, handleReadDriveFile } from './tools/read_drive_file.js';
import { listDriveFolderTool, handleListDriveFolder } from './tools/list_drive_folder.js';
import { semanticSearchDriveTool, handleSemanticSearchDrive } from './tools/semantic_search_drive.js';
import { slackSearchTool, handleSlackSearch } from './tools/slack_search.js';
import { slackReadChannelTool, handleSlackReadChannel } from './tools/slack_read_channel.js';
import {
  slackFindFilesTool, handleSlackFindFiles,
  slackGetFileTool, handleSlackGetFile,
} from './tools/slack_files.js';
import { slackListChannelsTool, handleSlackListChannels } from './tools/slack_list_channels.js';
import { repoTreeTool, handleRepoTree } from './tools/repo_tree.js';
import {
  railwayServicesTool, handleRailwayServices,
  railwayDeploymentsTool, handleRailwayDeployments,
  railwayLogsTool, handleRailwayLogs,
} from './tools/railway.js';
import { upstreamManager } from './lib/mcp_upstream.js';
import { startDriveSyncScheduler } from './lib/drive_sync.js';
import { ensureCollection } from './lib/qdrant.js';
import {
  driveConfigured, semanticConfigured, slackConfigured, slackSearchConfigured,
  githubConfigured, railwayConfigured, capabilitySummary,
} from './lib/capabilities.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import {
  oauthProvider, isOAuthConfigured, oauthConfigProblems, oauthAttempted,
  OAUTH_ISSUER_URL, OAUTH_RESOURCE, OAUTH_SCOPES, CONSENT_COOKIE, CONSENT_PATH,
} from './lib/oauth.js';
import { installLogMasking } from './lib/log_mask.js';
import { getConfig, configSource } from './lib/config.js';

installLogMasking(); // 시크릿 마스킹을 가장 먼저 설치 — 이후 모든 console.* 출력에서 키·토큰 가림

// 단일 replica 최후 안전망 — 잡히지 않은 reject/exception 을 로깅만 하고 프로세스는 유지(fail-open).
// 대부분 경로가 이미 try/catch 지만, 콜백·third-party 누수 1건이 전체를 내리는 것을 방지.
process.on('unhandledRejection', (reason) => {
  console.error(
    '[knowledge-mcp] unhandledRejection:',
    reason instanceof Error ? reason.stack : reason,
  );
});
process.on('uncaughtException', (err) => {
  console.error('[knowledge-mcp] uncaughtException:', err instanceof Error ? err.stack : err);
});

const VERSION = '0.2.0';

// Claude.ai 웹 커넥터는 브라우저에서 직접 /mcp 를 호출 → CORS 필요. 허용 Origin allowlist(env override).
const MCP_CORS_ORIGINS = (process.env.MCP_CORS_ORIGINS || 'https://claude.ai,https://claude.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// act-as 위임 — 이 key_id(내부 프록시 키)들에서만 X-MCP-Act-As-Email 을 신뢰해
// "로그인 직원 권한"으로 강등/적용한다. 일반 키엔 영향 0. 헤더 role 은 신뢰하지 않고
// app_users 에서 서버 재검증(위조 차단). 헤더 없으면 viewer 강등(fail-safe).
const ACT_AS_ALLOWED_KEY_IDS = new Set(
  (process.env.ACT_AS_ALLOWED_KEY_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const ACT_AS_TTL_MS = Number(process.env.ACT_AS_CACHE_TTL_MS ?? 60_000);
const _actAsCache = new Map<string, { role: Role; scopes?: ResourceScopes; expiresAt: number }>();

/**
 * app_users row -> effective role. No row (null) = viewer.
 * Registered users become admin/engineer; unregistered or lookup failure is downgraded to viewer (fail-safe).
 */
function roleFromAppUserRow(row: { role?: string | null } | null | undefined): Role {
  if (!row) return 'viewer';
  return row.role === 'admin' ? 'admin' : 'engineer';
}

/** PostgREST/Postgres 의 "컬럼 없음" 오류인가 — scope 컬럼을 아직 추가하지 않은 옛 스키마 판별용. */
function isMissingColumnError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === '42703' || code === 'PGRST204';
}

/**
 * act-as 대상 직원의 실효 role + 리소스 scope 를 app_users (config.data.schema)에서 서버 재계산.
 * 헤더의 role 은 절대 신뢰하지 않는다(위조 방지). 행 없음 → viewer(기본 거부).
 * scope 컬럼이 아직 DB 에 없으면(옛 스키마) role 만 얻고 scope 는 undefined(미설정).
 * 그 밖의 조회 실패(타임아웃·네트워크)는 권한을 넓히지 않는다 — viewer 로 두고 캐시하지 않는다(fail-closed).
 * 같은 Supabase 프로젝트라 service-role 로 직접 읽는다. 짧은 TTL 캐시(키 key_id:email).
 */
async function resolveActAsAuth(
  keyId: string,
  email: string,
): Promise<{ role: Role; scopes?: ResourceScopes }> {
  const cacheKey = `${keyId}:${email.toLowerCase()}`;
  const now = Date.now();
  const cached = _actAsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return { role: cached.role, scopes: cached.scopes };

  let role: Role = 'viewer';
  let scopes: ResourceScopes | undefined;
  let cacheable = true;
  try {
    // role + scope 컬럼 한 쿼리. scope 컬럼이 아직 없으면 error → catch 로 graceful.
    const { data, error } = await getSupabase()
      .schema(getConfig().data.schema)
      .from('app_users')
      .select('role, allowed_slack_channels, allowed_drive_folders, allowed_tools')
      .eq('email', email.toLowerCase())
      .maybeSingle();
    if (error) throw error;
    role = roleFromAppUserRow(data);
    scopes = data
      ? {
          slackChannels: (data.allowed_slack_channels as string[] | null) ?? null,
          driveFolders: (data.allowed_drive_folders as string[] | null) ?? null,
          tools: (data.allowed_tools as string[] | null) ?? null,
        }
      : undefined;
  } catch (e) {
    scopes = undefined;
    if (isMissingColumnError(e)) {
      // scope 컬럼 미존재(옛 스키마) → role 만 재조회. scope 는 미설정(전체)으로 둔다.
      try {
        const { data, error } = await getSupabase()
          .schema(getConfig().data.schema)
          .from('app_users')
          .select('role')
          .eq('email', email.toLowerCase())
          .maybeSingle();
        if (error) throw error;
        role = roleFromAppUserRow(data);
      } catch (e2) {
        console.error('[act-as] app_users 조회 실패 → viewer:', e2 instanceof Error ? e2.message : e2);
        role = 'viewer';
        cacheable = false;
      }
    } else {
      console.error('[act-as] app_users 조회 실패 → viewer:', e instanceof Error ? e.message : e);
      role = 'viewer';
      cacheable = false;
    }
  }

  // cap 백스톱 — 만료 정리 후 무한 증가 방지
  if (_actAsCache.size > 500) {
    for (const [k, v] of _actAsCache) if (v.expiresAt <= now) _actAsCache.delete(k);
  }
  // 실패 결과는 캐시하지 않는다 — 일시 장애가 60초 동안 굳지 않게.
  if (cacheable) _actAsCache.set(cacheKey, { role, scopes, expiresAt: now + ACT_AS_TTL_MS });
  return { role, scopes };
}

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

// Server usage guide — the connecting client (Claude etc.) receives this once. Set via config.branding.instructions.
const SERVER_INSTRUCTIONS = getConfig().branding.instructions;

function createServer(): Server {
  const server = new Server(
    { name: 'knowledge-mcp', version: VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // capability 게이팅: 자격증명(env)이 갖춰진 도구군만 노출.
    // 토큰 없는 도구를 숨겨 Claude 가 헛호출(런타임 에러)하지 않게 함.
    // (Slack 읽기 도구는 bot token, slack_search 는 user token + bot token 이 있어야 노출)
    const tools: Tool[] = [pingTool]; // health check 는 항상

    if (driveConfigured()) {
      // Drive 도구 (직원 사용 — Phase 1 primary)
      tools.push(searchDriveTool, readDriveFileTool, listDriveFolderTool);
    }
    if (semanticConfigured()) {
      tools.push(semanticSearchDriveTool); // Qdrant + OpenAI 필요 (Drive 와 별개 의존)
    }
    if (slackConfigured()) {
      // Slack 도구 (read-only — 대화 읽기 + 파일 다운로드). 봇이 멤버인 채널만.
      tools.push(slackListChannelsTool, slackReadChannelTool, slackFindFilesTool, slackGetFileTool);
    }
    if (slackSearchConfigured()) {
      tools.push(slackSearchTool); // 검색 API 는 user token 전용, 결과는 봇 멤버 채널로 거름
    }
    if (githubConfigured()) {
      // GitHub 코드 탐색 보조 — repo 트리(구조) → upstream github_get_file_contents 로 필요 파일 조회
      tools.push(repoTreeTool);
    }
    if (railwayConfigured()) {
      // Railway 인프라 조회 (자체 GraphQL — remote MCP 가 OAuth 전용이라 token 방식으로 직접)
      tools.push(railwayServicesTool, railwayDeploymentsTool, railwayLogsTool);
    }
    // Upstream MCP (GitHub/Railway remote — gateway proxy, prefix github_/railway_). 연결된 것만 반환.
    tools.push(...upstreamManager.getAllTools());

    // 직원별 도구군 scope 게이팅 (admin·미설정 = 전체 노출). tools 차원이 정해진 직원만 제한.
    const auth = getAuthMaybe();
    const visible = auth ? tools.filter((t) => isToolAllowed(auth, t.name)) : tools;
    return { tools: visible };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const t0 = Date.now();
    const callerAuth = getAuthMaybe();

    const result = await (async () => {
    try {
      // 직원별 도구군 scope 게이팅 (admin·미설정 = 전체). 노출 게이팅과 별개로 호출도 차단(심층방어).
      // P2: auth 부재 시 fail-closed(deny) — 예전 `gateAuth && ...` 는 auth 가 없으면 통과(fail-open)라
      //     향후 진입점/리팩터링에서 권한 게이트가 무력화될 위험. `!gateAuth ||` 로 deny default.
      //     (정상 경로는 /mcp 가 !auth.ok 를 401 로 막고 authStore.run 으로 항상 set 하므로 무영향.)
      const gateAuth = getAuthMaybe();
      if (!gateAuth || !gateAuth.ok || !isToolAllowed(gateAuth, name)) {
        return {
          content: [{ type: 'text' as const, text: `[forbidden] 도구 '${name}' 은 현재 직원 권한으로 접근 불가입니다.` }],
          isError: true,
        };
      }

      // upstream (GitHub/Railway remote) tool 먼저 라우팅 — prefix(github_/railway_) 매칭 시 forward
      const upstreamResult = await upstreamManager.route(name, args ?? {});
      if (upstreamResult !== null) {
        return upstreamResult as Awaited<ReturnType<typeof handlePing>>;
      }

      switch (name) {
        case 'ping':
          return await handlePing(args ?? {});
        case 'search_drive':
          return await handleSearchDrive(args ?? {});
        case 'read_drive_file':
          return await handleReadDriveFile(args ?? {});
        case 'list_drive_folder':
          return await handleListDriveFolder(args ?? {});
        case 'semantic_search_drive':
          return await handleSemanticSearchDrive(args ?? {});
        case 'slack_list_channels':
          return await handleSlackListChannels(args ?? {});
        case 'slack_search':
          return await handleSlackSearch(args ?? {});
        case 'slack_read_channel':
          return await handleSlackReadChannel(args ?? {});
        case 'slack_find_files':
          return await handleSlackFindFiles(args ?? {});
        case 'slack_get_file':
          return await handleSlackGetFile(args ?? {});
        case 'repo_tree':
          return await handleRepoTree(args ?? {});
        case 'railway_services':
          return await handleRailwayServices();
        case 'railway_deployments':
          return await handleRailwayDeployments(args ?? {});
        case 'railway_logs':
          return await handleRailwayLogs(args ?? {});
        default:
          return {
            content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (e: unknown) {
      // zod 입력 검증 실패는 도구별 graceful 에러로 분기 — 예전엔 [fatal] 로 표시돼 호출자(LLM)가
      // "서버 결함" 으로 오인하고 zod 상세가 그대로 새었다. [invalid_input] 으로 명확화.
      if (e instanceof ZodError) {
        const detail = e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        return {
          content: [{ type: 'text' as const, text: `[invalid_input] 도구 '${name}' 입력이 스키마에 맞지 않습니다 — ${detail}` }],
          isError: true,
        };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [{ type: 'text' as const, text: `[fatal] ${msg}` }],
        isError: true,
      };
    }
    })();

    // 호출 로그 (best-effort — 실패해도 응답엔 영향 없음)
    const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
    logToolCall({
      tool: name,
      auth: callerAuth,
      ok: r.isError !== true,
      error: r.isError === true ? (r.content?.find((c) => c.type === 'text')?.text ?? null) : null,
      durationMs: Date.now() - t0,
    });
    return result;
  });

  return server;
}

async function runStdio() {
  const key = process.env.MCP_API_KEY;
  let auth = await authenticateApiKey(key);
  if (!auth.ok) {
    console.error(
      `[knowledge-mcp] stdio 인증 실패: ${auth.reason}. ` +
        `.env 의 MCP_API_KEY 확인.`
    );
    process.exit(1);
  }
  // HTTP 와 같은 규칙 — email 이 있는 키는 app_users 에서 role·scope 를 다시 계산(dev key 제외).
  if (auth.email && auth.email !== 'dev@local') {
    const { role, scopes } = await resolveActAsAuth(auth.key_id ?? 'direct', auth.email);
    auth = { ...auth, role, scopes };
  }
  // stdio 는 한 프로세스 = 한 사용자. transport 를 만들기 전에 프로세스 단위로 둔다(context.ts 설명).
  setProcessAuth(auth);
  await upstreamManager.connectAll();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[knowledge-mcp] stdio mode · ${auth.email ?? auth.org_id} (${auth.role})`
  );
}

/** TRUST_PROXY env → express 'trust proxy' 값. 숫자=홉 수, true/false, 그 밖=서브넷 목록 문자열. */
function trustProxySetting(): number | boolean | string {
  const v = (process.env.TRUST_PROXY ?? '1').trim();
  if (/^\d+$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

async function runHttp() {
  // 어떤 도구군이 노출되는지(자격증명 갖춰진 것만) 부팅 시 1줄 로그 — ops 가시성.
  console.error(`[knowledge-mcp] config=${configSource()} · capabilities · ${capabilitySummary()}`);
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
    // Google 로그인 콜백 — 우리 AS 가 Google(OIDC)로 브리지 후 client 로 우리 code 발급
    app.get('/oauth/google/callback', async (req, res) => {
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      if (!code || !state) {
        res.status(400).send('missing code/state');
        return;
      }
      try {
        const url = await oauthProvider.completeGoogleLogin(code, state);
        res.redirect(url);
      } catch (e) {
        res.status(400).send(`OAuth login error: ${e instanceof Error ? e.message : String(e)}`);
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
      const cookie = String(req.headers.cookie ?? '')
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith(`${CONSENT_COOKIE}=`));
      const cookieCsrf = cookie ? cookie.slice(CONSENT_COOKIE.length + 1) : '';
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Set-Cookie', `${CONSENT_COOKIE}=; Path=${CONSENT_PATH}; Max-Age=0; HttpOnly; SameSite=Lax`);
      try {
        const url = oauthProvider.consumeConsent(
          String(body.id ?? ''),
          String(body.csrf ?? ''),
          cookieCsrf,
          body.action === 'approve',
        );
        res.redirect(url);
      } catch (e) {
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
          const r = await resolveActAsAuth(info.clientId ?? 'oauth', oauthEmail);
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
        const { role, scopes } = await resolveActAsAuth(auth.key_id ?? 'direct', auth.email);
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
        const { role, scopes } = await resolveActAsAuth(auth.key_id, actAsEmail);
        auth = { ...auth, role, email: actAsEmail, scopes, actAs: true };
        console.error(`[act-as] key_id=${auth.key_id} email=${actAsEmail} role=${role}`);
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
  setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) if (now - s.lastActive > SESSION_IDLE_MS) dropSession(sid);
  }, 5 * 60_000).unref();

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
        const server = createServer();
        await server.connect(transport);
        await authStore.run(auth, () => transport.handleRequest(req, res, req.body));
        return;
      }

      // 3) stateless 폴백 (비-initialize + 세션ID 없음) — 기존 IDE·프록시 one-shot 보존.
      const server = createServer();
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

  const port = parseInt(process.env.PORT || '8080', 10);
  app.listen(port, () => {
    console.error(
      `[knowledge-mcp] HTTP mode · listening on :${port} · version=${VERSION}`
    );
  });

  // 외부 연결은 포트를 연 뒤 백그라운드로 — upstream·Qdrant 가 응답하지 않아도 /health 가 먼저 뜬다
  // (예전엔 listen 전에 기다려 healthcheck 시간 안에 포트가 안 열리고 재시작이 반복될 수 있었다).
  void (async () => {
    // upstream MCP (GitHub/Railway) best-effort connect — 실패해도 자체 tool 로 작동 (graceful).
    // 연결되기 전 tools/list 에는 upstream 도구가 빠져 있다가, 연결되면 다음 목록부터 나온다.
    try {
      await upstreamManager.connectAll();
    } catch (e) {
      console.error('[knowledge-mcp] upstream 연결 실패 (자체 도구로 계속):', e);
    }
    // Drive → Qdrant 증분 sync scheduler (polling). QDRANT 설정 + 비활성 아닐 때만.
    if (process.env.QDRANT_URL && process.env.DRIVE_SYNC_ENABLED !== 'false') {
      // fresh 배포 시 Qdrant 컬렉션을 부팅 때 1회 보장 — 없으면 첫 sync 가 조용히 실패하던 문제 방지.
      try {
        await ensureCollection();
      } catch (e) {
        console.error('[knowledge-mcp] ensureCollection 실패 (sync 는 계속 시도):', e);
      }
      startDriveSyncScheduler(parseInt(process.env.DRIVE_SYNC_INTERVAL_MIN || '30', 10));
    }
  })();
}

const transport = (process.env.MCP_TRANSPORT || 'http').toLowerCase();

if (transport === 'stdio') {
  runStdio().catch((err) => {
    console.error('[knowledge-mcp] stdio fatal:', err);
    process.exit(1);
  });
} else {
  runHttp().catch((err) => {
    console.error('[knowledge-mcp] http fatal:', err);
    process.exit(1);
  });
}
