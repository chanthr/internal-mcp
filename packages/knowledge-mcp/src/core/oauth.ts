/**
 * OAuth 2.1 Authorization Server + Resource Server, for Claude app custom connectors.
 *
 * This MCP server is both the AS and the RS (same process):
 *   - AS: the SDK `mcpAuthRouter` mounts /authorize, /token and /register (plus the .well-known metadata),
 *         and the actual logic lives in `KnowledgeOAuthProvider` in this file (an OAuthServerProvider implementation).
 *   - Consent: /authorize does not go straight to Google. It first shows a consent page (which app, and where the
 *           token will be sent).
 *           Anyone can register a client through DCR, so without consent one link would send the token to an
 *           attacker's redirect_uri (the confused deputy problem in the MCP security best practices). The approve
 *           button is bound to a cookie so that another site cannot press it on the user's behalf.
 *   - Sign-in: bridged to Google Workspace (OIDC). The account must match an allowed domain (hd) or an allowed email.
 *   - Tokens: access and refresh tokens are self-issued HS256 JWTs (AS = RS, so no JWKS to publish; verified
 *           in-process with a symmetric key).
 *           The access token aud is the canonical resource (our /mcp). RFC 8707.
 *   - PKCE (S256): the SDK token handler gets the challenge from challengeForAuthorizationCode() and verifies it itself.
 *
 * Graceful: if a required value is missing, isOAuthConfigured() is false and server/http.ts does not mount the router
 *   (existing Bearer auth is unaffected).
 *   The allowlist (domains, emails) is also required. If both are empty, any Google account could sign in, so OAuth
 *   stays off.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { getStore } from '../store/index.js';
import { getConfig } from './config.js';
import { timingSafeEqualStr } from './auth.js';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidScopeError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

// ── Settings (env) ──
const ISSUER = (process.env.MCP_OAUTH_ISSUER || '').replace(/\/$/, ''); // e.g. https://mcp.example.com
const RESOURCE = (process.env.MCP_RESOURCE || (ISSUER ? `${ISSUER}/mcp` : '')).replace(/\/$/, ''); // canonical, = token aud
// Google client for the sign-in bridge. The dedicated OAUTH_GOOGLE_* values win; otherwise the existing
// GOOGLE_OAUTH_* values (used for Drive) are reused.
const GOOGLE_CLIENT_ID = process.env.OAUTH_GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.OAUTH_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const JWT_SECRET = process.env.OAUTH_JWT_SECRET || '';
const csv = (v: string) => v.split(',');
const ALLOWED_DOMAINS = (process.env.OAUTH_ALLOWED_HD ? csv(process.env.OAUTH_ALLOWED_HD) : getConfig().oauth.allowedDomains)
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const ALLOWED_EMAILS = (
  process.env.OAUTH_ALLOWED_EMAILS ? csv(process.env.OAUTH_ALLOWED_EMAILS) : getConfig().oauth.allowedEmails
)
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const emailDomain = (e: string) => e.slice(e.lastIndexOf('@') + 1);

/**
 * Account check: allowed if the email is on the allowed email list or its domain is an allowed domain (union).
 * If both lists are empty, nobody is allowed (fail-closed). In that case OAuth itself is not enabled.
 * This is **rechecked on every token verification and refresh**, not only at sign-in, so an account removed
 * from the allowlist is blocked at once even if it still holds tokens (in particular the 30-day refresh token).
 */
function emailAllowed(email: string): boolean {
  const e = (email || '').toLowerCase();
  if (!e || !e.includes('@')) return false;
  return ALLOWED_EMAILS.includes(e) || ALLOWED_DOMAINS.includes(emailDomain(e));
}

