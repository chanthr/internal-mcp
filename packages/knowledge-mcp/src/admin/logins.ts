/**
 * Connecting a service by signing in, instead of making a token somewhere and pasting it.
 *
 *   Railway   The server registers itself with Railway (nothing to create by hand, no secret) and the person signs
 *             in in the browser, picking the workspaces it may read.
 *   Google    Google lets no shared app read Drive without reviewing that app, so the sign-in runs through an OAuth
 *             client of the person's own Google Cloud project: made once, then "Sign in with Google".
 *   MCP       Another service's MCP server (Notion, Supabase, …) that follows the MCP authorization spec: it
 *             says where to sign in and lets this server register itself (upstreams.ts).
 *   GitHub    The gh CLI is signed in on many machines already: its login is reused.
 *   gcloud    Creates the Drive service account, for those who would rather share documents with an account.
 *
 * A sign-in leaves the console page and comes back, so it has three steps:
 *
 *   start    console API (console token needed). Makes the address to open, and remembers a `state` and a PKCE
 *            verifier for ten minutes.
 *   return   a plain page request: the browser comes back from the other site and carries no console token. A code
 *            is accepted only with a `state` this server handed out; it is traded for tokens, and the result waits
 *            in memory. Nothing is written.
 *   finish   console API (console token needed). Saves what is waiting and restarts the server, like every other
 *            change made in the console.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from '../core/data_file.js';
import { dataDir } from '../core/paths.js';
import {
  deleteRailwayClient,
  forgetRailwayLogin,
  railwayScope,
  railwayEndpoints,
  railwayTokenRequest,
  readRailwayLogin,
  registerRailwayClient,
  writeRailwayLogin,
  type RailwayClient,
  type RailwayTokens,
} from '../plugins/railway/login.js';
import { railwayProjects } from '../plugins/railway/tools.js';
import { backgroundExec, gcloudAccount, gcloudDefaultProject, gcloudProjects, ghToken, hasTool, type Exec, type GcloudProject, GCLOUD_SIGN_IN } from '../setup/auto.js';
import { readConfigFile, writeConfigFile } from '../setup/commands.js';
import { readEnvValues, updateEnvFile } from '../setup/envfile.js';
import { completeMcpSignIn, prepareMcpSignIn, saveMcpSignIn, unregister, type McpCarry, type McpResult, type McpTarget } from './upstreams.js';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Google's addresses. An object so tests can point them at a fake. */
export const googleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  drive: 'https://www.googleapis.com/drive/v3',
};
/** Where the account behind a gh login is asked for. Unset: GitHub itself. */
export const githubEndpoint: { api?: string } = {};
const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';
/** The `source` label of documents under the folders a sign-in added. */
export const GOOGLE_LOGIN_SOURCE = 'drive';
const FOLDER = 'application/vnd.google-apps.folder';
const TIMEOUT_MS = 20_000;
const LIFETIME_MS = 10 * 60_000;

export type LoginService = 'railway' | 'google' | 'mcp';
/** The console page a sign-in returns to. */
const PAGE: Record<LoginService, string> = { railway: '/console/#/apps', google: '/console/#/documents', mcp: '/console/#/apps' };

// ── What is under way, and what came back ──

interface Pending {
  service: LoginService;
  verifier: string;
  redirectUri: string;
  until: number;
  railway?: RailwayClient;
  google?: { clientId: string; clientSecret: string; folders: string[] | null };
  mcp?: McpCarry;
}
const pending = new Map<string, Pending>();

type Finished =
  | { service: LoginService; error: string }
  | { service: 'railway'; client: RailwayClient; tokens: RailwayTokens; who: string; sees: string }
  | { service: 'google'; clientId: string; clientSecret: string; refreshToken: string; account: string; roots: Array<{ id: string; name: string }> }
  | { service: 'mcp'; carry: McpCarry; result: McpResult };
let finished: Finished | null = null;
let finishedAt = 0;
function keep(result: Finished): void {
  finished = result;
  finishedAt = Date.now();
}
/**
 * What came back and has not been saved. It holds tokens, so it does not wait for ever: a browser that returned and
 * then never opened the console again (closed, or the token was not in it) leaves nothing behind after ten minutes.
 */
