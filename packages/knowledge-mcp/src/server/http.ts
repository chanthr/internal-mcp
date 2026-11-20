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
import { z } from 'zod';
import { isToolAllowed } from '../core/scope.js';
import { logToolCall } from '../store/tool_log.js';
import { randomUUID, createHash } from 'crypto';
import { connect } from 'node:net';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';

import { authenticateApiKey, type AuthContext, type Role, type ResourceScopes } from '../core/auth.js';
import { authStore } from '../core/context.js';
import {
  oauthProvider, isOAuthConfigured, oauthConfigProblems, oauthAttempted, oauthGoogleProblems, oauthSignIns, setConsentHeaders,
  OAUTH_ISSUER_URL, OAUTH_RESOURCE, OAUTH_SCOPES, CONSENT_COOKIE, CONSENT_PATH, LOGIN_COOKIE, GOOGLE_CALLBACK_PATH,
} from '../core/oauth.js';
import { maskedSecretCount } from '../core/log_mask.js';
import { getConfig, configSource } from '../core/config.js';
import { getStore, scheduleToolLogPrune } from '../store/index.js';
import { VERSION } from '../version.js';
import { consoleOpenUrl, consoleUrl, mountConsole } from '../admin/routes.js';
import { followSupervisor, reportReady } from '../admin/supervisor.js';
import { resumeTunnel } from '../admin/tunnel.js';
import type { Registry } from '../plugin/registry.js';
import { resolveUser } from './identity.js';
import { createMcpServer } from './mcp.js';