const GOOGLE_CALLBACK = ISSUER ? `${ISSUER}/oauth/google/callback` : ''; // = GOOGLE_CALLBACK_PATH
const SCOPE = 'mcp';
const ACCESS_TTL = 3600; // 1h
const REFRESH_TTL = 30 * 24 * 3600; // 30d
const CODE_TTL = 300; // 5m
const STATE_TTL = 600; // 10m
const CONSENT_TTL = 600; // 10m
export const CONSENT_COOKIE = 'kmcp_consent';
export const CONSENT_PATH = '/oauth/consent';
/** Binds the Google round trip to the browser that approved the consent page (see consumeConsent). */
export const LOGIN_COOKIE = 'kmcp_login';
export const GOOGLE_CALLBACK_PATH = '/oauth/google/callback';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/** Values still missing to enable OAuth (names only, never the values). An empty array means it can be enabled. */
export function oauthConfigProblems(): string[] {
  const out: string[] = [];
  if (!ISSUER) out.push('MCP_OAUTH_ISSUER');
  if (!GOOGLE_CLIENT_ID) out.push('OAUTH_GOOGLE_CLIENT_ID');
  if (!GOOGLE_CLIENT_SECRET) out.push('OAUTH_GOOGLE_CLIENT_SECRET');
  if (JWT_SECRET.length < 32) out.push('OAUTH_JWT_SECRET (>= 32 chars)');
  if (ALLOWED_DOMAINS.length === 0 && ALLOWED_EMAILS.length === 0) {
    out.push('OAUTH_ALLOWED_HD or OAUTH_ALLOWED_EMAILS (config oauth.allowedDomains / allowedEmails)');
  }
  return out;
}

/** Whether anyone tried to configure OAuth at all. Used to report a half-configured state loudly in the boot log. */
export function oauthAttempted(): boolean {
  return Boolean(ISSUER || process.env.OAUTH_GOOGLE_CLIENT_ID || JWT_SECRET);
}

/** OAuth is active only when every required value is set. Otherwise index does not mount the router (Bearer stays). */
export function isOAuthConfigured(): boolean {
  return Boolean(RESOURCE) && oauthConfigProblems().length === 0;
}

export const OAUTH_ISSUER_URL = ISSUER;
export const OAUTH_RESOURCE = RESOURCE;
export const OAUTH_SCOPES = [SCOPE];

const jwtKey = () => new TextEncoder().encode(JWT_SECRET);

// ── In-memory stores (enough for one replica and short TTLs: restart drops codes and state, JWTs stateless) ──
interface AuthCodeEntry {
  codeChallenge: string;
  clientId: string;
  redirectUri: string;
  email: string;
  scopes: string[];
  resource?: string;
  exp: number;
}
interface LoginRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  clientState?: string;
  scopes: string[];
  resource?: string;
  exp: number;
}
interface GooglePending extends LoginRequest {
  binding: string; // cookie set only in the approving browser; the Google callback must carry the same value to get a code
}
interface ConsentPending extends LoginRequest {
  csrf: string; // cookie set by the consent page; the POST form value and the cookie must both match it to approve
}

