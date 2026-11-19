/**
 * Adding another service's MCP server from the console (Notion, Supabase, Linear, …).
 *
 * Such a server brings its own tools; the gateway (core/upstream.ts) shows them under the service's name, behind
 * this server's keys and permissions, and by default only the ones that read. Three ways in:
 *
 *   sign in    the server follows the MCP authorization spec: it says where to sign in and lets this server
 *              register itself. Nothing is created by hand at the service.
 *   a token    the service gives tokens: it goes to .env.
 *   nothing    the server is open.
 *
 * The sign-in itself (leaving the page, the return, saving) is the three-step flow in logins.ts; this file is
 * what is specific to MCP servers.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverOAuthServerInfo, exchangeAuthorization, startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import type { AuthorizationServerMetadata, OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';
import { probeUpstream } from '../core/upstream.js';
import { forgetUpstreamLogin, readUpstreamLogin, UPSTREAM_NAME, withTokens, writeUpstreamLogin, type UpstreamLogin } from '../core/upstream_login.js';
import { readConfigFile } from '../setup/commands.js';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const TIMEOUT_MS = 20_000;

export interface McpTarget {
  name: string;
  url: string;
}
/** An entry of `upstreams` in mcp.config.json, as the console writes it. */
export interface UpstreamEntry {
  name: string;
  url: string;
  prefix?: string;
  tokenEnv?: string;
  signIn?: boolean;
  headers?: Record<string, string>;
  expose?: 'read' | 'all' | string[];
}

export const prefixOf = (e: Pick<UpstreamEntry, 'name' | 'prefix'>): string => e.prefix ?? `${e.name.replace(/-/g, '_')}_`;
/** The env var a token pasted in the console is kept under. */
export const tokenEnvOf = (name: string): string => `${name.replace(/-/g, '_').toUpperCase()}_MCP_TOKEN`;

/** The address of an MCP server: https, or http on this machine (a server being developed). */
export function mcpAddress(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('That is not an address. It looks like https://mcp.example.com/mcp');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('The address must start with https://');
  if (u.username || u.password) throw new Error('Leave the user name and password out of the address. A token goes in the token field.');
  u.hash = '';
  return u.href;
}

export function upstreamEntries(dir: string): UpstreamEntry[] {
  const list: unknown = readConfigFile(dir).upstreams;
  return (Array.isArray(list) ? list : []).filter((e): e is UpstreamEntry => !!e && typeof (e as UpstreamEntry).name === 'string' && typeof (e as UpstreamEntry).url === 'string');
}

function writeEntries(dir: string, entries: UpstreamEntry[]): void {
  const config = readConfigFile(dir);
  if (entries.length) config.upstreams = entries;
  else delete config.upstreams;
  writeFileSync(join(dir, 'mcp.config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

/** Add the entry, or replace the one of the same name. What was set on it by hand (prefix, expose, headers) stays. */
export function upsertUpstream(dir: string, entry: UpstreamEntry): void {
  const entries = upstreamEntries(dir);
  const at = entries.findIndex((e) => e.name === entry.name);
  if (at < 0) return writeEntries(dir, [...entries, entry]);
  const { tokenEnv: _t, signIn: _s, ...kept } = entries[at];
  entries[at] = { ...kept, ...entry };
  writeEntries(dir, entries);
}

export function removeUpstream(dir: string, name: string): UpstreamEntry | null {
  const entries = upstreamEntries(dir);
  const found = entries.find((e) => e.name === name) ?? null;
  if (found) writeEntries(dir, entries.filter((e) => e.name !== name));
  return found;
}

/** Check a name and an address before anything is asked of the remote. `taken` are names something else has. */
export function mcpTarget(dir: string, input: { name: string; url: string }, taken: Set<string>): McpTarget {
  const name = input.name.trim().toLowerCase();
  if (!UPSTREAM_NAME.test(name)) throw new Error('The name is lowercase letters, digits and dashes, starting with a letter: its tools are named after it.');
  if (taken.has(name)) throw new Error(`"${name}" is the name of something this server already has. Pick another.`);
  const url = mcpAddress(input.url);
  const other = upstreamEntries(dir).find((e) => e.name === name);
  if (other && other.url !== url) throw new Error(`"${name}" is already in the list with another address. Remove it first, or pick another name.`);
  const prefix = prefixOf(other ?? { name });
  const clash = upstreamEntries(dir).find((e) => e.name !== name && prefixOf(e) === prefix);
  if (clash) throw new Error(`"${name}" would name its tools like "${clash.name}" does (${prefix}…). Pick another name.`);
  return { name, url };
}

/** Does the server want a sign-in? Asked the way a client would start: an MCP request without a token. */
export async function needsSignIn(url: string): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'knowledge-mcp-gateway', version: '1' } } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause;
    throw new Error(`Could not reach ${new URL(url).host} (${cause?.code ?? msg(e)}).`);
  }
  await res.body?.cancel().catch(() => {});
  if (res.status === 401) return true;
  if (res.ok) return false;
  throw new Error(`${new URL(url).host} answered ${res.status} to an MCP request. Is this the address of its MCP server?`);
}

/** What the tools of a remote look like through the read-only gateway, in words. */
export const toolsFound = (r: { tools: number; shown: number }): string =>
  r.tools === r.shown ? `${r.tools} tool${r.tools === 1 ? '' : 's'}` : `${r.shown} of its ${r.tools} tools (the rest change things and stay off)`;

// ── Signing in ──