// The Claude.ai web connector calls /mcp straight from the browser, so CORS is needed. Allowed Origin list (env
// override).
const MCP_CORS_ORIGINS = (process.env.MCP_CORS_ORIGINS || 'https://claude.ai,https://claude.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// act-as delegation: X-MCP-Act-As-Email is trusted only from these key_ids (trusted proxy keys), and the request is
// lowered to that person's permissions (member at most). Ordinary keys are not affected. A role in the header is not
// trusted: the server recomputes it from users (blocks forgery).
// If the header is missing, the request is lowered to viewer (fail-safe).
const ACT_AS_ALLOWED_KEY_IDS = new Set(
  (process.env.ACT_AS_ALLOWED_KEY_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Adds CORS headers to a /mcp response (allowed Origins only). Non-browser clients (no Origin) are not affected. */
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
 * Logs only a fingerprint (first 8 chars of the sha256) of each high-privilege secret at boot. The value is never
 * exposed.
 * After a rotation, operators can see at a glance whether the server came up with the new key. An unchanged fingerprint
 * means the rotation did not take effect.
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

/** Reads one cookie from the request ('' if absent). */
function readCookie(req: ExpressRequest, name: string): string {
  const hit = String(req.headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : '';
}

/** TRUST_PROXY env to the express 'trust proxy' value. Number = hop count, true/false, otherwise a subnet list string. */
function trustProxySetting(): number | boolean | string {
  const v = (process.env.TRUST_PROXY ?? '1').trim();
  if (/^\d+$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

/**
 * Does a program on this machine already answer on this port?
 *
 * The server listens on every address, and the system allows that beside a program that listens on 127.0.0.1
 * only. The two then share the port: a browser that opens http://localhost:PORT reaches one or the other, and the
 * console is answered "not allowed" by a program that has never heard of it. So the port is asked first.
 */
async function portAnswers(port: number): Promise<boolean> {
  const answers = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ host, port });
      const end = (yes: boolean) => {
        socket.destroy();
        resolve(yes);
      };
      socket.setTimeout(500, () => end(false));
      socket.once('connect', () => end(true));
      socket.once('error', () => end(false));
    });
  return (await Promise.all(['127.0.0.1', '::1'].map(answers))).some(Boolean);
}
const portTaken = (port: number) =>
  new Error(`Port ${port} is already used by another program on this computer. Start on another port (PORT=${port + 10}, on the command line or in .env), or stop the other program.`);

export async function runHttp(registry: Registry): Promise<{ port: number; close: () => Promise<void> }> {
  // One boot log line showing which plugins are on (only those with credentials) and which store is used, for ops
  // visibility.
  const store = await getStore();
  console.error(`[knowledge-mcp] config=${configSource()} · store=${store.kind} (${store.location}) · plugins · ${registry.summary()}`);
  console.error(`[log-mask] masking ${maskedSecretCount()} secret env values and common token patterns`);
  if (configSource() === 'defaults') {
    console.error(
      '[knowledge-mcp] ⚠️ no config found, running on defaults (no Drive roots, no excluded folders, no login allowlist). ' +
        'Set MCP_CONFIG_JSON or put mcp.config.json in the working directory (/app/mcp.config.json in the container).',
    );
  }
  logSecretFingerprints(); // fingerprints of high-privilege keys (values not shown), to verify a rotation
  const stopLogPrune = scheduleToolLogPrune(store);

  const app = express();
  // How many X-Forwarded-For hops to trust when behind a proxy. Default 1 (one front proxy, as on Railway, Fly or
  // Cloud Run).
  // When exposed directly without a proxy, set TRUST_PROXY=false. Otherwise a client could change its IP with a header
  // it sends and dodge the rate limit.
  app.set('trust proxy', trustProxySetting());
  app.use(express.json({ limit: '4mb' }));

  // Health check, no auth
  app.get('/health', (_req, res) => {
    res.json({ ok: true, server: 'knowledge-mcp', version: VERSION });
  });

  // The local console (a page for the setup, on this machine only). KNOWLEDGE_CONSOLE=off leaves it out.
  followSupervisor();
  const consoleOn = mountConsole(app, registry);

  // ── OAuth 2.1 (for Claude app custom connectors), only when the env is complete (otherwise Bearer only) ──
  const oauthEnabled = isOAuthConfigured();
  // Keys typed on the consent page: a few a minute from one address is a person; more is guessing.
  const consentLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: 'Too many tries. Wait a minute and start the connection again.' });
  let resourceMetadataUrl: string | undefined;
  if (oauthEnabled) {
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(OAUTH_RESOURCE));
    const secureCookie = OAUTH_ISSUER_URL.startsWith('https://') ? '; Secure' : '';
    // Google sign-in callback: our AS bridges to Google (OIDC), then issues our own code to the client.
    // The login cookie of the browser that approved the consent must be present (see consumeConsent in oauth.ts).
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
    // AS endpoints + .well-known (authorize, token, register, AS metadata, PRM). Mounted at the root.
    app.use(
      mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: new URL(OAUTH_ISSUER_URL),
        scopesSupported: OAUTH_SCOPES,
        resourceName: getConfig().branding.name,
        resourceServerUrl: new URL(OAUTH_RESOURCE),
      }),
    );
    // Approve/cancel from the consent page: consumeConsent in oauth.ts. Proceeds only when both the cookie
    // (SameSite=Lax) and the form csrf match. A wrong key shows the page again (the consent cookie stays for the
    // next try); everything else ends the request and clears it.
    app.post(CONSENT_PATH, consentLimiter, express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const cookies = [`${CONSENT_COOKIE}=; Path=${CONSENT_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secureCookie}`];
      res.setHeader('Cache-Control', 'no-store');
      const action = body.action === 'approve' || body.action === 'key' ? body.action : 'deny';
      try {
        const r = await oauthProvider.consumeConsent(
          String(body.id ?? ''),
          String(body.csrf ?? ''),
          readCookie(req, CONSENT_COOKIE),
          action,
          typeof body.key === 'string' ? body.key : '',
        );
        if ('page' in r) {
          setConsentHeaders(res);
          res.status(200).type('html').send(r.page);
          return;
        }
        // Cookie that proves it is this browser across the trip to Google. With SameSite=Lax it is sent on the
        // top-level navigation coming back from Google.
        if (r.loginBinding) {
          cookies.push(`${LOGIN_COOKIE}=${r.loginBinding}; Path=${GOOGLE_CALLBACK_PATH}; Max-Age=600; HttpOnly; SameSite=Lax${secureCookie}`);
        }
        res.setHeader('Set-Cookie', cookies);
        res.redirect(r.redirect);
      } catch (e) {
        res.setHeader('Set-Cookie', cookies);
        res.status(400).type('text').send(e instanceof Error ? e.message : String(e));
      }
    });
    const ways = oauthSignIns();
    console.error(
      `[knowledge-mcp] OAuth enabled · issuer=${OAUTH_ISSUER_URL} · resource=${OAUTH_RESOURCE} · sign-in with a key${ways.google ? ' or Google' : ''}`,
    );
    const half = oauthGoogleProblems();
    if (half.length) console.error(`[knowledge-mcp] ⚠️ Google sign-in off — missing: ${half.join(', ')}`);
  } else if (oauthAttempted()) {
    // A half-configured state is not turned off silently: the missing values are reported by name (values not shown).
    console.error(`[knowledge-mcp] ⚠️ OAuth off — missing: ${oauthConfigProblems().join(', ')}`);
  } else {
    console.error('[knowledge-mcp] OAuth off (API keys only)');
  }

  // CORS preflight, for browser requests from the Claude.ai web connector.
  app.options('/mcp', (req, res) => {
    applyMcpCors(req, res);
    res.status(204).end();
  });

  // GET (long-lived SSE stream) and DELETE (end session) are registered below as session routing handlers, after the
  // rate-limit definitions
  // (hybrid stateful: handled by the session's transport only when there is an active session, otherwise 405).

  // ── /mcp rate-limit ── Keyed by IP (req.ip is accurate with trust proxy 1). Limits can be overridden by env.
  // Purpose: stop a flood of bad keys from amplifying validate_mcp_key RPC calls (DB load and cost), and soften
  // general abuse.
  // Two tiers: (1) a generous overall limit (normal chatbots and IDEs are not affected) (2) a stricter limit on
  // auth failures (401) only.
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
    // Count 401 only. If session expiry after a redeploy (404), a GET without a session (405) and dropped SSE were
    // also counted as "auth failures",
    // legitimate users behind the same egress IP (an office NAT, for example) would get 429 along with them.
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: rlHandler(429, 'too many failed auth attempts — slow down'),
  });

  // ── Auth resolution (shared by POST, GET and DELETE) ──
  // Even with sessions, auth runs on every request (permissions are not bound to the session: if a session ID leaks,
  // each request is still re-authenticated with its Bearer/OAuth token, so session hijacking cannot raise privileges).
  // On ok:false, send401.
  const extractKey = (req: ExpressRequest): { key?: string; looksJwt: boolean } => {
    const authHeader = req.headers.authorization;
    const key = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
    return { key, looksJwt: !!key && key.split('.').length === 3 };
  };
  const resolveAuth = async (req: ExpressRequest): Promise<AuthContext> => {
    const { key, looksJwt } = extractKey(req);
    let auth: AuthContext;
    // dual-auth (order optimized): an OAuth access token is a JWT (three dot-separated parts), so local HS256
    // verification runs *first*.
    // Existing mcp_key/dev keys are not JWT-shaped, so there is no clash. This keeps connector (OAuth) calls from
    // making a wasted validate_mcp_key RPC round trip (fails every time, never cached). That removes call latency and
    // DB load.
    if (oauthEnabled && looksJwt) {
      try {
        const info = await oauthProvider.verifyAccessToken(key!);
        const oauthEmail = typeof info.extra?.email === 'string' ? info.extra.email : undefined;
        // OAuth users also get their app_users role (consistent with act-as). The email was verified by Google
        // sign-in plus the allowlist, so it is trusted. Missing, unregistered or failed lookup means viewer (PII tools
        // are not opened to unregistered accounts).
        // Approved with a key: the key's own role, recomputed from app_users by the key's email like a key sent
        // directly (below), so a token never reaches further than its key.
        const viaKey = info.extra?.via === 'key';
        let oauthRole: Role = viaKey && (info.extra?.role === 'admin' || info.extra?.role === 'member' || info.extra?.role === 'viewer') ? info.extra.role : 'viewer';
        let oauthScopes: ResourceScopes | undefined;
        if (oauthEmail) {
          const r = await resolveUser(info.clientId ?? 'oauth', oauthEmail);
          oauthRole = r.role;
          oauthScopes = r.scopes;
        }
        auth = {
          ok: true, org_id: getConfig().orgId, role: oauthRole,
          email: oauthEmail, key_id: viaKey && typeof info.extra?.keyId === 'string' ? info.extra.keyId : info.clientId, scopes: oauthScopes,
        };
      } catch {
        auth = { ok: false, reason: 'invalid oauth token' };
      }
    } else {
      // Existing Bearer path (IDE, internal proxy, dev key)
      auth = await authenticateApiKey(key);
      // Direct keys (IDE) also get role + scope recomputed from app_users by the user's email (same as act-as, OAuth).
      // The role is recomputed too, so an offboarding or demotion applies at once (the old gap: admin stayed until
      // the key was revoked). Dev keys are excluded.
      if (auth.ok && auth.email) {
        const { role, scopes } = await resolveUser(auth.key_id ?? 'direct', auth.email);
        auth = { ...auth, role, scopes };
      }
    }
    if (!auth.ok) return auth;
    // ── act-as (internal proxy passes on the signed-in user's permissions) ──
    // Only for delegated key_ids. The header role is not read; the server recomputes it from app_users (prevents
    // forgery). No header means viewer.
    if (auth.key_id && ACT_AS_ALLOWED_KEY_IDS.has(auth.key_id)) {
      const hdr = req.headers['x-mcp-act-as-email'];
      const actAsEmail = typeof hdr === 'string' ? hdr.trim() : '';
      if (!actAsEmail) {
        auth = { ...auth, role: 'viewer', email: undefined, actAs: true };
      } else {
        const resolved = await resolveUser(auth.key_id, actAsEmail);
        // A proxy can stand in for member at most. Even if the proxy key leaks, naming an admin email does not
        // yield admin rights.
        const role: Role = resolved.role === 'admin' ? 'member' : resolved.role;
        auth = { ...auth, role, email: actAsEmail, scopes: resolved.scopes, actAs: true };
        console.error(`[act-as] key_id=${auth.key_id} email=${actAsEmail} role=${role}${resolved.role === 'admin' ? ' (capped from admin)' : ''}`);
      }
    }
    return auth;
  };
  const send401 = (req: ExpressRequest, res: ExpressResponse, auth: AuthContext): void => {
    const { key, looksJwt } = extractKey(req);
    // The discovery trigger header is added only for OAuth entry conditions (no token, or a JWT), so IDEs are not
    // drawn into the OAuth flow by mistake.
    if (oauthEnabled && resourceMetadataUrl && (!key || looksJwt)) {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"`);
    }
    if (auth.unavailable) {
      // Store outage: not the client's fault. A 503 does not count toward the 401 failure limit (so legitimate users
      // are not locked out with 429).
      res.status(503).setHeader('Retry-After', '5');
      res.json({ jsonrpc: '2.0', error: { code: -32603, message: 'authentication backend unavailable, retry shortly' }, id: null });
      return;
    }
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: `auth failed: ${auth.reason ?? 'unauthorized'}` },
      id: null,
    });
  };

  // ── Session store (hybrid stateful) ──
  // Why: Claude and ChatGPT custom connectors receive an Mcp-Session-Id at initialize and keep later requests and the
  // long-lived GET SSE stream on that session. When stateless (no session ID), the GET stream is blocked with 405 and
  // it looks like "the connection keeps dropping". So initialize creates a session (issues Mcp-Session-Id), and later
  // requests and GETs are routed to that session's transport.
  // A non-initialize request without a session ID falls back to stateless, to keep existing one-shot clients (IDE,
  // proxy) working.
  // Warning: this is in-memory, so it assumes a single replica. Multiple replicas need sticky routing or a shared
  // session store.
  interface McpSession { transport: StreamableHTTPServerTransport; lastActive: number; owner: string }
  const sessions = new Map<string, McpSession>();
  const SESSION_IDLE_MS = Number(process.env.MCP_SESSION_IDLE_MS ?? 30 * 60_000);
  const SESSION_MAX = Number(process.env.MCP_SESSION_MAX ?? 1000);
  // Number of sessions one person (or key) may hold. Without it, one user could flood initialize, fill the global cap
  // and push out other people's sessions.
  const SESSION_MAX_PER_OWNER = Number(process.env.MCP_SESSION_MAX_PER_USER ?? 20);
  const oldestSession = (match: (s: McpSession) => boolean): string | undefined => {
    let oldestSid: string | undefined;
    let oldest = Infinity;
    for (const [k, v] of sessions) if (match(v) && v.lastActive < oldest) { oldest = v.lastActive; oldestSid = k; }
    return oldestSid;
  };
  const dropSession = (sid: string): void => {
    const s = sessions.get(sid);
    if (s) {
      sessions.delete(sid);
      s.transport.close().catch(() => {});
    }
  };
  // Idle session sweep: expires sessions of connectors that went away without a DELETE (prevents a memory leak).
  // unref so it does not keep the process alive.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) if (now - s.lastActive > SESSION_IDLE_MS) dropSession(sid);
  }, 5 * 60_000);
  sweeper.unref();

  // GET (long-lived SSE stream) and DELETE (end session): routed to the session's transport only when there is an
  // active session.
  // Without a session a stateless server has no stream, so 405 (existing behavior kept).
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

  // ── POST /inbox: a note sent by a program that does not speak MCP (a browser agent's routine, a script) ──
  // The same keys as /mcp; a member or an admin may send, and only to inbox/<from>/ (plugins/knowledge/notes.ts).
  const inboxLimiter = rateLimit({ windowMs: RL_WINDOW_MS, limit: Number(process.env.INBOX_RATE_LIMIT_MAX ?? 30), standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many notes. Wait a minute.' } });
  const inboxBody = z
    .object({
      title: z.string().trim().min(1).max(200),
      content: z.string().min(1).max(200_000),
      from: z.string().trim().min(1).max(60).optional(),
      url: z.string().url().max(2000).optional(),
      tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
    })
    .strict();
  app.post('/inbox', inboxLimiter, mcpAuthFailRateLimit, async (req, res) => {
    const auth = await resolveAuth(req);
    if (!auth.ok) return void res.status(auth.unavailable ? 503 : 401).json({ error: auth.unavailable ? 'Sign-in is unavailable right now. Try again shortly.' : 'A key is needed: Authorization: Bearer <key>.' });
    if (auth.role === 'viewer' || !isToolAllowed(auth, 'save_note', registry.groupOf('save_note'))) return void res.status(403).json({ error: 'This key may not send notes.' });
    const body = inboxBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    try {
      const { saveNote, INBOX } = await import('../plugins/knowledge/notes.js');
      const { scanFoldersSoon } = await import('../plugins/knowledge/folders.js');
      const who = body.data.from ?? (auth.key_id ? `key-${auth.key_id.slice(0, 8)}` : auth.email ?? 'other');
      const r = saveNote({ ...body.data, place: INBOX, from: who });
      void scanFoldersSoon().catch(() => undefined);
      logToolCall({ tool: 'inbox', auth, ok: true, error: null, durationMs: 0 });
      res.status(201).json({ saved: r.shown });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // MCP endpoint (POST): session routing + stateless fallback
  app.post('/mcp', mcpRateLimit, mcpAuthFailRateLimit, async (req, res) => {
    applyMcpCors(req, res);
    const auth = await resolveAuth(req);
    if (!auth.ok) return send401(req, res, auth);

    const sidHeader = req.headers['mcp-session-id'];
    const sid = typeof sidHeader === 'string' ? sidHeader : undefined;

    try {
      // 1) Existing session: route to its transport (auth already ran above, as on every request)
      if (sid) {
        const s = sessions.get(sid);
        if (!s) {
          // Expired or unknown session: 404 so the client re-initializes
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

      // 2) initialize (no session ID): create a new stateful session (issues Mcp-Session-Id)
      if (isInitializeRequest(req.body)) {
        const owner = auth.email ?? auth.key_id ?? 'anonymous';
        // Drop the same owner's oldest session first, and keep the global cap as a backstop.
        const mine = [...sessions.values()].filter((v) => v.owner === owner).length;
        if (mine >= SESSION_MAX_PER_OWNER) {
          const sid = oldestSession((v) => v.owner === owner);
          if (sid) dropSession(sid);
        }
        if (sessions.size >= SESSION_MAX) {
          const sid = oldestSession(() => true);
          if (sid) dropSession(sid);
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSid) => {
            sessions.set(newSid, { transport, lastActive: Date.now(), owner });
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

      // 3) Stateless fallback (non-initialize + no session ID): keeps existing IDE and proxy one-shot calls working.
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

  // Last: anything a handler above did not answer for itself, a body that is not JSON or is too large above all.
  // Express would answer with the error's stack (file paths of this install) to whoever sent the request.
  app.use((err: unknown, _req: ExpressRequest, res: ExpressResponse, next: (e?: unknown) => void) => {
    if (res.headersSent) return next(err);
    const given = (err as { status?: unknown; statusCode?: unknown } | null)?.status ?? (err as { statusCode?: unknown } | null)?.statusCode;
    const status = typeof given === 'number' && given >= 400 && given < 600 ? given : 500;
    if (status >= 500) console.error('[knowledge-mcp] request failed:', err instanceof Error ? err.message : err);
    res.status(status).json({ error: status === 400 ? 'The request body is not valid JSON.' : status === 413 ? 'The request body is too large.' : status < 500 ? 'The request was refused.' : 'The server could not handle the request.' });
  });

  // PORT=0 picks a free port (for tests). The actual port is reported in the return value.
  const wanted = parseInt(process.env.PORT || '8080', 10);
  if (wanted !== 0 && (await portAnswers(wanted))) throw portTaken(wanted);
  const httpServer = await new Promise<import('node:http').Server>((resolveListen, rejectListen) => {
    const srv = app.listen(wanted, () => resolveListen(srv));
    srv.once('error', (e: NodeJS.ErrnoException) => rejectListen(e.code === 'EADDRINUSE' ? portTaken(wanted) : e));
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : wanted;
  console.error(`[knowledge-mcp] HTTP mode · listening on :${port} · version=${VERSION}`);
  reportReady({ port, consoleUrl: consoleOn ? consoleUrl(port) : null, openUrl: consoleOn ? consoleOpenUrl(port) : null });
  // The public address the person turned on in the console (admin/tunnel.ts) comes back with the server.
  if (consoleOn) void resumeTunnel(port);

  // External connections start in the background after the port is open, so /health comes up first even when upstream
  // or Qdrant does not respond
  // (it used to wait before listen, so the port could miss the healthcheck window and the service kept restarting).
  // A remote MCP is missing from tools/list until it connects, and appears from the next listing once connected.
  void registry.start();

  return {
    port,
    close: () =>
      new Promise<void>((done) => {
        clearInterval(sweeper);
        stopLogPrune();
        for (const sid of [...sessions.keys()]) dropSession(sid);
        httpServer.close(() => done());
        httpServer.closeAllConnections?.();
      }),
  };
}