const _authCodes = new Map<string, AuthCodeEntry>();
const _googlePending = new Map<string, GooglePending>();
const _consentPending = new Map<string, ConsentPending>();

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Consent page HTML. Shows the app name and the address the token will be sent to, as they are. */
function consentPage(opts: { appName: string; clientId: string; redirectUri: string; id: string; csrf: string }): string {
  const server = escapeHtml(getConfig().branding.name);
  const app = escapeHtml(opts.appName);
  let target = opts.redirectUri;
  try {
    const u = new URL(opts.redirectUri);
    target = `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    /* The URL was validated at registration. If parsing still fails, show the original string. */
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${server} sign-in</title>
<style>
body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f6f4;color:#111}
main{max-width:440px;margin:12vh auto;padding:32px;background:#fff;border:1px solid #e3e3df;border-radius:14px}
h1{font-size:20px;margin:0 0 16px}p{margin:0 0 12px;color:#444}code{word-break:break-all;background:#f1f1ee;padding:2px 6px;border-radius:6px}
.row{display:flex;gap:12px;margin-top:24px}button{flex:1;font:inherit;padding:10px 14px;border-radius:10px;border:1px solid #c8cbd0;background:#fff;cursor:pointer}
button[value=approve]{background:#111;color:#fff;border-color:#111}
</style></head><body><main>
<h1>${app} wants to use ${server}</h1>
<p>If you continue, you sign in with Google and this app receives a token that can read what your account can read.</p>
<p>The token is sent to:<br><code>${escapeHtml(target)}</code></p>
<p>Client ID: <code>${escapeHtml(opts.clientId)}</code></p>
<p>Continue only if you started this connection yourself.</p>
<form method="post" action="${escapeHtml(ISSUER + CONSENT_PATH)}">
<input type="hidden" name="id" value="${escapeHtml(opts.id)}">
<input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">
<div class="row"><button type="submit" name="action" value="deny">Cancel</button>
<button type="submit" name="action" value="approve">Continue with Google</button></div>
</form></main></body></html>`;
}

/** URL that returns an OAuth error to the client redirect_uri. */
function clientError(p: LoginRequest, error: string, description: string): string {
  const u = new URL(p.redirectUri);
  u.searchParams.set('error', error);
  u.searchParams.set('error_description', description);
  if (p.clientState) u.searchParams.set('state', p.clientState);
  return u.toString();
}

function sweep<T extends { exp: number }>(m: Map<string, T>): void {
  const now = Date.now() / 1000;
  for (const [k, v] of m) if (v.exp <= now) m.delete(k);
}

// ── Client store (DCR: Claude and ChatGPT register automatically) ──
// Persisted in the store (SQLite file or Supabase mcp_oauth_clients), with an in-memory cache in front.
// Why: the earlier purely in-memory Map lost every registered client on each server restart (redeploy), so a
//     connector reconnecting with its old client_id got "invalid_client" (ChatGPT in particular does not
//     re-register automatically). With the DB as the source of truth, clients survive restarts. The cache is for
//     the hot path (getClient on every authorize and token call).
// Graceful: if the DB is unavailable (deployed before the migration, or a brief outage), fall back to the cache,
//           which is valid only for that process (same as the old in-memory behavior). Safe for any deploy order:
//           nothing breaks when the table does not exist.
class ClientsStore implements OAuthRegisteredClientsStore {
  private cache = new Map<string, OAuthClientInformationFull>();
  private static readonly CACHE_MAX = 500; // cache cap; the DB is the source of truth, so an evicted entry is just looked up again (safe)

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
      const store = await getStore();
      const client = await store.getOAuthClient(clientId);
      if (!client) return undefined;
      this.putCache(client);
      // Update last_used (best-effort; used to decide cleanup, failures are ignored)
      void store.touchOAuthClient(clientId).catch((e: unknown) => {
        console.error('[oauth] could not update client last_used:', e instanceof Error ? e.message : e);
      });
      return client;
    } catch (e) {
      console.error('[oauth] client lookup failed (cache only):', e instanceof Error ? e.message : e);
      return undefined;
    }
  }

  // The register handler has already generated client_id/secret and passes them in. Cache it and save it to the DB.
  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    this.putCache(client); // usable immediately
    try {
      await (await getStore()).saveOAuthClient(client);
    } catch (e) {
      // fail-open: registration succeeds even if the save fails (valid from the cache for this process). That is
      // better than hard-failing connector setup (store outages are rare). Logged as a warning: may be lost on restart.
      console.error('[oauth] could not save the client (kept in memory; lost on restart):', e instanceof Error ? e.message : e);
    }
    return client;
  }
}

// ── Google id_token verification (restricted to the organization by the hd + email allowlist) ──
async function verifyGoogleIdToken(idToken: string): Promise<{ email: string; hd?: string }> {
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: GOOGLE_CLIENT_ID,
    algorithms: ['RS256'], // pin alg (defense-in-depth)
  });
  const email = String(payload.email || '').toLowerCase();
  const hd = payload.hd ? String(payload.hd).toLowerCase() : undefined;
  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (!email || !emailVerified) throw new Error('google: email not verified');
  // An email on the allowed list is accepted whatever the account type (external collaborators, for example).
  if (ALLOWED_EMAILS.includes(email)) return { email, hd };
  // When allowing by domain, the hd claim must equal that domain: only accounts managed by Workspace.
  // (The hd parameter is only a hint and cannot be trusted. A personal Google account created with a company
  // address has no hd claim.)
  const domain = emailDomain(email);
  if (ALLOWED_DOMAINS.includes(domain) && hd === domain) return { email, hd };
  throw new Error(`google: this account is not allowed (hd=${hd ?? 'none'})`);
}