/** What a sign-in under way has to remember between leaving the page and coming back. */
export interface McpCarry {
  target: McpTarget;
  issuer: string;
  metadata: AuthorizationServerMetadata;
  resource?: string;
  client: OAuthClientInformationMixed;
  redirectUri: string;
  /** Registered for this attempt (and to be taken back if it comes to nothing). */
  fresh: boolean;
}
export interface McpResult {
  name: string;
  url: string;
  login: UpstreamLogin;
  tools: number;
  shown: number;
}

/**
 * Find out where the server signs people in, register this installation there if it is not yet, and make the
 * address to open. `state` comes back with the browser; the verifier stays here.
 */
export async function prepareMcpSignIn(redirectUri: string, target: McpTarget, state: string): Promise<{ url: string; verifier: string; carry: McpCarry }> {
  const host = new URL(target.url).host;
  const manual = `${host} asks for a sign-in this server cannot start by itself. If the service gives tokens, paste one instead.`;
  let info;
  try {
    info = await discoverOAuthServerInfo(target.url);
  } catch (e) {
    throw new Error(`${manual} (${msg(e).slice(0, 160)})`);
  }
  const metadata = info.authorizationServerMetadata;
  if (!metadata?.authorization_endpoint || !metadata.token_endpoint) throw new Error(manual);
  const issuer = info.authorizationServerUrl;
  // What the server says a client should ask for. A refresh token is asked for where it has to be asked for.
  let scope = info.resourceMetadata?.scopes_supported?.join(' ') || undefined;
  if (scope && metadata.scopes_supported?.includes('offline_access') && !scope.split(' ').includes('offline_access')) scope += ' offline_access';
  const resource = info.resourceMetadata?.resource;

  const saved = readUpstreamLogin(target.name);
  let client = saved && saved.url === target.url && saved.issuer === issuer && saved.redirectUri === redirectUri ? saved.client : null;
  const fresh = !client;
  if (!client) {
    if (!metadata.registration_endpoint) throw new Error(`${host} wants an app registered with it by hand before anyone can sign in. If the service gives tokens, paste one instead.`);
    try {
      client = await register(metadata.registration_endpoint, redirectUri, scope);
    } catch (e) {
      throw new Error(`${host} did not register this server (${msg(e).slice(0, 200)}). If the service gives tokens, paste one instead.`);
    }
  }
  const { authorizationUrl, codeVerifier } = await startAuthorization(issuer, { metadata, clientInformation: client, redirectUrl: redirectUri, scope, state, resource });
  return { url: authorizationUrl.href, verifier: codeVerifier, carry: { target, issuer, metadata, resource, client, redirectUri, fresh } };
}

/**
 * Register this installation at the authorization server (RFC 7591). No secret is asked for: it proves itself
 * with PKCE. "native" is what lets an http://localhost return address through where the server follows OpenID's
 * rules. The whole answer is kept, including the address and token that take the registration back, where given.
 */
async function register(endpoint: string, redirectUri: string, scope: string | undefined): Promise<OAuthClientInformationMixed> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Knowledge MCP',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      ...(scope ? { scope } : {}),
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.client_id !== 'string' || !body.client_id) {
    throw new Error(String(body.error_description ?? body.error ?? `answer ${res.status}`));
  }
  return body as unknown as OAuthClientInformationMixed;
}

/** The browser is back with a code: trade it for tokens, and look at the tools with them before anything is saved. */
export async function completeMcpSignIn(carry: McpCarry, code: string, verifier: string): Promise<McpResult> {
  const tokens = await exchangeAuthorization(carry.issuer, {
    metadata: carry.metadata,
    clientInformation: carry.client,
    authorizationCode: code,
    codeVerifier: verifier,
    redirectUri: carry.redirectUri,
    resource: carry.resource,
  });
  const login = withTokens({ url: carry.target.url, issuer: carry.issuer, metadata: carry.metadata, resource: carry.resource, client: carry.client, redirectUri: carry.redirectUri }, tokens);
  const seen = await probeUpstream({ name: carry.target.name, url: carry.target.url, prefix: prefixOf(carry.target), token: tokens.access_token });
  return { name: carry.target.name, url: carry.target.url, login, ...seen };
}

/** Save a finished sign-in: its file, and the server in the list. */
export function saveMcpSignIn(dir: string, r: McpResult): string {
  writeUpstreamLogin(r.name, r.login);
  upsertUpstream(dir, { name: r.name, url: r.url, signIn: true });
  return toolsFound(r);
}

/** Only ever to the authorization server itself: these addresses came from its answers. */
const sameSite = (address: unknown, issuer: string): address is string => {
  try {
    return typeof address === 'string' && new URL(address).origin === new URL(issuer).origin;
  } catch {
    return false;
  }
};

/** Take a registration back where the service offers that (most do not). Best effort. */
export async function unregister(client: OAuthClientInformationMixed, issuer: string): Promise<void> {
  const c = client as { registration_client_uri?: unknown; registration_access_token?: unknown };
  if (!sameSite(c.registration_client_uri, issuer) || typeof c.registration_access_token !== 'string') return;
  await fetch(c.registration_client_uri, { method: 'DELETE', headers: { Authorization: `Bearer ${c.registration_access_token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => undefined);
}

/** Take a sign-in away: its file, and (best effort) the permission and the registration at the service. */
export async function signOutMcp(name: string): Promise<void> {
  const login = readUpstreamLogin(name);
  forgetUpstreamLogin(name);
  if (!login) return;
  const revoke = (login.metadata as { revocation_endpoint?: unknown } | undefined)?.revocation_endpoint;
  const token = login.refreshToken ?? login.accessToken;
  if (token && sameSite(revoke, login.issuer)) {
    await fetch(revoke, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: login.client.client_id }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => undefined);
  }
  await unregister(login.client, login.issuer);
}