function waiting(): Finished | null {
  if (finished && Date.now() - finishedAt > LIFETIME_MS) {
    const stale = finished;
    finished = null;
    if (!('error' in stale) && stale.service === 'railway' && stale.client.id !== readRailwayLogin().client?.id) void deleteRailwayClient(stale.client);
    if (!('error' in stale) && stale.service === 'mcp' && stale.carry.fresh) void unregister(stale.carry.client, stale.carry.issuer);
  }
  return finished;
}

/** Is a sign-in back and waiting to be saved? The page asks, and then calls finish. */
export function loginWaiting(): { service: LoginService } | null {
  const w = waiting();
  return w ? { service: w.service } : null;
}

/** A registration made for a sign-in that never came back is of no use to anyone. */
function discard(p: Pending): void {
  if (p.railway && p.railway.id !== readRailwayLogin().client?.id) void deleteRailwayClient(p.railway);
  if (p.mcp?.fresh) void unregister(p.mcp.client, p.mcp.issuer);
}
function prune(): void {
  for (const [state, p] of pending) {
    if (Date.now() > p.until) {
      pending.delete(state);
      discard(p);
    }
  }
  // A person starts one sign-in at a time. More than a few waiting is a page clicked over and over.
  while (pending.size > 8) {
    const [state, p] = pending.entries().next().value as [string, Pending];
    pending.delete(state);
    discard(p);
  }
}

