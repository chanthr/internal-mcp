/**
 * A ChatGPT account as this server's language model: "Continue with ChatGPT".
 *
 * OpenAI lets open-source apps that run on the user's own machine use the usage included in a ChatGPT Plus or Pro
 * plan, through its own sign-in (https://developers.openai.com/siwc/token-sharing-open-source). The person signs in
 * at OpenAI in their browser and allows this app to use their plan; the app then calls the Responses API with the
 * access token it was given. No API key, nothing billed apart from the plan. Usage counts against the plan, and the
 * person can cap it per app in ChatGPT's settings.
 *
 * How it goes, as OpenAI's guide describes it:
 *   1. The first sign-in registers this installation: client_id=dynamic_agent_client, with the app's name and a
 *      host ID. OpenAI answers with an issued client ID (oaiapp_...), kept and used from then on.
 *   2. OAuth with PKCE. The browser comes back to http://127.0.0.1:<port>/console/login/chatgpt (loopback only).
 *   3. The code is exchanged; the ID token is checked against OpenAI's keys; the plan permission
 *      (chatgpt.tokens.use.direct) must have been granted.
 *   4. Inference: POST /v1/responses with the access token, store: false, stream: true.
 *   5. The access token lasts an hour and is refreshed with the rotating refresh token (30 days).
 *
 * The tokens are kept in the data directory, readable by the owner only, and never logged or sent to the page.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { dataFile } from './data_file.js';

/** OpenAI's endpoints. A test points them at fakes. */
export const chatgptEndpoints = {
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  issuer: 'https://auth.openai.com',
  jwks: 'https://auth.openai.com/.well-known/jwks.json',
  revoke: 'https://auth.openai.com/api/accounts/oauth/revoke',
  api: 'https://api.openai.com/v1',
};
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
/** The app's name as OpenAI shows it to the person, the same on every installation. */
const APP_NAME = 'Knowledge MCP';
/** Where the browser comes back to. The path never changes; the port is the server's. */
export const CALLBACK_PATH = '/console/login/chatgpt';

interface Account {
  /** This installation's ID at OpenAI (oaiapp_...), kept after a sign-out so the next sign-in is the same client. */
  clientId?: string;
  /** Identifies this machine to OpenAI. Not a credential. */
  hostId: string;
  email?: string;
  subject?: string;
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Milliseconds since 1970. */
  expiresAt?: number;
  scopes?: string[];
}
const stored = dataFile<Account>('chatgpt-account.json');

function account(): Account {
  const a = stored.read();
  if (a?.hostId) return a;
  const fresh: Account = { hostId: `urn:uuid:${randomUUID()}` };
  stored.write(fresh);
  return fresh;
}

export interface ChatgptView {
  signedIn: boolean;
  email: string | null;
  /** The person allowed this app to use their ChatGPT plan. */
  planUsage: boolean;
  /** A sign-in was started from the page and has not come back yet, or what went wrong when it did. */
  waiting: boolean;
  error: string | null;
}
export function chatgptView(): ChatgptView {
  const a = stored.read();
  const signedIn = !!a?.refreshToken;
  return { signedIn, email: signedIn ? a?.email ?? null : null, planUsage: signedIn && !!a?.scopes?.includes(PLAN_SCOPE), waiting: !!pending && Date.now() < pending.until, error: lastError };
}
export const chatgptSignedIn = (): boolean => {
  const a = stored.read();
  return !!a?.refreshToken && !!a.scopes?.includes(PLAN_SCOPE);
};

// ── Signing in ──

interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  /** The client ID asked with: dynamic_agent_client on the first sign-in. */
  clientId: string;
  until: number;
}
let pending: Pending | null = null;
let lastError: string | null = null;
const b64url = (b: Buffer) => b.toString('base64url');

