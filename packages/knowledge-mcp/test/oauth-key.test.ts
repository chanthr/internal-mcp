/**
 * A connector (Claude, ChatGPT) signs in with a key from People and keys, end to end over HTTP: the client registers,
 * the consent page asks for a key, a wrong key is asked again and five end the request, the right one sends a code
 * back, PKCE is checked at /token, the token reaches /mcp with the key's role, and revoking the key stops the token
 * and its refresh. No Google settings: the key way needs none.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) {
  if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|SLACK_|GITHUB_|RAILWAY_|SUPABASE_|MCP_OAUTH|OAUTH_|MCP_RESOURCE|LLM_|KNOWLEDGE_|KMCP_)/.test(k)) delete process.env[k];
}
// The issuer is the server's own address, known before the server starts: take a free port first.
const port = await new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => resolve(p));
  });
});
const base = `http://localhost:${port}`;
Object.assign(process.env, {
  MCP_DATA_DIR: mkdtempSync(join(tmpdir(), 'kmcp-oauth-key-')),
  MCP_STORE: 'sqlite',
  PORT: String(port),
  TRUST_PROXY: 'false',
  MCP_OAUTH_ISSUER: base,
  OAUTH_JWT_SECRET: randomBytes(32).toString('hex'),
  MCP_CONFIG_JSON: JSON.stringify({ orgId: 'acme' }),
  // An allowlist with no Google client: Google sign-in is off, and a Google-shaped token must not pass on the list alone.
  OAUTH_ALLOWED_EMAILS: 'member@acme.com',
  KNOWLEDGE_SCAN_ENABLED: 'false',
});

const { isOAuthConfigured, oauthSignIns, forgetKeyStanding, oauthProvider } = await import('../src/core/oauth.js');
const { SignJWT } = await import('jose');
const { getStore } = await import('../src/store/index.js');
const { runHttp } = await import('../src/server/http.js');
const { Registry } = await import('../src/plugin/registry.js');
const { builtinPlugins } = await import('../src/plugins/index.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

const store = await getStore();
await store.upsertUser({ email: 'member@acme.com', role: 'member' });
const memberKey = await store.createKey({ email: 'member@acme.com', orgId: 'acme' });
const botKey = await store.createKey({ orgId: 'acme', role: 'viewer', label: 'bot' });
const server = await runHttp(new Registry(builtinPlugins));
after(() => server.close());

const redirectUri = 'https://client.example/cb';
const registered = await fetch(`${base}/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'Test Connector', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
});
const reg = (await registered.json()) as { client_id: string };
const clientId = String(reg.client_id);

/** /authorize as a connector opens it: the consent page, its form values and its cookie. */
async function openConsent() {
  const verifier = randomBytes(32).toString('base64url');
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'client-state',
    scope: 'mcp',
    resource: `${base}/mcp`,
  });
  const res = await fetch(`${base}/authorize?${q}`, { redirect: 'manual' });
  const html = await res.text();
  const cookie = /kmcp_consent=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  const id = /name="id" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  return { res, html, cookie, id, csrf, verifier };
}
const post = (c: { cookie: string; id: string; csrf: string }, action: string, key = '') =>
  fetch(`${base}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `kmcp_consent=${c.cookie}` },
    body: new URLSearchParams({ id: c.id, csrf: c.csrf, action, key }),
  });
const token = async (form: Record<string, string>) => {
  const res = await fetch(`${base}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
};
const listTools = async (accessToken: string) => {
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
};

test('OAuth is on with only the public address and the signing secret; the page asks for a key, not Google', async () => {
  assert.equal(isOAuthConfigured(), true);
  assert.deepEqual(oauthSignIns(), { key: true, google: false });
  const c = await openConsent();
  assert.equal(c.res.status, 200);
  assert.match(c.html, /Test Connector wants to use/);
  assert.match(c.html, /name="key"/);
  assert.doesNotMatch(c.html, /Continue with Google/);
  assert.match(c.html, /https:\/\/client\.example\/cb/, 'where the token goes is shown');
  // Google cannot be asked for when it is not set up.
  const google = await post(c, 'approve');
  assert.equal(google.status, 400);
});

