/**
 * A ChatGPT plan as the model, through OpenAI's sign-in for open-source apps: the first sign-in registers this
 * installation, the browser comes back to 127.0.0.1, the ID token is checked against OpenAI's keys, the plan
 * permission must be granted, tokens are refreshed and revoked, and chat goes through the Responses API with the
 * tools in one namespace. OpenAI is a local fake here, so no account is used.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|ANTHROPIC_|LLM_|EMBEDDING_|KNOWLEDGE_|KMCP_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'kmcp-chatgpt-'));
const docs = join(dir, 'docs');
mkdirSync(docs);
writeFileSync(join(docs, 'deploy.md'), '# Deploy\n\nProduction deploys go out from the main branch after one review.\n');
writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ folders: [{ path: docs, name: 'docs' }] }));
writeFileSync(join(dir, '.env'), '');
Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: join(dir, 'data'),
  MCP_CONFIG_PATH: join(dir, 'mcp.config.json'),
  MCP_ENV_FILE: join(dir, '.env'),
  KMCP_SUPERVISE: 'false',
  KNOWLEDGE_CONSOLE: 'on',
  KNOWLEDGE_SCAN_ENABLED: 'false',
  PORT: '0',
});

// ── OpenAI, as far as this flow uses it ──
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
const seen: Array<{ path: string; form?: Record<string, string>; body?: any; auth?: string }> = [];
let issuer = '';
let challenge = '';
let nonce = '';
let grantPlan = true;
let refreshes = 0;
let revokeStatus = 200;
let responses: Array<(res: ServerResponse) => void> = [];
const sse = (res: ServerResponse, events: unknown[]) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const idToken = (aud: string) =>
  new SignJWT({ nonce, email: 'person@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience(aud).setSubject('user-1').setIssuedAt().setExpirationTime('1h').sign(privateKey);
const openai = createServer(async (req, res) => {
  const raw = await read(req);
  const path = (req.url ?? '').split('?')[0];
  const form = req.headers['content-type']?.includes('form') ? Object.fromEntries(new URLSearchParams(raw)) : undefined;
  const body = req.headers['content-type']?.includes('json') && raw ? JSON.parse(raw) : undefined;
  seen.push({ path, form, body, auth: req.headers.authorization });
  const json = (status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (path === '/jwks.json') return json(200, { keys: [jwk] });
  if (path === '/token' && form?.grant_type === 'authorization_code') {
    const ok = form.code === 'the-code' && createHash('sha256').update(form.code_verifier ?? '').digest('base64url') === challenge && form.resource === 'https://api.openai.com/v1';
    if (!ok) return json(400, { error: 'invalid_grant' });
    const scope = `openid profile email offline_access resource.invoke${grantPlan ? ' chatgpt.tokens.use.direct' : ''}`;
    return json(200, { access_token: 'access-1', refresh_token: 'refresh-1', id_token: await idToken(form.client_id), expires_in: 3600, scope, token_type: 'Bearer' });
  }
  if (path === '/token' && form?.grant_type === 'refresh_token') {
    refreshes++;
    if (form.refresh_token === 'dead') return json(400, { error: 'refresh_token_reused' });
    return json(200, { access_token: `access-${refreshes + 1}`, refresh_token: `refresh-${refreshes + 1}`, expires_in: 3600, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
  }
  if (path === '/revoke') return void res.writeHead(revokeStatus).end();
  if (path === '/v1/models') return json(200, { models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1', visibility: 'list' }, { slug: 'internal', display_name: 'Internal', visibility: 'hide' }] });
  if (path === '/v1/responses') return (responses.shift() ?? ((r: ServerResponse) => sse(r, [{ type: 'response.output_text.delta', delta: 'ready' }, { type: 'response.completed', response: { model: 'gpt-6.1-sol', usage: { input_tokens: 5, output_tokens: 1 } } }])))(res);
  json(404, { error: 'not here' });
});
await new Promise<void>((r) => openai.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(openai.address() as AddressInfo).port}`;
issuer = base;

const { chatgptEndpoints } = await import('../src/core/chatgpt.js');
Object.assign(chatgptEndpoints, { authorize: `${base}/authorize`, token: `${base}/token`, issuer: base, jwks: `${base}/jwks.json`, revoke: `${base}/revoke`, api: `${base}/v1` });
const { consoleToken } = await import('../src/admin/auth.js');
const { runHttp } = await import('../src/server/http.js');
const { Registry } = await import('../src/plugin/registry.js');
const { builtinPlugins } = await import('../src/plugins/index.js');
const { scanFolders } = await import('../src/plugins/knowledge/folders.js');
await scanFolders();

const server = await runHttp(new Registry(builtinPlugins));
const token = consoleToken();
after(async () => {
  openai.close();
  await server.close();
});
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://localhost:${server.port}/console/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
};
const account = () => JSON.parse(readFileSync(join(dir, 'data', 'chatgpt-account.json'), 'utf8'));

/** The browser's round trip: the console starts it, OpenAI sends the browser back with a code. */
async function signIn(): Promise<{ url: URL; back: Response }> {
  const started = await api('POST', '/llm/chatgpt/sign-in');
  const url = new URL(started.json.url);
  challenge = url.searchParams.get('code_challenge') ?? '';
  nonce = url.searchParams.get('nonce') ?? '';
  const back = new URL(url.searchParams.get('redirect_uri')!);
  back.searchParams.set('code', 'the-code');
  back.searchParams.set('state', url.searchParams.get('state')!);
  back.searchParams.set('client_id', 'oaiapp_123');
  return { url, back: await fetch(back) };
}