// ── Refresh token state (store table mcp_refresh_tokens) ──
// Why: an HS256 JWT is stateless, so even after rotation the old refresh token stayed valid until it expired
// (30 days), and a stolen one could not be blocked.
// The jti is recorded in the store so the old token is revoked at once on rotation. If a revoked token is reused
// (a sign of theft), every active refresh token of that account is revoked. The access token (1h) stays stateless,
// so requests are not delayed.

/**
 * Records an issued refresh jti and purges expired rows while at it. Throws on failure: an unrecorded token
 * cannot be refreshed, so issuing fails as a whole.
 */
async function recordRefreshToken(jti: string, email: string, clientId: string): Promise<void> {
  const store = await getStore();
  try {
    await store.recordRefreshToken(jti, email, clientId, new Date(Date.now() + REFRESH_TTL * 1000).toISOString());
  } catch (e) {
    throw new Error(`could not record the refresh token: ${e instanceof Error ? e.message : String(e)}`);
  }
  void store.purgeExpiredRefreshTokens().catch((e: unknown) => {
    console.error('[oauth] could not purge expired refresh tokens:', e instanceof Error ? e.message : e);
  });
}

/**
 * Consumes a refresh jti (rotation). Atomically marks the row revoked, only if it is active.
 *   'ok'      : normal. Revoked, go on to issue the new token
 *   'reused'  : an already revoked jti was reused (a sign of theft), so every refresh token of the account was revoked
 *   'unknown' : not on record (old-format token, or the store lost it), so reject (sign in again)
 * Store errors throw: fail-closed (if revocation cannot be checked, no refresh is granted).
 */
