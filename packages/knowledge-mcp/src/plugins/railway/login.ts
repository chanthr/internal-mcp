/**
 * Railway through a sign-in instead of a pasted token.
 *
 * Railway lets an app register itself (OAuth dynamic client registration) and sign a person in with PKCE, so
 * nobody has to make a token and carry it over by hand. The console starts the sign-in; what comes back is kept
 * here, in a file only the owner can read: this installation's registration, the refresh token and the access
 * token in use.
 *
 * An access token lasts an hour and the refresh token changes each time it is used. Every server on this data
 * directory (the HTTP server and each stdio session a client starts) reads the same file, so a refresh is done by
 * one process at a time and the others read what it wrote.
 *
 * RAILWAY_TOKEN, when set, is used as before and this file is not looked at.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, releaseLock } from '../../core/lock.js';
import { dataDir } from '../../core/paths.js';

/** Where Railway signs people in and answers the API for a signed-in app. An object so tests can point it at a fake. */
export const railwayEndpoints = {
  issuer: 'https://backboard.railway.com',
  api: 'https://backboard.railway.com/graphql/v2',
};
/** The API address a pasted token has always been used with. */
const TOKEN_API = 'https://backboard.railway.app/graphql/v2';

/**
 * What the sign-in asks for: who signed in, a refresh token, and viewer access to the workspaces the person picks
 * on Railway's consent screen. The server only reads.
 */
export const RAILWAY_SCOPE = 'openid email offline_access workspace:viewer';

export interface RailwayClient {
  id: string;
  /** The address Railway sends the browser back to. It is part of the registration and must match exactly. */
  redirectUri: string;
  /** Where the registration can be changed or deleted, and the token that allows it. */
  registrationUri?: string;
  registrationToken?: string;
}
export interface RailwayLogin {
  client?: RailwayClient;
  refreshToken?: string;
  accessToken?: string;
  /** When the access token stops working (ms since 1970). */
  expiresAt?: number;
  /** Who signed in, for showing. */
  who?: string;
}

const file = () => join(dataDir(), 'railway-login.json');

export function readRailwayLogin(): RailwayLogin {
  try {
    const j = JSON.parse(readFileSync(file(), 'utf8'));
    return j && typeof j === 'object' ? (j as RailwayLogin) : {};
  } catch {
    return {};
  }
}

/** Written whole and swapped in, so another process never reads half a file. */
export function writeRailwayLogin(login: RailwayLogin): void {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file());
  cached = null;
}

export function forgetRailwayLogin(): void {
  rmSync(file(), { force: true });
  cached = null;
}

/** Has somebody signed in here (and not out)? */
export function railwaySignedIn(): boolean {
  const l = readRailwayLogin();
  return !!l.refreshToken && !!l.client?.id;
}

const TIMEOUT_MS = 20_000;

async function post(url: string, init: RequestInit, what: string): Promise<{ status: number; json: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause;
    throw new Error(`Railway: ${what} did not get through (${cause?.code ?? (e instanceof Error ? e.message : String(e))}).`);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** Register this installation as a public client (no secret; it proves itself with PKCE) for one return address. */
export async function registerRailwayClient(redirectUri: string): Promise<RailwayClient> {
  const { status, json } = await post(
    `${railwayEndpoints.issuer}/oauth/register`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Knowledge MCP (this computer)',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
      }),
    },
    'the registration',
  );
  if (status >= 300 || typeof json.client_id !== 'string') {
    throw new Error(`Railway did not register this server (${status}${json.error_description ? `: ${String(json.error_description).slice(0, 160)}` : ''}). Try again in a minute, or paste a token instead.`);
  }
  return {
    id: json.client_id,
    redirectUri,
    registrationUri: typeof json.registration_client_uri === 'string' ? json.registration_client_uri : undefined,
    registrationToken: typeof json.registration_access_token === 'string' ? json.registration_access_token : undefined,
  };
}