test('the first sign-in registers this installation; the browser comes back to 127.0.0.1 and the tokens are kept', async () => {
  assert.deepEqual((await api('GET', '/llm/chatgpt')).json, { signedIn: false, email: null, planUsage: false, waiting: false, error: null });
  const { url, back } = await signIn();
  const q = url.searchParams;
  assert.equal(`${url.origin}${url.pathname}`, `${base}/authorize`);
  assert.deepEqual([q.get('client_id'), q.get('agent_name_hint'), q.get('response_type'), q.get('resource'), q.get('code_challenge_method')], ['dynamic_agent_client', 'Knowledge MCP', 'code', 'https://api.openai.com/v1', 'S256']);
  assert.equal(q.get('scope'), 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
  assert.match(q.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/console\/login\/chatgpt$/);
  assert.match(q.get('ext_agent_host_id')!, /^urn:uuid:[0-9a-f-]{36}$/);

  assert.equal(back.status, 200);
  assert.match(await back.text(), /Signed in to ChatGPT as person@example\.com/);
  const view = (await api('GET', '/llm/chatgpt')).json;
  assert.deepEqual([view.signedIn, view.email, view.planUsage], [true, 'person@example.com', true]);
  const saved = account();
  assert.deepEqual([saved.clientId, saved.accessToken, saved.refreshToken, saved.subject], ['oaiapp_123', 'access-1', 'refresh-1', 'user-1']);
  assert.equal(statSync(join(dir, 'data', 'chatgpt-account.json')).mode & 0o777, 0o600);
  // The code was exchanged with the issued client ID, the same callback and the PKCE verifier.
  const exchange = seen.find((s) => s.path === '/token' && s.form?.grant_type === 'authorization_code')!;
  assert.deepEqual([exchange.form!.client_id, exchange.form!.redirect_uri], ['oaiapp_123', q.get('redirect_uri')]);

  // An answer that does not belong to a sign-in started here is turned away.
  const stray = new URL(q.get('redirect_uri')!);
  stray.searchParams.set('code', 'the-code');
  stray.searchParams.set('state', 'made-up');
  const refused = await fetch(stray);
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /not started from the console/);
});

test('the model is picked from the account\'s own list and saved after it answers', async () => {
  const models = await api('POST', '/llm/models', { provider: 'chatgpt' });
  assert.deepEqual(models.json.models, [{ id: 'gpt-6.1-sol', name: 'GPT-6.1' }]);
  assert.equal(seen.at(-1)!.auth, 'Bearer access-1');
  const saved = await api('POST', '/services/llm', { provider: 'chatgpt', model: 'gpt-6.1-sol' });
  assert.equal(saved.status, 200, saved.text);
  const env = readFileSync(join(dir, '.env'), 'utf8');
  assert.match(env, /LLM_PROVIDER=chatgpt/);
  assert.match(env, /LLM_MODEL=gpt-6\.1-sol/);
  assert.doesNotMatch(env, /access-1|refresh-1/, 'tokens stay out of .env');
  // The check went to the Responses API as the plan route requires.
  const check = seen.filter((s) => s.path === '/v1/responses').at(-1)!;
  assert.deepEqual([check.body.store, check.body.stream, check.body.model], [false, true, 'gpt-6.1-sol']);
  assert.ok(!('max_output_tokens' in check.body) && !('temperature' in check.body));
});