/** Start a sign-in: the address to open in the browser. `port` is where this server answers on 127.0.0.1. */
export function startChatgptSignIn(port: number): string {
  const a = account();
  const verifier = b64url(randomBytes(48));
  const p: Pending = {
    state: b64url(randomBytes(24)),
    nonce: b64url(randomBytes(24)),
    verifier,
    // Loopback on 127.0.0.1, as OpenAI asks (not "localhost").
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    clientId: a.clientId ?? 'dynamic_agent_client',
    until: Date.now() + 10 * 60_000,
  };
  pending = p;
  lastError = null;
  const q = new URLSearchParams({
    client_id: p.clientId,
    ...(a.clientId ? {} : { agent_name_hint: APP_NAME }),
    ext_agent_host_id: a.hostId,
    response_type: 'code',
    redirect_uri: p.redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state: p.state,
    nonce: p.nonce,
    code_challenge_method: 'S256',
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    // A returning sign-in names the account it was: OpenAI then skips choosing an account.
    ...(a.clientId && a.idToken ? { id_token_hint: a.idToken } : {}),
    ...(a.clientId && a.email ? { login_hint: a.email } : {}),
  });
  return `${chatgptEndpoints.authorize}?${q}`;
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}
async function tokenRequest(form: Record<string, string>): Promise<{ status: number; body: TokenAnswer }> {
  const res = await fetch(chatgptEndpoints.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as TokenAnswer };
}

let keys: ReturnType<typeof createRemoteJWKSet> | null = null;
let keysFor = '';
async function checkIdToken(idToken: string, clientId: string, nonce: string): Promise<{ subject: string; email: string | null }> {
  if (!keys || keysFor !== chatgptEndpoints.jwks) {
    keys = createRemoteJWKSet(new URL(chatgptEndpoints.jwks));
    keysFor = chatgptEndpoints.jwks;
  }
  const { payload } = await jwtVerify(idToken, keys, { issuer: chatgptEndpoints.issuer, audience: clientId });
  if (payload.nonce !== nonce) throw new Error('the sign-in answer was not for this request');
  if (!payload.sub) throw new Error('the sign-in answer named no account');
  return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
}

/**
 * The browser came back from OpenAI. Checks it belongs to the sign-in started here, exchanges the code, checks the
 * ID token, and keeps the tokens. Returns what to tell the person in that tab.
 */
export async function finishChatgptSignIn(query: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const p = pending;
  const state = String(query.state ?? '');
  if (!p || Date.now() > p.until || state !== p.state) return { ok: false, text: 'This sign-in was not started from the console, or it took too long. Start it again from the console.' };
  pending = null;
  const fail = (why: string) => {
    lastError = why;
    return { ok: false, text: why };
  };
  if (query.error) return fail(query.error === 'access_denied' ? 'The sign-in was cancelled at OpenAI. Nothing was changed.' : `OpenAI answered: ${String(query.error_description ?? query.error).slice(0, 200)}`);
  const code = String(query.code ?? '');
  // On the first sign-in OpenAI issues this installation's client ID and sends it back here.
  const clientId = p.clientId === 'dynamic_agent_client' ? String(query.client_id ?? '') : p.clientId;
  if (!code || !clientId || clientId === 'dynamic_agent_client') return fail('OpenAI did not finish registering this app. Start the sign-in again.');
  if (p.clientId === 'dynamic_agent_client') stored.write({ ...account(), clientId });
  try {
    const t = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: p.verifier, redirect_uri: p.redirectUri, resource: RESOURCE });
    if (t.status !== 200 || !t.body.access_token || !t.body.refresh_token || !t.body.id_token) {
      return fail(`OpenAI did not give a sign-in (${t.body.error ?? t.status}). Start it again.`);
    }
    const who = await checkIdToken(t.body.id_token, clientId, p.nonce);
    const before = stored.read();
    // A different account than the one signed in before: its tokens replace the old ones, nothing is mixed.
    const scopes = String(t.body.scope ?? '').split(/\s+/).filter(Boolean);
    stored.write({
      hostId: before?.hostId ?? account().hostId,
      clientId,
      email: who.email ?? undefined,
      subject: who.subject,
      idToken: t.body.id_token,
      accessToken: t.body.access_token,
      refreshToken: t.body.refresh_token,
      expiresAt: Date.now() + (t.body.expires_in ?? 3600) * 1000,
      scopes,
    });
    lastError = null;
    if (!scopes.includes(PLAN_SCOPE)) {
      return fail('You are signed in, but using your ChatGPT plan was not allowed. Sign in again and allow it, or use an API key.');
    }
    return { ok: true, text: `Signed in to ChatGPT${who.email ? ` as ${who.email}` : ''}. You can close this tab and go back to the console.` };
  } catch (e) {
    return fail(`The sign-in could not be checked (${e instanceof Error ? e.message : String(e)}). Start it again.`);
  }
}