test('a wrong key shows the page again; the right key sends a code; PKCE and the key role carry through to /mcp', async () => {
  const c = await openConsent();
  const wrong = await post(c, 'key', 'kmcp_not_a_key');
  assert.equal(wrong.status, 200);
  assert.match(await wrong.text(), /That key was not accepted\. 4 more tries\./);

  const right = await post(c, 'key', memberKey.key);
  assert.equal(right.status, 302);
  const back = new URL(right.headers.get('location')!);
  assert.equal(`${back.origin}${back.pathname}`, redirectUri);
  assert.equal(back.searchParams.get('state'), 'client-state');
  const code = back.searchParams.get('code')!;
  assert.ok(code);

  // The code is bound to the PKCE verifier.
  const bad = await token({ grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), client_id: clientId, redirect_uri: redirectUri });
  assert.equal(bad.status, 400);
  const c2 = await openConsent();
  const back2 = new URL((await post(c2, 'key', memberKey.key)).headers.get('location')!);
  const t = await token({ grant_type: 'authorization_code', code: back2.searchParams.get('code')!, code_verifier: c2.verifier, client_id: clientId, redirect_uri: redirectUri, resource: `${base}/mcp` });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.ok(t.body.access_token && t.body.refresh_token);

  const tools = await listTools(t.body.access_token);
  assert.ok(tools.length > 0, 'the member key reaches the tools');

  // The refresh token rotates while the key stands.
  const r = await token({ grant_type: 'refresh_token', refresh_token: t.body.refresh_token, client_id: clientId });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // Revoked: the token and its refresh stop.
  await store.revokeKey(memberKey.id);
  forgetKeyStanding();
  await assert.rejects(listTools(r.body.access_token));
  const after = await token({ grant_type: 'refresh_token', refresh_token: r.body.refresh_token, client_id: clientId });
  assert.equal(after.status, 400);
  assert.equal(after.body.error, 'invalid_grant');
});

test('a key that names no person still signs in, with its own role', async () => {
  const c = await openConsent();
  const back = new URL((await post(c, 'key', botKey.key)).headers.get('location')!);
  const t = await token({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: c.verifier, client_id: clientId, redirect_uri: redirectUri });
  assert.equal(t.status, 200);
  const claims = JSON.parse(Buffer.from(t.body.access_token.split('.')[1], 'base64url').toString());
  assert.equal(claims.sub, `key:${botKey.id}`);
  assert.equal(claims.key_id, botKey.id);
  assert.equal(claims.email, undefined);
  await listTools(t.body.access_token);
});

test('five wrong keys end the request: access_denied goes back to the connector', async () => {
  const c = await openConsent();
  for (let i = 0; i < 4; i++) assert.equal((await post(c, 'key', `kmcp_wrong_${i}`)).status, 200);
  const last = await post(c, 'key', 'kmcp_wrong_last');
  assert.equal(last.status, 302);
  const back = new URL(last.headers.get('location')!);
  assert.equal(back.searchParams.get('error'), 'access_denied');
  assert.equal(back.searchParams.get('code'), null);
  // The request is gone: even the right key no longer works on it.
  assert.equal((await post(c, 'key', botKey.key)).status, 400);
});

test('cancel sends access_denied; a post without the consent cookie is refused', async () => {
  const c = await openConsent();
  const noCookie = await fetch(`${base}/oauth/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: c.id, csrf: c.csrf, action: 'key', key: botKey.key }),
  });
  assert.equal(noCookie.status, 400);
  const cancel = await post(c, 'deny');
  assert.equal(new URL(cancel.headers.get('location')!).searchParams.get('error'), 'access_denied');
});

test('a key made after the key list was read works at once', async () => {
  // The list was read by the tests above; this key is newer than it.
  const fresh = await store.createKey({ email: 'member@acme.com', orgId: 'acme' });
  const c = await openConsent();
  const back = new URL((await post(c, 'key', fresh.key)).headers.get('location')!);
  const t = await token({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: c.verifier, client_id: clientId, redirect_uri: redirectUri });
  assert.equal(t.status, 200);
  assert.ok((await listTools(t.body.access_token)).length > 0);
});

test('with Google sign-in off, a token in the Google form is refused even for an address on the allowlist', async () => {
  const forged = await new SignJWT({ sub: 'member@acme.com', email: 'member@acme.com', scope: 'mcp', client_id: clientId, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(base)
    .setAudience(`${base}/mcp`)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.OAUTH_JWT_SECRET!));
  await assert.rejects(oauthProvider.verifyAccessToken(forged), /no longer allowed/);
});