test('chat: tools in one namespace, the call handed back without its ID, the result as function_call_output', async () => {
  Object.assign(process.env, { LLM_PROVIDER: 'chatgpt', LLM_MODEL: 'gpt-6.1-sol' });
  responses = [
    (res) =>
      sse(res, [
        { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search_knowledge', namespace: 'knowledge_mcp', arguments: '{"query":"deploys main branch"}', status: 'completed' } },
        { type: 'response.completed', response: { model: 'gpt-6.1-sol', usage: { input_tokens: 100, output_tokens: 10 } } },
      ]),
    (res) =>
      sse(res, [
        { type: 'response.output_text.delta', delta: 'Deploys go out from main ' },
        { type: 'response.output_text.delta', delta: 'after one review.' },
        { type: 'response.completed', response: { model: 'gpt-6.1-sol', usage: { input_tokens: 300, output_tokens: 20, input_tokens_details: { cached_tokens: 90 } } } },
      ]),
  ];
  const res = await fetch(`http://localhost:${server.port}/console/api/chat`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'How do deploys go out?', history: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'Hello.' }] }) });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.find((e) => e.type === 'tool'), { type: 'tool', id: 'call_1', name: 'search_knowledge', input: { query: 'deploys main branch' } });
  assert.match(events.find((e) => e.type === 'result').text, /main branch after one review/);
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Deploys go out from main after one review.');
  assert.deepEqual(events.at(-1), { type: 'done', model: 'gpt-6.1-sol', usage: { input: 400, output: 30, cached: 90, steps: 1 }, note: null });

  const [first, second] = seen.filter((s) => s.path === '/v1/responses').slice(-2);
  assert.equal(first.body.tools.length, 1);
  assert.deepEqual([first.body.tools[0].type, first.body.tools[0].name], ['namespace', 'knowledge_mcp']);
  assert.ok(first.body.tools[0].tools.some((t: any) => t.type === 'function' && t.name === 'search_knowledge'));
  assert.match(first.body.instructions, /owner tries how its tools work/);
  assert.ok(first.body.input.every((i: any) => i.role !== 'system'), 'no system message in the input');
  assert.deepEqual(first.body.input.map((i: any) => i.role), ['user', 'assistant', 'user']);
  const handed = second.body.input.slice(-2);
  assert.deepEqual(handed[0], { type: 'function_call', call_id: 'call_1', name: 'search_knowledge', namespace: 'knowledge_mcp', arguments: '{"query":"deploys main branch"}' });
  assert.equal(handed[1].type, 'function_call_output');
  assert.equal(handed[1].call_id, 'call_1');
});

test('the plan\'s limit stops the answer with a sentence; the access token is refreshed when it runs out', async () => {
  responses = [(res) => sse(res, [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }])];
  const limited = await fetch(`http://localhost:${server.port}/console/api/chat`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'More' }) });
  const last = (await limited.text()).trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual([last.type, /chatgpt\.com\/settings\/usage/.test(last.message)], ['error', true]);

  // An hour later: refreshed once, the rotated refresh token kept.
  const file = join(dir, 'data', 'chatgpt-account.json');
  writeFileSync(file, JSON.stringify({ ...account(), expiresAt: Date.now() + 10_000 }));
  const before = refreshes;
  await api('POST', '/llm/models', { provider: 'chatgpt' });
  assert.equal(refreshes, before + 1);
  const refresh = seen.filter((s) => s.form?.grant_type === 'refresh_token').at(-1)!;
  assert.deepEqual([refresh.form!.client_id, refresh.form!.refresh_token, refresh.form!.resource], ['oaiapp_123', 'refresh-1', 'https://api.openai.com/v1']);
  assert.equal(account().refreshToken, `refresh-${refreshes + 1}`);
});

test('a plan that is busy for a moment is asked again, as an API endpoint is', async () => {
  const { ask } = await import('../src/core/llm.js');
  process.env.LLM_RETRY_MS = '5';
  const before = seen.filter((s) => s.path === '/v1/responses').length;
  responses = [(res) => void res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'busy' } }))];
  const a = await ask({ prompt: 'Say ready' }, { kind: 'chatgpt', model: 'gpt-6.1-sol' });
  assert.deepEqual([a.text, seen.filter((s) => s.path === '/v1/responses').length - before], ['ready', 2]);
  delete process.env.LLM_RETRY_MS;
});