/** Take the registration back. Best effort: a registration nobody signs in with does nothing. */
export async function deleteRailwayClient(client: RailwayClient | undefined): Promise<void> {
  if (!client?.registrationUri || !client.registrationToken) return;
  // Only ever to Railway: the address came from Railway's answer, and the file could have been edited since.
  if (!client.registrationUri.startsWith(`${railwayEndpoints.issuer}/`)) return;
  await fetch(client.registrationUri, { method: 'DELETE', headers: { Authorization: `Bearer ${client.registrationToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => undefined);
}

export interface RailwayTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

/** One call to the token endpoint: a code or a refresh token goes in, tokens come out. */
export async function railwayTokenRequest(form: Record<string, string>): Promise<RailwayTokens> {
  const { status, json } = await post(
    `${railwayEndpoints.issuer}/oauth/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) },
    'the sign-in',
  );
  if (status >= 300 || typeof json.access_token !== 'string') {
    const why = String(json.error_description ?? json.error ?? `answer ${status}`).slice(0, 160);
    const e = new Error(`Railway refused the sign-in (${why}).`);
    (e as { code?: string }).code = typeof json.error === 'string' ? json.error : undefined;
    throw e;
  }
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    expiresAt: Date.now() + (typeof json.expires_in === 'number' ? json.expires_in : 3600) * 1000,
  };
}

const SIGN_IN_AGAIN = 'Railway: the sign-in is no longer valid. Open the console (Apps → Railway) and sign in again, or set RAILWAY_TOKEN.';
const LOCK = 'railway-login';
const fresh = (expiresAt: number | undefined): boolean => !!expiresAt && expiresAt - 60_000 > Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cached: { token: string; expiresAt: number } | null = null;
let refreshing: Promise<string> | null = null;

/** The token to call Railway with, and the API address it belongs to. */
export async function railwayAuth(): Promise<{ token: string; api: string }> {
  const fixed = (process.env.RAILWAY_TOKEN || process.env.RAILWAY_MCP_TOKEN)?.trim();
  if (fixed) return { token: fixed, api: TOKEN_API };
  if (cached && fresh(cached.expiresAt)) return { token: cached.token, api: railwayEndpoints.api };
  refreshing ??= currentToken().finally(() => {
    refreshing = null;
  });
  return { token: await refreshing, api: railwayEndpoints.api };
}

/** Is there anything to call Railway with? */
export function railwayConfigured(): boolean {
  return !!(process.env.RAILWAY_TOKEN || process.env.RAILWAY_MCP_TOKEN)?.trim() || railwaySignedIn();
}

async function currentToken(): Promise<string> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const saved = readRailwayLogin();
    if (saved.accessToken && fresh(saved.expiresAt)) {
      cached = { token: saved.accessToken, expiresAt: saved.expiresAt! };
      return saved.accessToken;
    }
    if (!saved.refreshToken || !saved.client?.id) throw new Error(SIGN_IN_AGAIN);
    // Another process is getting a new token right now: wait for what it writes instead of spending the same
    // refresh token twice.
    if (!acquireLock(LOCK, 60_000)) {
      await sleep(250);
      continue;
    }
    try {
      const now = readRailwayLogin(); // it may have been renewed between the read and the lock
      if (now.accessToken && fresh(now.expiresAt)) continue;
      if (!now.refreshToken || !now.client?.id) throw new Error(SIGN_IN_AGAIN);
      let t: RailwayTokens;
      try {
        t = await railwayTokenRequest({ grant_type: 'refresh_token', refresh_token: now.refreshToken, client_id: now.client.id });
      } catch (e) {
        // Railway says the refresh token is spent or withdrawn: only a new sign-in helps.
        if ((e as { code?: string }).code === 'invalid_grant') throw new Error(SIGN_IN_AGAIN);
        throw e;
      }
      writeRailwayLogin({ ...now, accessToken: t.accessToken, refreshToken: t.refreshToken ?? now.refreshToken, expiresAt: t.expiresAt });
      cached = { token: t.accessToken, expiresAt: t.expiresAt };
      return t.accessToken;
    } finally {
      releaseLock(LOCK);
    }
  }
  throw new Error('Railway: another process has been renewing the sign-in for too long. Try again.');
}