function remember(p: Omit<Pending, 'verifier' | 'until'>): { state: string; challenge: string } {
  prune();
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  pending.set(state, { ...p, verifier, until: Date.now() + LIFETIME_MS });
  return { state, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function json(url: string, init: RequestInit, what: string): Promise<{ status: number; body: Record<string, any> }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause;
    throw new Error(`${what}: could not reach ${new URL(url).host} (${cause?.code ?? msg(e)}).`);
  }
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

// ── Railway ──

/** The address that signs a person in to Railway. `origin` is how the console page was opened (http://localhost:PORT). */
export async function startRailwayLogin(origin: string, opts: { logs?: boolean } = {}): Promise<string> {
  const redirectUri = `${origin}/console/login/railway`;
  // Viewer access, or member access for a person who asked to read logs as well.
  const scope = railwayScope(opts.logs === true);
  const saved = readRailwayLogin().client;
  // The return address and what is asked for are part of the registration. Opened on another port, or registered
  // by a version that asked for less, the server registers again. The old one is deleted when the new one is saved.
  const client = saved && saved.redirectUri === redirectUri && saved.scope === scope ? saved : await registerRailwayClient(redirectUri, scope);
  const { state, challenge } = remember({ service: 'railway', redirectUri, railway: client });
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.id,
    redirect_uri: redirectUri,
    scope,
    state,
    prompt: 'consent', // Railway gives a refresh token only when the consent screen was shown
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${railwayEndpoints.issuer}/oauth/auth?${query}`;
}

/**
 * Who signed in and what they shared, asked with the new token before anything is saved. A sign-in that shows no
 * workspace is of no use and is not kept: this throws what to do about it, in words for the page.
 */
async function railwaySees(token: string): Promise<{ who: string; sees: string }> {
  const me = (await json(`${railwayEndpoints.issuer}/oauth/me`, { headers: { Authorization: `Bearer ${token}` } }, 'Railway')).body;
  const who = String(me.email ?? me.name ?? 'a Railway account');
  const { projects, workspaces } = await railwayProjects({ token, api: railwayEndpoints.api, via: 'login' }, 'page');
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return { who, sees: `${count(workspaces?.length ?? 0, 'workspace')}, ${count(projects.length, 'project')} visible` };
}

async function railwayResult(p: Pending, code: string): Promise<Finished> {
  const client = p.railway!;
  const tokens = await railwayTokenRequest({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: client.id, code_verifier: p.verifier });
  if (!tokens.refreshToken) throw new Error('Railway signed you in for an hour only (it sent no refresh token). Sign in again and approve on the consent screen, or paste a token instead.');
  return { service: 'railway', client, tokens, ...(await railwaySees(tokens.accessToken)) };
}

export async function signOutRailway(): Promise<void> {
  const login = readRailwayLogin();
  forgetRailwayLogin();
  await deleteRailwayClient(login.client);
}

// ── Another service's MCP server ──

/** The address that signs a person in to the service behind an MCP server (what is specific to it: upstreams.ts). */
export async function startMcpLogin(origin: string, target: McpTarget): Promise<{ url: string; at: string }> {
  prune();
  const state = randomBytes(24).toString('base64url');
  const redirectUri = `${origin}/console/login/mcp`;
  const { url, verifier, carry, at } = await prepareMcpSignIn(redirectUri, target, state);
  pending.set(state, { service: 'mcp', verifier, redirectUri, until: Date.now() + LIFETIME_MS, mcp: carry });
  return { url, at };
}

// ── Google ──

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}
interface GoogleLoginFile {
  type: 'authorized_user';
  client_id: string;
  client_secret: string;
  refresh_token: string;
  /** Who signed in, for showing. */
  account?: string;
  /** The Drive folders this sign-in added to drive.roots: they go when it goes. */
  roots?: string[];
}

/** Where the sign-in is kept: the format Google's own tools use for a signed-in user, which the Drive client reads. */
export const googleLoginPath = () => join(dataDir(), 'google-login.json');

export function readGoogleLogin(): GoogleLoginFile | null {
  try {
    const j = JSON.parse(readFileSync(googleLoginPath(), 'utf8'));
    return j?.type === 'authorized_user' && typeof j.refresh_token === 'string' ? (j as GoogleLoginFile) : null;
  } catch {
    return null;
  }
}

/** Is Drive connected through a sign-in (and not a key)? `envPath` is the .env the console writes. */
export function driveUsesLogin(dir: string): boolean {
  const set = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() || readEnvValues(join(dir, '.env')).get('GOOGLE_APPLICATION_CREDENTIALS');
  return !!set && !process.env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim() && resolve(dir, set) === googleLoginPath() && !!readGoogleLogin();
}

/** What was typed as the OAuth client: its ID and secret, or the JSON file Google offers for download. */
export function parseGoogleClient(idOrJson: string, secret: string): GoogleClient {
  let clientId = idOrJson.trim();
  let clientSecret = secret.trim();
  if (clientId.startsWith('{')) {
    let j: Record<string, any>;
    try {
      j = JSON.parse(clientId);
    } catch {
      throw new Error('That is not the JSON of an OAuth client. Paste the client ID, or the whole downloaded file.');
    }
    if (j.type === 'service_account') throw new Error('That is a service account key, not an OAuth client. Use "Paste a service account key" for it.');
    const c = j.installed ?? j.web ?? j;
    clientId = String(c.client_id ?? '').trim();
    clientSecret = String(c.client_secret ?? '').trim() || clientSecret;
  }
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('The client ID ends with .apps.googleusercontent.com. Copy it from the OAuth client in Google Cloud.');
  if (clientSecret.length < 10 || /\s/.test(clientSecret)) throw new Error('The client secret is missing. It is shown next to the client ID when the OAuth client is created.');
  return { clientId, clientSecret };
}

/** Folder IDs from what was typed: the address of a folder opened in Drive, or the ID itself. */
export function driveFolderIds(lines: string[]): string[] {
  const ids: string[] = [];
  for (const raw of lines) {
    const s = raw.trim();
    if (!s) continue;
    const m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s) ?? /^([A-Za-z0-9_-]{10,})$/.exec(s);
    if (!m) throw new Error(`"${s.slice(0, 60)}" is not a Drive folder. Open the folder in Drive and copy the address from the browser.`);
    ids.push(m[1]);
  }
  return [...new Set(ids)];
}

/**
 * The address that signs a person in to Google. Without `client`, the one of the last sign-in is used (signing in
 * again after Google ended the session). `folders` null means all of My Drive.
 */
export function startGoogleLogin(origin: string, input: { client?: GoogleClient; folders: string[] | null }): string {
  const saved = readGoogleLogin();
  const client = input.client ?? (saved ? { clientId: saved.client_id, clientSecret: saved.client_secret } : null);
  if (!client) throw new Error('Enter the client ID and the client secret of your OAuth client first.');
  const redirectUri = `${origin}/console/login/google`;
  const { state, challenge } = remember({ service: 'google', redirectUri, google: { ...client, folders: input.folders } });
  const query = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_READONLY,
    access_type: 'offline',
    prompt: 'consent', // without it Google gives a refresh token on the first sign-in only
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${googleEndpoints.auth}?${query}`;
}

async function googleResult(p: Pending, code: string): Promise<Finished> {
  const g = p.google!;
  const t = await json(
    googleEndpoints.token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: p.redirectUri, code_verifier: p.verifier }),
    },
    'Google',
  );
  if (t.status >= 300 || typeof t.body.access_token !== 'string') {
    throw new Error(`Google refused the sign-in (${String(t.body.error_description ?? t.body.error ?? `answer ${t.status}`).slice(0, 200)}). Check the client secret.`);
  }
  if (typeof t.body.refresh_token !== 'string') throw new Error('Google signed you in for an hour only (it sent no refresh token). Sign in again and approve on the consent screen.');
  if (typeof t.body.scope === 'string' && !t.body.scope.split(' ').includes(DRIVE_READONLY)) throw new Error('The sign-in did not include reading Drive. Sign in again and leave that box ticked.');

  const get = async (path: string, what: string): Promise<Record<string, any>> => {
    const r = await json(`${googleEndpoints.drive}${path}`, { headers: { Authorization: `Bearer ${t.body.access_token}` } }, 'Google Drive');
    if (r.status === 404) throw new Error(`${what} was not found with this Google account.`);
    if (r.status >= 300) {
      const why = String(r.body.error?.message ?? `answer ${r.status}`).slice(0, 300);
      // The usual one: the project the OAuth client belongs to has never had the Drive API switched on.
      throw new Error(/has not been used|is disabled/i.test(why) ? `The Google Drive API is off in the project of your OAuth client. Switch it on (APIs & Services → Library → Google Drive API), wait a minute and sign in again.` : `Google Drive: ${why}`);
    }
    return r.body;
  };
  const about = await get('/about?fields=user(emailAddress,displayName)', 'The account');
  const account = String(about.user?.emailAddress ?? about.user?.displayName ?? 'a Google account');
  const roots: Array<{ id: string; name: string }> = [];
  if (!g.folders) {
    // "root" is an alias. Files name their parent by its real ID, so that is what the settings must hold.
    const root = await get('/files/root?fields=id,name', 'My Drive');
    roots.push({ id: String(root.id), name: String(root.name ?? 'My Drive') });
  } else {
    for (const id of g.folders) {
      const f = await get(`/files/${encodeURIComponent(id)}?fields=id,name,mimeType&supportsAllDrives=true`, `The folder ${id}`);
      if (f.mimeType !== FOLDER) throw new Error(`"${String(f.name ?? id)}" is a file, not a folder. Give the address of the folder it is in.`);
      roots.push({ id: String(f.id), name: String(f.name ?? id) });
    }
  }
  return { service: 'google', clientId: g.clientId, clientSecret: g.clientSecret, refreshToken: t.body.refresh_token, account, roots };
}