test('a refresh token OpenAI no longer takes asks for a new sign-in; signing out revokes and keeps the installation', async () => {
  const file = join(dir, 'data', 'chatgpt-account.json');
  writeFileSync(file, JSON.stringify({ ...account(), refreshToken: 'dead', expiresAt: 0 }));
  const dead = await api('POST', '/llm/models', { provider: 'chatgpt' });
  assert.match(dead.json.error, /Sign in again/);
  assert.equal((await api('GET', '/llm/chatgpt')).json.signedIn, false);

  await signIn();
  await api('DELETE', '/llm/chatgpt');
  const revoke = seen.filter((s) => s.path === '/revoke').at(-1)!;
  assert.deepEqual([revoke.form!.token, revoke.form!.token_type_hint, revoke.form!.client_id], ['refresh-1', 'refresh_token', 'oaiapp_123']);
  const kept = account();
  assert.deepEqual([kept.clientId, !!kept.hostId, kept.refreshToken, kept.accessToken], ['oaiapp_123', true, undefined, undefined]);
  assert.doesNotMatch(readFileSync(join(dir, '.env'), 'utf8'), /LLM_PROVIDER=chatgpt/, 'the model setting goes with the sign-in');

  // The next sign-in is the same app at OpenAI: its issued ID, and no name to register again. Signed out, it names
  // no account.
  const again = new URL((await api('POST', '/llm/chatgpt/sign-in')).json.url);
  assert.deepEqual([again.searchParams.get('client_id'), again.searchParams.has('agent_name_hint'), again.searchParams.get('login_hint'), again.searchParams.has('id_token_hint')], ['oaiapp_123', false, null, false]);
});

test('a returning sign-in names the account; a sign-out OpenAI does not confirm is said', async () => {
  await signIn();
  const back = new URL((await api('POST', '/llm/chatgpt/sign-in')).json.url);
  assert.equal(back.searchParams.get('login_hint'), 'person@example.com');
  assert.equal(back.searchParams.get('id_token_hint'), account().idToken);
  revokeStatus = 503;
  try {
    const before = seen.filter((s) => s.path === '/revoke').length;
    const out = await api('DELETE', '/llm/chatgpt');
    assert.equal(seen.filter((s) => s.path === '/revoke').length, before + 2, 'tried twice');
    assert.equal(out.json.signedIn, false);
    assert.match(out.json.error, /did not confirm/);
  } finally {
    revokeStatus = 200;
  }
});

test('a sign-in without permission to use the plan is kept, but the plan is not used', async () => {
  grantPlan = false;
  try {
    const { back } = await signIn();
    assert.equal(back.status, 400);
    assert.match(await back.text(), /using your ChatGPT plan was not allowed/);
    const view = (await api('GET', '/llm/chatgpt')).json;
    assert.deepEqual([view.signedIn, view.planUsage], [true, false]);
    assert.equal(existsSync(join(dir, 'data', 'chatgpt-account.json')), true);
  } finally {
    grantPlan = true;
  }
});

test('the data folder cannot be written when the browser comes back: the tab says so, and the server keeps running', { skip: process.getuid?.() === 0 ? 'root writes anywhere' : false }, async () => {
  // A first sign-in: the client ID OpenAI issues is saved as soon as the browser is back.
  writeFileSync(join(dir, 'data', 'chatgpt-account.json'), JSON.stringify({ hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001' }));
  const url = new URL((await api('POST', '/llm/chatgpt/sign-in')).json.url);
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  const back = new URL(url.searchParams.get('redirect_uri')!);
  back.searchParams.set('code', 'the-code');
  back.searchParams.set('state', url.searchParams.get('state')!);
  back.searchParams.set('client_id', 'oaiapp_123');
  // A full disk, or a volume that became read-only.
  chmodSync(join(dir, 'data'), 0o500);
  try {
    // Before, the failed save was a rejection nobody caught: the tab got no answer, and the server stopped.
    const r = await fetch(back, { signal: AbortSignal.timeout(5_000) });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /Not signed in<\/h1><p>The sign-in could not be checked \(EACCES/);
  } finally {
    chmodSync(join(dir, 'data'), 0o700);
  }
  assert.equal((await fetch(`http://localhost:${server.port}/health`)).status, 200);
  assert.match((await api('GET', '/llm/chatgpt')).json.error, /could not be checked/);
});