/**
 * Sign out: the session is ended at OpenAI, and the tokens are deleted here either way. Returns whether OpenAI
 * confirmed it; when it did not, the person is told they can disconnect the app in ChatGPT's settings.
 */
export async function signOutChatgpt(): Promise<{ revoked: boolean }> {
  const a = stored.read();
  let revoked = !a?.refreshToken;
  if (a?.refreshToken && a.clientId) {
    for (let attempt = 0; attempt < 2 && !revoked; attempt++) {
      const status = await fetch(chatgptEndpoints.revoke, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: a.refreshToken, token_type_hint: 'refresh_token', client_id: a.clientId }),
        signal: AbortSignal.timeout(15_000),
      }).then((r) => r.status, () => 0);
      // 200 also for a token that was already invalid. A 4xx will not change on a second try.
      if (status === 200) revoked = true;
      else if (status >= 400 && status < 500) break;
    }
  }
  // The installation's client ID and host ID stay: the next sign-in is the same app at OpenAI.
  if (a) stored.write({ hostId: a.hostId, clientId: a.clientId });
  lastError = revoked ? null : 'Signed out here, but OpenAI did not confirm ending the session. You can disconnect Knowledge MCP in ChatGPT settings, Security.';
  return { revoked };
}

// ── Using it ──

/** An answer that says what to do, in a sentence. `retry`: trying later may work. */
export class ChatgptError extends Error {
  constructor(
    message: string,
    readonly retry = false,
  ) {
    super(message);
  }
}