/** drive.roots without the folders a sign-in had added, plus `add`. */
function writeRoots(dir: string, drop: Set<string>, add: Array<{ id: string; name: string }>): void {
  const config = readConfigFile(dir);
  const current: Array<{ id?: string }> = Array.isArray(config.drive?.roots) ? config.drive.roots : [];
  const kept = current.filter((r) => !drop.has(String(r?.id)) && !add.some((a) => a.id === r?.id));
  const roots = [...kept, ...add.map((a) => ({ id: a.id, name: a.name, source: GOOGLE_LOGIN_SOURCE }))];
  if (roots.length === 0 && current.length === 0) return;
  config.drive = { ...(config.drive ?? {}), roots };
  writeConfigFile(dir, config);
}

/** Take the Google sign-in away: its file, the folders it added, and (best effort) the permission at Google. */
export async function signOutGoogle(dir: string): Promise<void> {
  const login = readGoogleLogin();
  rmSync(googleLoginPath(), { force: true });
  if (!login) return;
  if (login.roots?.length) writeRoots(dir, new Set(login.roots), []);
  await fetch(googleEndpoints.revoke, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: login.refresh_token }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => undefined);
}

// ── The return from the other site, and saving ──

/**
 * The browser is back from Railway or Google. Returns the console page to show next.
 * A request whose `state` this server did not hand out changes nothing: it is not the end of a sign-in started here.
 */