async function consumeRefreshToken(jti: string, email: string, rotatedTo: string): Promise<'ok' | 'reused' | 'unknown'> {
  const store = await getStore();
  let state: 'ok' | 'revoked' | 'unknown';
  try {
    state = await store.consumeRefreshToken(jti, rotatedTo);
  } catch (e) {
    throw new Error(`could not check the refresh token: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (state !== 'revoked') return state;
  console.error(`[oauth] ⚠️ revoked refresh token reused — revoking every active refresh token of ${email}`);
  try {
    await store.revokeAllRefreshForEmail(email);
  } catch (e) {
    console.error('[oauth] could not revoke the account refresh tokens:', e instanceof Error ? e.message : e);
  }
  return 'reused';
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
  // PKCE is verified here, by the AS (it is not passed on to Google)
  skipLocalPkceValidation = false;

  /**
   * authorize: shows the consent page first. Only an approval (POST /oauth/consent) continues to Google sign-in.
   * Our own code is issued in the Google callback.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    sweep(_consentPending);
    const id = randomBytes(18).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    _consentPending.set(id, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      clientState: params.state,
      scopes: params.scopes && params.scopes.length ? params.scopes : [SCOPE],
      resource: params.resource?.href,
      exp: Date.now() / 1000 + CONSENT_TTL,
      csrf,
    });
    const secure = ISSUER.startsWith('https://') ? '; Secure' : '';
    // SameSite=Lax: the cookie is not sent on a POST auto-submitted by another site, so that site cannot approve for
    // the user.
    res.setHeader(
      'Set-Cookie',
      `${CONSENT_COOKIE}=${csrf}; Path=${CONSENT_PATH}; Max-Age=${CONSENT_TTL}; HttpOnly; SameSite=Lax${secure}`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY'); // blocks clickjacking (the approve button pressed through a transparent iframe)
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
    res
      .status(200)
      .type('html')
      .send(
        consentPage({
          appName: typeof client.client_name === 'string' && client.client_name ? client.client_name : 'An app',
          clientId: client.client_id,
          redirectUri: params.redirectUri,
          id,
          csrf,
        }),
      );
  }

  /**
   * Handles the POST from the consent page (called by POST /oauth/consent in server/http.ts).
   * Approve: continues to Google sign-in only when the form csrf, the cookie csrf and the stored csrf all match.
   * Deny: returns access_denied to the client.
   * A failed check throws, and the caller ends with a 400 (nothing is sent to an attacker's redirect_uri).
   *
   * On approval it returns loginBinding. The caller sets this value as a cookie scoped to the Google callback path.
   * The callback issues a code only when the same cookie comes back. Without this, an attacker could approve in their
   * own browser and send only the Google sign-in URL to the victim. The victim would never see the consent page, would
   * only pick a Google account, and the code would go to the attacker's redirect_uri.
   */
  consumeConsent(id: string, formCsrf: string, cookieCsrf: string, approve: boolean): { redirect: string; loginBinding?: string } {
    sweep(_consentPending);
    const pending = _consentPending.get(id);
    if (!pending) throw new Error('Unknown or expired request. Start the connection again.');
    if (
      !formCsrf ||
      !cookieCsrf ||
      !timingSafeEqualStr(formCsrf, pending.csrf) ||
      !timingSafeEqualStr(cookieCsrf, pending.csrf)
    ) {
      throw new Error('Could not verify this request. Start the connection again.');
    }
    _consentPending.delete(id);
    if (!approve) return { redirect: clientError(pending, 'access_denied', 'user cancelled') };
    const { csrf: _csrf, ...request } = pending;
    const loginBinding = randomBytes(24).toString('base64url');
    return { redirect: this.googleRedirect({ ...request, binding: loginBinding }), loginBinding };
  }

  /** Builds the Google sign-in URL and records the state. */
  private googleRedirect(pending: GooglePending): string {
    sweep(_googlePending);
    const state = randomBytes(24).toString('base64url');
    _googlePending.set(state, { ...pending, exp: Date.now() / 1000 + STATE_TTL });
    const u = new URL(GOOGLE_AUTH_URL);
    u.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    u.searchParams.set('redirect_uri', GOOGLE_CALLBACK);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('access_type', 'online');
    u.searchParams.set('prompt', 'select_account');
    // hd is only a hint for the account chooser (verification happens on the id_token). It is added only when there
    // is exactly one allowed domain and no email list.
    if (ALLOWED_DOMAINS.length === 1 && ALLOWED_EMAILS.length === 0) u.searchParams.set('hd', ALLOWED_DOMAINS[0]);
    u.searchParams.set('state', state);
    return u.toString();
  }

  /**
   * Handles the Google callback (called by the /oauth/google/callback route in server/http.ts).
   * binding is the login cookie value from the browser that approved. If it does not match this throws, and nothing
   * is sent to the client.
   * If the user cancelled at Google (error), access_denied goes back to the client redirect_uri (so the connector
   * is not left hanging).
   * On success and on failure alike, it returns the URL that sends the user back to the client redirect_uri.
   */
  async completeGoogleLogin(params: { code?: string; error?: string; state: string; binding: string }): Promise<string> {
    sweep(_googlePending);
    const pending = _googlePending.get(params.state);
    if (!pending) throw new Error('Unknown or expired sign-in. Start the connection again.');
    if (!params.binding || !timingSafeEqualStr(params.binding, pending.binding)) {
      // A callback from a different browser (someone who was forwarded the link). Discard this state.
      _googlePending.delete(params.state);
      throw new Error('This sign-in was started in a different browser. Start the connection again from your app.');
    }
    _googlePending.delete(params.state);
    const redirectErr = (err: string, desc: string) => clientError(pending, err, desc);
    if (params.error || !params.code) return redirectErr('access_denied', params.error || 'missing code');
    const googleCode = params.code;

    let email: string;
    try {
      // Exchange the Google code for an id_token
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
      return redirectErr('access_denied', e instanceof Error ? e.message : 'sign-in failed');
    }

    // Issue our own authorization code (one-time, short TTL)
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
    if (!entry || entry.exp <= Date.now() / 1000) throw new InvalidGrantError('unknown or expired authorization code');
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string, // the SDK has already verified PKCE using challengeForAuthorizationCode
    redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const entry = _authCodes.get(authorizationCode);
    if (!entry || entry.exp <= Date.now() / 1000) throw new InvalidGrantError('unknown or expired authorization code');
    _authCodes.delete(authorizationCode); // one-time
    if (entry.clientId !== client.client_id) throw new InvalidGrantError('authorization code was issued to another client');
    if (redirectUri && redirectUri !== entry.redirectUri) throw new InvalidGrantError('redirect_uri does not match');

    const scope = entry.scopes.join(' ') || SCOPE;
    const claims = { sub: entry.email, email: entry.email, scope, client_id: client.client_id };
    const access_token = await signJwt(claims, ACCESS_TTL, 'access');
    // The refresh token gets a jti that is recorded in the DB, so it can be revoked at once on rotation
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
    let tokenClientId = '';
    let grantedScopes: string[] = [];
    try {
      const { payload } = await jwtVerify(refreshToken, jwtKey(), {
        issuer: ISSUER,
        audience: RESOURCE,
        algorithms: ['HS256'],
      });
      if (payload.typ !== 'refresh') throw new Error('not a refresh token');
      email = String(payload.email || payload.sub || '');
      jti = typeof payload.jti === 'string' ? payload.jti : '';
      tokenClientId = typeof payload.client_id === 'string' ? payload.client_id : '';
      grantedScopes = String(payload.scope || SCOPE).split(' ').filter(Boolean);
    } catch {
      throw new InvalidGrantError('invalid refresh token');
    }
    // Only the client a refresh token was issued to may use it, so a leaked token cannot be exchanged through
    // another client (one registered by an attacker).
    if (!tokenClientId || tokenClientId !== client.client_id) throw new InvalidGrantError('refresh token was issued to another client');
    // The scope cannot be widened beyond the original grant.
    if (scopes && scopes.some((s) => !grantedScopes.includes(s))) throw new InvalidScopeError('requested scope exceeds the original grant');
    // Recheck the allowlist on refresh: a removed account is blocked at once even with a 30-day refresh token left.
    if (!emailAllowed(email)) throw new InvalidGrantError('this account is no longer allowed');
    // An old-format refresh token without a jti is rejected (this forces one new sign-in). The jti is consumed in the
    // DB (rotation):
    // the old token is revoked at once, and reuse of a revoked token (a sign of theft) revokes every refresh token
    // of the account.
    if (!jti) throw new InvalidGrantError('outdated refresh token; sign in again');
    const newJti = randomUUID();
    const state = await consumeRefreshToken(jti, email, newJti);
    if (state !== 'ok') throw new InvalidGrantError('refresh token was revoked; sign in again');

    const scope = (scopes && scopes.length ? scopes : grantedScopes).join(' ') || SCOPE;
    const claims = { sub: email, email, scope, client_id: client.client_id };
    const access_token = await signJwt(claims, ACCESS_TTL, 'access');
    const refresh_token = await signJwt({ ...claims, jti: newJti }, REFRESH_TTL, 'refresh'); // rotation
    await recordRefreshToken(newJti, email, client.client_id);
    return { access_token, token_type: 'Bearer', expires_in: ACCESS_TTL, scope, refresh_token };
  }

  /** RS: verifies an access token (used by requireBearerAuth and by our /mcp dual-auth) */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { payload } = await jwtVerify(token, jwtKey(), {
      issuer: ISSUER,
      audience: RESOURCE,
      algorithms: ['HS256'], // pin alg (blocks none/RS256 confusion)
    });
    if (payload.typ === 'refresh') throw new Error('a refresh token cannot be used as an access token');
    const email = typeof payload.sub === 'string' ? payload.sub : '';
    // Recheck the allowlist on every request: once an account is removed, even an unexpired token is rejected at once.
    if (!emailAllowed(email)) throw new Error('this account is no longer allowed');
    const scopes = String(payload.scope || '').split(' ').filter(Boolean);
    return {
      token,
      clientId: String(payload.client_id || ''),
      scopes,
      expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
      resource: new URL(RESOURCE),
      extra: { email },
    };
  }
}

export const oauthProvider = new KnowledgeOAuthProvider();