let refreshing: Promise<string> | null = null;
/** A valid access token, refreshed when it is about to run out. Refreshes never race each other. */
export async function chatgptToken(): Promise<string> {
  const a = stored.read();
  if (!a?.refreshToken || !a.clientId) throw new ChatgptError('Not signed in to ChatGPT. Sign in on the Agent page.');
  if (a.accessToken && (a.expiresAt ?? 0) - Date.now() > 120_000) return a.accessToken;
  refreshing ??= (async () => {
    try {
      const t = await tokenRequest({ grant_type: 'refresh_token', client_id: a.clientId!, refresh_token: a.refreshToken!, resource: RESOURCE });
      if (t.status !== 200 || !t.body.access_token) {
        const code = t.body.error ?? '';
        if (/invalid_grant|invalid_refresh_token|token_expired|refresh_token_(expired|invalidated|reused)/.test(code)) {
          stored.write({ hostId: a.hostId, clientId: a.clientId, email: a.email, idToken: a.idToken });
          throw new ChatgptError('The ChatGPT sign-in ran out or was disconnected in ChatGPT. Sign in again on the Agent page.');
        }
        throw new ChatgptError(`ChatGPT's sign-in could not be renewed (${code || t.status}).`, t.status >= 500);
      }
      const now = stored.read() ?? a;
      stored.write({ ...now, accessToken: t.body.access_token, refreshToken: t.body.refresh_token ?? now.refreshToken, expiresAt: Date.now() + (t.body.expires_in ?? 3600) * 1000, scopes: t.body.scope ? t.body.scope.split(/\s+/) : now.scopes });
      return t.body.access_token;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** What a failed request means, in words, from the codes OpenAI documents for plan usage. */
export function chatgptFailure(status: number, body: { error?: { code?: string; message?: string; param?: string } | string; detail?: string }): ChatgptError {
  const error = typeof body.error === 'object' ? body.error : undefined;
  const code = error?.code ?? '';
  if (code === 'subscription_sharing_usage_limit_exceeded') return new ChatgptError('The usage your ChatGPT plan allows for this app is used up for now. See chatgpt.com/settings/usage.');
  if (code === 'subscription_sharing_user_not_eligible') return new ChatgptError('This ChatGPT account or workspace may not use its plan in other apps.');
  if (code === 'subscription_sharing_unsupported_capability') return new ChatgptError(`ChatGPT plan usage does not support part of this request${error?.param ? ` (${error.param})` : ''}.`);
  if (code === 'subscription_sharing_invalid_user' || status === 401) return new ChatgptError('ChatGPT did not accept the sign-in. Sign in again on the Agent page.');
  if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable' || status === 503) return new ChatgptError('ChatGPT could not check the plan just now. Try again in a moment.', true);
  if (status === 403) return new ChatgptError(`ChatGPT refused the request${body.detail ? ` (${String(body.detail).slice(0, 160)})` : error?.message ? ` (${error.message.slice(0, 160)})` : ''}.`);
  if (status === 429) return new ChatgptError('ChatGPT is limiting requests right now. Try again in a moment.', true);
  return new ChatgptError(`ChatGPT answered ${status}${error?.message ? `: ${error.message.slice(0, 200)}` : body.detail ? `: ${String(body.detail).slice(0, 200)}` : ''}`, status >= 500);
}

/** The models this account may use, as OpenAI lists them for it. */
export async function chatgptModels(): Promise<Array<{ id: string; name: string }>> {
  const token = await chatgptToken();
  const res = await fetch(`${chatgptEndpoints.api}/models`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  const body = (await res.json().catch(() => ({}))) as { models?: Array<{ slug?: string; display_name?: string; visibility?: string }> };
  if (!res.ok) throw chatgptFailure(res.status, body as never);
  return (body.models ?? []).filter((m) => m.slug && m.visibility === 'list').map((m) => ({ id: m.slug!, name: m.display_name || m.slug! }));
}

export interface ResponsesEvent {
  type: string;
  delta?: string;
  item?: Record<string, unknown>;
  response?: { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }; model?: string; error?: { code?: string; message?: string } };
}

/**
 * One streamed Responses request with the plan. `store: false` and `stream: true` always, as OpenAI requires for
 * plan usage. Yields each event; throws on a failure before or inside the stream.
 */
export async function* chatgptResponses(body: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<ResponsesEvent> {
  const token = await chatgptToken();
  const res = await fetch(`${chatgptEndpoints.api}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ ...body, store: false, stream: true }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]),
  });
  if (!res.ok || !res.body) throw chatgptFailure(res.status, (await res.json().catch(() => ({}))) as never);
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let e: ResponsesEvent;
      try {
        e = JSON.parse(data) as ResponsesEvent;
      } catch {
        continue;
      }
      if (e.type === 'response.failed' || e.type === 'error') {
        const err = e.response?.error ?? (e as unknown as { error?: { code?: string; message?: string } }).error ?? {};
        throw chatgptFailure(err.code === 'subscription_sharing_usage_limit_exceeded' ? 429 : 400, { error: err });
      }
      if (e.type === 'response.completed') completed = true;
      yield e;
    }
  }
  // Only a completed response counts: a stream that just stops is not an answer.
  if (!completed && !signal.aborted) throw new ChatgptError('ChatGPT stopped before the answer was complete. Try again.', true);
}