export async function completeLogin(service: string, query: Record<string, unknown>): Promise<string> {
  prune();
  const state = typeof query.state === 'string' ? query.state : '';
  const p = pending.get(state);
  if (!p || p.service !== service) return '/console/';
  pending.delete(state); // a state is good for one return
  if (typeof query.code !== 'string' || !query.code || query.error) {
    discard(p);
    const why = String(query.error_description ?? query.error ?? 'no code came back').slice(0, 160);
    keep({ service: p.service, error: query.error === 'access_denied' ? 'The sign-in was cancelled. Nothing was changed.' : `The sign-in did not finish (${why}). Nothing was changed.` });
    return PAGE[p.service];
  }
  try {
    if (p.service === 'mcp') keep({ service: 'mcp', carry: p.mcp!, result: await completeMcpSignIn(p.mcp!, query.code, p.verifier) });
    else keep(p.service === 'railway' ? await railwayResult(p, query.code) : await googleResult(p, query.code));
  } catch (e) {
    discard(p);
    keep({ service: p.service, error: msg(e) });
  }
  return PAGE[p.service];
}

/**
 * Save the sign-in that is waiting. `dir` holds .env and mcp.config.json. Throws what went wrong at the other site.
 * `label` is what the page calls the thing that is now connected.
 */
export async function finishLogin(dir: string): Promise<{ service: LoginService; label: string; found: string }> {
  const done = waiting();
  finished = null;
  if (!done) throw new Error('No sign-in is waiting to be saved. Start it again.');
  if ('error' in done) throw new Error(done.error);
  if (done.service === 'railway') {
    const before = readRailwayLogin().client;
    writeRailwayLogin({ client: done.client, refreshToken: done.tokens.refreshToken, accessToken: done.tokens.accessToken, expiresAt: done.tokens.expiresAt, who: done.who });
    if (before && before.id !== done.client.id) void deleteRailwayClient(before);
    return { service: 'railway', label: 'Railway', found: `${done.who}, ${done.sees}` };
  }
  if (done.service === 'mcp') return { service: 'mcp', label: done.result.name, found: saveMcpSignIn(dir, done.result) };
  const previous = readGoogleLogin();
  const file: GoogleLoginFile = {
    type: 'authorized_user',
    client_id: done.clientId,
    client_secret: done.clientSecret,
    refresh_token: done.refreshToken,
    account: done.account,
    roots: done.roots.map((r) => r.id),
  };
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  writeFileAtomic(googleLoginPath(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  writeRoots(dir, new Set(previous?.roots ?? []), done.roots);
  updateEnvFile(join(dir, '.env'), { GOOGLE_APPLICATION_CREDENTIALS: googleLoginPath() });
  return { service: 'google', label: 'Google Drive', found: `${done.account}, reading ${done.roots.map((r) => r.name).join(', ')}` };
}

// ── Logins this machine already has ──

/** The gh CLI: is it here, and is it signed in? The token goes to the caller and nowhere else. */
export async function ghLogin(exec: Exec = backgroundExec): Promise<{ installed: boolean; token: string | null }> {
  if (!(await hasTool(exec, 'gh'))) return { installed: false, token: null };
  return { installed: true, token: await ghToken(exec) };
}

export interface GcloudState {
  installed: boolean;
  account: string | null;
  /** The project gcloud is set to. */
  project: string | null;
  projects: GcloudProject[];
  problem: string | null;
  /** The problem is that gcloud wants the sign-in again. The page offers to run it (cli_signin.ts). */
  needsSignIn: boolean;
}

/** The gcloud CLI: who is signed in and which projects they can use. */
export async function gcloudState(exec: Exec = backgroundExec): Promise<GcloudState> {
  if (!(await hasTool(exec, 'gcloud'))) return { installed: false, account: null, project: null, projects: [], problem: null, needsSignIn: false };
  const account = await gcloudAccount(exec);
  if (!account) return { installed: true, account: null, project: null, projects: [], problem: null, needsSignIn: true };
  const project = await gcloudDefaultProject(exec);
  try {
    return { installed: true, account, project, projects: await gcloudProjects(exec), problem: null, needsSignIn: false };
  } catch (e) {
    return { installed: true, account, project, projects: [], problem: msg(e), needsSignIn: msg(e) === GCLOUD_SIGN_IN };
  }
}
