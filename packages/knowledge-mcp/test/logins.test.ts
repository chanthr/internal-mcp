/**
 * Connecting a service by signing in instead of pasting a token: Railway (the server registers itself), Google
 * (through an OAuth client of the person's own), another service's MCP server (it says where to sign in), the
 * login the gh CLI already has, and a service account made by gcloud. The other sites are local fakes and the
 * command lines are scripts, so nothing leaves this machine.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|SLACK_|GITHUB_|RAILWAY_|SUPABASE_|EMBEDDING_|KNOWLEDGE_|KMCP_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'kmcp-logins-'));
const data = join(dir, 'data');
// A Drive folder somebody listed by hand: a sign-in adds its own folders next to it and takes only its own away.
const byHand = { id: 'by-hand-root-0001', name: 'Wiki', source: 'wiki' };
writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ drive: { roots: [byHand] } }));
Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: data,
  MCP_CONFIG_PATH: join(dir, 'mcp.config.json'),
  MCP_ENV_FILE: 'none',
  KMCP_SUPERVISE: 'false',
  KNOWLEDGE_CONSOLE: 'on',
  PORT: '0',
});

const { consoleToken } = await import('../src/admin/auth.js');
const { runHttp } = await import('../src/server/http.js');
const { Registry } = await import('../src/plugin/registry.js');
const { builtinPlugins } = await import('../src/plugins/index.js');
const { googleEndpoints, githubEndpoint, parseGoogleClient, driveFolderIds } = await import('../src/admin/logins.js');
const { railwayEndpoints, railwayAuth, railwayConfigured, readRailwayLogin, writeRailwayLogin } = await import('../src/plugins/railway/login.js');
const { railwayProjects, handleRailwayLogs } = await import('../src/plugins/railway/tools.js');
const { authStore } = await import('../src/core/context.js');
const { installCommand } = await import('../src/admin/cli_runs.js');
const { signInAddress, sameOwner } = await import('../src/admin/upstreams.js');
const { credentialsFromJson } = await import('../src/plugins/drive/client.js');
const { UpstreamManager, isExposed } = await import('../src/core/upstream.js');
const { upstreamToken, readUpstreamLogin, writeUpstreamLogin } = await import('../src/core/upstream_login.js');

const server = await runHttp(new Registry(builtinPlugins));
const base = `http://localhost:${server.port}`;
const token = consoleToken();
const fakes: Server[] = [];
after(async () => {
  for (const f of fakes) f.close();
  await server.close();
});

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}/console/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
};
/** The browser coming back from the other site: a plain page request, marked as cross-site, without the console token. */
const comeBack = async (service: string, query: Record<string, string>) => {
  const res = await fetch(`${base}/console/login/${service}?${new URLSearchParams(query)}`, { redirect: 'manual', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  return { status: res.status, to: res.headers.get('location') };
};
const config = () => JSON.parse(readFileSync(join(dir, 'mcp.config.json'), 'utf8'));
const envFile = () => (existsSync(join(dir, '.env')) ? readFileSync(join(dir, '.env'), 'utf8') : '');
const mode = (path: string) => statSync(path).mode & 0o777;
const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
const fake = async (handle: (req: IncomingMessage, body: string) => { status?: number; json?: unknown; headers?: Record<string, string> }) => {
  const s = createServer(async (req, res) => {
    const out = handle(req, await read(req));
    res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json', ...(out.headers ?? {}) });
    res.end(out.json === undefined ? '' : JSON.stringify(out.json));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  fakes.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
/** Command lines that stand in for gh and gcloud, first on the PATH. */
const bin = join(dir, 'bin');
mkdirSync(bin);
const script = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\nhere="$(dirname "$0")"\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
const realPath = process.env.PATH ?? '';
process.env.PATH = `${bin}:${realPath}`;

test('Railway: the server registers itself, the person signs in, and nothing is saved until the console says so', async () => {
  const rw = { registered: [] as any[], deleted: [] as string[], refreshes: 0, current: 'rt-1', challenge: '', ended: false, shared: true, refused: false };
  const railway = await fake((req, body) => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url === '/oauth/register') {
      rw.registered.push(JSON.parse(body));
      const id = `rlwy_test_${rw.registered.length}`;
      return { status: 201, json: { client_id: id, registration_client_uri: `${railwayEndpoints.issuer}/oauth/register/${id}`, registration_access_token: `reg-${rw.registered.length}` } };
    }
    if (req.method === 'DELETE' && url.startsWith('/oauth/register/')) {
      rw.deleted.push(`${url.split('/').pop()} ${req.headers.authorization}`);
      return { status: 204 };
    }
    if (url === '/oauth/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        // No secret is sent: the code is good only with the verifier whose hash went out in the sign-in address.
        const proven = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === rw.challenge;
        if (form.get('code') !== 'good-code' || !proven || form.has('client_secret')) return { status: 400, json: { error: 'invalid_grant', error_description: 'bad code' } };
        return { json: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 } };
      }
      // A refresh token works once: each use hands out the next one.
      if (rw.ended || form.get('refresh_token') !== rw.current) return { status: 400, json: { error: 'invalid_grant', error_description: 'grant is no longer valid' } };
      rw.refreshes++;
      rw.current = `rt-${rw.refreshes + 1}`;
      return { json: { access_token: `at-${rw.refreshes + 1}`, refresh_token: rw.current, expires_in: 3600 } };
    }
    const signedIn = /^Bearer at-\d$/.test(req.headers.authorization ?? '');
    if (url === '/oauth/me') return signedIn ? { json: { sub: 'user-1', email: 'ann@example.com', name: 'Ann' } } : { status: 401, json: {} };
    if (url === '/graphql/v2') {
      // Like Railway: a signed-in app may not ask for "all projects". It asks for its workspaces and what is in them.
      if (!signedIn || rw.refused || !body.includes('workspaces')) return { json: { errors: [{ message: 'Not Authorized' }] } };
      const node = (id: string, name: string) => ({ node: { id, name, services: { edges: [{ node: { id: `${id}-s`, name: 'server' } }] }, environments: { edges: [{ node: { id: `${id}-e`, name: 'production' } }] } } });
      return { json: { data: { me: { workspaces: rw.shared ? [{ id: 'w1', name: 'Acme', projects: { edges: [node('p1', 'api'), node('p2', 'web')] } }] : [] } } } };
    }
    return { status: 404, json: {} };
  });
  Object.assign(railwayEndpoints, { issuer: railway, api: `${railway}/graphql/v2` });
  const file = join(data, 'railway-login.json');
  assert.equal(railwayConfigured(), false);

  // Start: the server registers itself as a client without a secret, for the address of this console.
  const started = await api('POST', '/logins/railway', {});
  assert.equal(started.status, 200, started.text);
  const url = new URL(started.json.url);
  const q = url.searchParams;
  assert.equal(`${url.origin}${url.pathname}`, `${railway}/oauth/auth`);
  assert.deepEqual(
    [q.get('client_id'), q.get('redirect_uri'), q.get('response_type'), q.get('code_challenge_method'), q.get('prompt')],
    ['rlwy_test_1', `${base}/console/login/railway`, 'code', 'S256', 'consent'],
  );
  // It only reads. The name is asked for with the email: Railway answers a signed-in app nothing without both.
  assert.deepEqual(q.get('scope')!.split(' ').sort(), ['email', 'offline_access', 'openid', 'profile', 'workspace:viewer']);
  assert.deepEqual([rw.registered[0].redirect_uris, rw.registered[0].token_endpoint_auth_method, rw.registered[0].scope], [[`${base}/console/login/railway`], 'none', q.get('scope')]);
  rw.challenge = q.get('code_challenge')!;
  const state = q.get('state')!;
  assert.ok(state.length >= 24);

  // A return this server did not start changes nothing, whatever it carries.
  assert.deepEqual(await comeBack('railway', { code: 'good-code', state: 'made-up-somewhere-else' }), { status: 302, to: '/console/' });
  assert.deepEqual(await comeBack('google', { code: 'good-code', state }), { status: 302, to: '/console/' }); // a state is for one service
  assert.equal((await api('GET', '/state')).json.login, null);

  // The real return: no console token, and still nothing is written. The result waits for the console.
  assert.deepEqual(await comeBack('railway', { code: 'good-code', state }), { status: 302, to: '/console/#/apps' });
  assert.equal(existsSync(file), false);
  assert.deepEqual((await api('GET', '/state')).json.login, { service: 'railway' });
  assert.deepEqual(await comeBack('railway', { code: 'good-code', state }), { status: 302, to: '/console/' }); // once
  // Saving needs the console token.
  assert.equal((await fetch(`${base}/console/api/logins/finish`, { method: 'POST' })).status, 401);
  const done = await api('POST', '/logins/finish');
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.found, 'ann@example.com, 1 workspace, 2 projects visible');
  assert.match(done.json.note, /^Railway is connected: ann@example\.com/);
  assert.ok(!done.text.includes('rt-1') && !done.text.includes('at-1'), 'no token goes to the page');
  assert.equal(mode(file), 0o600);
  assert.equal(readRailwayLogin().refreshToken, 'rt-1');
  const after1 = (await api('GET', '/state')).json;
  assert.deepEqual([after1.login, after1.services.railway], [null, { set: true, via: 'login', who: 'ann@example.com', logs: false }]);
  assert.ok(!JSON.stringify(after1).includes('rt-1'));
  assert.equal((await api('POST', '/logins/finish')).status, 422); // nothing is waiting any more

  // The tools: the saved token while it lasts. When the hour is up it is renewed once, however many ask at the
  // same moment, and the refresh token that came with it is the one kept.
  assert.equal(railwayConfigured(), true);
  assert.deepEqual(await railwayAuth(), { token: 'at-1', api: `${railway}/graphql/v2`, via: 'login' });
  // What the tools list: the projects of each workspace that was shared.
  const listed = await railwayProjects();
  assert.deepEqual([listed.workspaces, listed.projects.map((p) => `${p.workspace}/${p.name}`), listed.projects[0].services], [['Acme'], ['Acme/api', 'Acme/web'], [{ id: 'p1-s', name: 'server' }]]);
  // Logs are not shown to a viewer (seen with a real sign-in). The tool says why and what reads them, not just "Not Authorized".
  const logs = (await authStore.run({ ok: true, role: 'admin', email: 'a@test', org_id: 'o' } as never, () => handleRailwayLogs({ deploymentId: 'd1', type: 'deploy', limit: 5 }))) as { isError?: boolean; content: Array<{ text: string }> };
  assert.deepEqual([logs.isError, /does not show it the logs\..*sign in again in the console \(Apps → Railway\) with "Also read logs" on, or set RAILWAY_TOKEN/.test(logs.content[0].text)], [true, true], logs.content[0].text);
  writeRailwayLogin({ ...readRailwayLogin(), expiresAt: Date.now() - 1000 });
  const both = await Promise.all([railwayAuth(), railwayAuth(), railwayAuth()]);
  assert.deepEqual([both.map((b) => b.token), rw.refreshes, readRailwayLogin().refreshToken], [['at-2', 'at-2', 'at-2'], 1, 'rt-2']);
  // A token in the environment is used as it always was, and the sign-in is left alone.
  process.env.RAILWAY_TOKEN = 'a-pasted-token-000';
  assert.deepEqual(await railwayAuth(), { token: 'a-pasted-token-000', api: 'https://backboard.railway.app/graphql/v2', via: 'token' });
  assert.equal((await api('GET', '/state')).json.services.railway.via, 'token');
  delete process.env.RAILWAY_TOKEN;

  // Signing in again from the same address uses the same registration. Cancelling at Railway changes nothing.
  const again = new URL((await api('POST', '/logins/railway', {})).json.url).searchParams;
  assert.deepEqual([again.get('client_id'), rw.registered.length], ['rlwy_test_1', 1]);
  assert.deepEqual(await comeBack('railway', { error: 'access_denied', state: again.get('state')! }), { status: 302, to: '/console/#/apps' });
  const cancelled = await api('POST', '/logins/finish');
  assert.deepEqual([cancelled.status, /cancelled\. Nothing was changed/.test(cancelled.json.error)], [422, true]);
  assert.deepEqual([readRailwayLogin().refreshToken, rw.deleted], ['rt-2', []]);

  // Signed in, with no workspace ticked on Railway's screen (or Railway will not show one): there is nothing to
  // read, so nothing is saved, and the page says what to do instead of "connected".
  for (const [how, why] of [
    [{ shared: false }, /shares no workspace with this server\. Sign in again and pick a workspace on Railway's screen\./],
    [{ refused: true }, /does not let this server see a workspace \(Railway said: Not Authorized\)\. Sign in again and pick/],
  ] as const) {
    Object.assign(rw, how);
    const empty = new URL((await api('POST', '/logins/railway', {})).json.url).searchParams;
    rw.challenge = empty.get('code_challenge')!;
    assert.deepEqual(await comeBack('railway', { code: 'good-code', state: empty.get('state')! }), { status: 302, to: '/console/#/apps' });
    const nothing = await api('POST', '/logins/finish');
    assert.deepEqual([nothing.status, why.test(nothing.json.error)], [422, true], nothing.text);
    assert.deepEqual([readRailwayLogin().refreshToken, rw.deleted, rw.registered.length], ['rt-2', [], 1]);
    Object.assign(rw, { shared: true, refused: false });
  }
  // A tool that is asked later, after the workspace was taken away, says where to go.
  rw.shared = false;
  await assert.rejects(() => railwayProjects(), /shares no workspace with this server\. Open the console \(Apps → Railway\)/);
  rw.shared = true;

  // A registration made by a version that asked for less is not used again. The server registers anew, and the
  // old registration is deleted once the new sign-in is saved.
  const older = readRailwayLogin();
  writeRailwayLogin({ ...older, client: { ...older.client!, scope: 'openid email offline_access workspace:viewer' } });
  const renewed = new URL((await api('POST', '/logins/railway', {})).json.url).searchParams;
  assert.deepEqual([renewed.get('client_id'), rw.registered.length], ['rlwy_test_2', 2]);
  rw.challenge = renewed.get('code_challenge')!;
  await comeBack('railway', { code: 'good-code', state: renewed.get('state')! });
  assert.equal((await api('POST', '/logins/finish')).status, 200);
  await new Promise((r) => setTimeout(r, 100)); // the old registration is deleted without being waited for
  assert.deepEqual([readRailwayLogin().client?.id, readRailwayLogin().client?.scope, rw.deleted], ['rlwy_test_2', renewed.get('scope'), ['rlwy_test_1 Bearer reg-1']]);

  // Reading logs is asked for knowingly. The sign-in then asks for member access (Railway shows logs to members,
  // not to viewers), with a registration made for exactly that, and the state says which of the two it is.
  const withLogs = new URL((await api('POST', '/logins/railway', { logs: true })).json.url).searchParams;
  const asked = withLogs.get('scope')!.split(' ');
  assert.deepEqual(
    [asked.includes('workspace:member'), asked.includes('workspace:viewer'), withLogs.get('client_id'), rw.registered.at(-1).scope],
    [true, false, 'rlwy_test_3', withLogs.get('scope')],
  );
  rw.challenge = withLogs.get('code_challenge')!;
  await comeBack('railway', { code: 'good-code', state: withLogs.get('state')! });
  assert.equal((await api('POST', '/logins/finish')).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual([(await api('GET', '/state')).json.services.railway.logs, rw.deleted], [true, ['rlwy_test_1 Bearer reg-1', 'rlwy_test_2 Bearer reg-2']]);

  // Railway withdrew the sign-in: the tools say what to do, instead of an error code.
  rw.ended = true;
  writeRailwayLogin({ ...readRailwayLogin(), expiresAt: Date.now() - 1000 });
  await assert.rejects(() => railwayAuth(), /sign in again, or set RAILWAY_TOKEN/);

  // Disconnect: the file goes, and so does the registration at Railway.
  const off = await api('DELETE', '/services/railway');
  assert.equal(off.status, 200, off.text);
  assert.deepEqual([existsSync(file), rw.deleted, railwayConfigured()], [false, ['rlwy_test_1 Bearer reg-1', 'rlwy_test_2 Bearer reg-2', 'rlwy_test_3 Bearer reg-3'], false]);
  assert.deepEqual((await api('GET', '/state')).json.services.railway, { set: false, via: null, who: null, logs: null });
});

test('Google: a sign-in through your own OAuth client reads the folders you chose, and goes away cleanly', async () => {
  const gg = { revoked: [] as string[], tokenCalls: [] as URLSearchParams[] };
  const FOLDER = 'application/vnd.google-apps.folder';
  const google = await fake((req, body) => {
    const url = (req.url ?? '').split('?')[0];
    if (url === '/token') {
      const form = new URLSearchParams(body);
      gg.tokenCalls.push(form);
      if (form.get('client_secret') !== 'client-secret-for-tests-01') return { status: 401, json: { error: 'invalid_client', error_description: 'Unauthorized' } };
      return { json: { access_token: 'g-at', refresh_token: 'g-rt', expires_in: 3599, scope: 'https://www.googleapis.com/auth/drive.readonly' } };
    }
    if (url === '/revoke') {
      gg.revoked.push(new URLSearchParams(body).get('token') ?? '');
      return { json: {} };
    }
    if (req.headers.authorization !== 'Bearer g-at') return { status: 401, json: { error: { message: 'Invalid Credentials' } } };
    if (url === '/drive/about') return { json: { user: { emailAddress: 'ann@example.com' } } };
    if (url === '/drive/files/root') return { json: { id: 'my-drive-real-id-01', name: 'My Drive' } };
    if (url === '/drive/files/folder-id-aaaaaaaa') return { json: { id: 'folder-id-aaaaaaaa', name: 'Handbook', mimeType: FOLDER } };
    if (url === '/drive/files/file-id-bbbbbbbbbb') return { json: { id: 'file-id-bbbbbbbbbb', name: 'plan.pdf', mimeType: 'application/pdf' } };
    return { status: 404, json: { error: { message: 'File not found' } } };
  });
  Object.assign(googleEndpoints, { auth: `${google}/auth`, token: `${google}/token`, revoke: `${google}/revoke`, drive: `${google}/drive` });
  const file = join(data, 'google-login.json');
  const client = { clientId: '1234-abcd.apps.googleusercontent.com', clientSecret: 'client-secret-for-tests-01' };

  // What can be typed as the client and as folders.
  assert.deepEqual(parseGoogleClient(JSON.stringify({ installed: { client_id: client.clientId, client_secret: client.clientSecret } }), ''), client);
  assert.throws(() => parseGoogleClient(JSON.stringify({ type: 'service_account', client_email: 'x@y' }), ''), /service account key, not an OAuth client/);
  assert.throws(() => parseGoogleClient('1234-abcd', 'client-secret-for-tests-01'), /apps\.googleusercontent\.com/);
  assert.deepEqual(driveFolderIds(['https://drive.google.com/drive/folders/folder-id-aaaaaaaa?usp=sharing', ' folder-id-aaaaaaaa ', '']), ['folder-id-aaaaaaaa']);
  assert.throws(() => driveFolderIds(['the handbook folder']), /is not a Drive folder/);
  // Nothing to sign in with yet.
  const none = await api('POST', '/logins/google', { folders: null });
  assert.deepEqual([none.status, /client ID and the client secret/.test(none.json.error)], [422, true]);
  assert.deepEqual((await api('GET', '/logins/google')).json, { clientSaved: false, account: null, redirectUri: `${base}/console/login/google` });

  // Chosen folders. The address asks for reading Drive and nothing else.
  const started = await api('POST', '/logins/google', { ...client, folders: ['https://drive.google.com/drive/folders/folder-id-aaaaaaaa'] });
  assert.equal(started.status, 200, started.text);
  const q = new URL(started.json.url).searchParams;
  assert.deepEqual(
    [q.get('client_id'), q.get('redirect_uri'), q.get('scope'), q.get('access_type'), q.get('prompt'), q.get('code_challenge_method')],
    [client.clientId, `${base}/console/login/google`, 'https://www.googleapis.com/auth/drive.readonly', 'offline', 'consent', 'S256'],
  );
  assert.ok(!started.text.includes(client.clientSecret), 'the secret is not in the address');
  assert.deepEqual(await comeBack('google', { code: 'g-code', state: q.get('state')! }), { status: 302, to: '/console/#/documents' });
  assert.equal(createHash('sha256').update(gg.tokenCalls[0].get('code_verifier')!).digest('base64url'), q.get('code_challenge'));
  assert.deepEqual([existsSync(file), envFile().includes('GOOGLE_')], [false, false]); // the return wrote nothing
  const done = await api('POST', '/logins/finish');
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.found, 'ann@example.com, reading Handbook');
  assert.ok(!done.text.includes('g-rt') && !done.text.includes('client-secret-for-tests'));

  // Saved in the form Google's own tools use, which the Drive client reads; the folder is listed next to the one
  // that was there, and .env points at the file.
  assert.equal(mode(file), 0o600);
  assert.equal(credentialsFromJson(readFileSync(file, 'utf8'), 'the file').kind, 'refresh_token');
  assert.deepEqual(config().drive.roots, [byHand, { id: 'folder-id-aaaaaaaa', name: 'Handbook', source: 'drive' }]);
  assert.match(envFile(), new RegExp(`^GOOGLE_APPLICATION_CREDENTIALS=.*google-login\\.json`, 'm'));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = file; // what the restart does
  const state = (await api('GET', '/state')).json;
  assert.deepEqual(state.services.drive, { set: true, trusted: [], via: 'login', account: 'ann@example.com', reads: ['Handbook'] });
  assert.ok(!JSON.stringify(state).includes('g-rt') && !JSON.stringify(state).includes('client-secret-for-tests'));

  // Signing in again needs no client: the saved one is used. Now all of My Drive, under its real ID. The folder of
  // the sign-in before is replaced, the one listed by hand stays.
  assert.deepEqual((await api('GET', '/logins/google')).json, { clientSaved: true, account: 'ann@example.com', redirectUri: `${base}/console/login/google` });
  const all = new URL((await api('POST', '/logins/google', { folders: null })).json.url).searchParams;
  await comeBack('google', { code: 'g-code', state: all.get('state')! });
  assert.equal((await api('POST', '/logins/finish')).json.found, 'ann@example.com, reading My Drive');
  assert.deepEqual(config().drive.roots, [byHand, { id: 'my-drive-real-id-01', name: 'My Drive', source: 'drive' }]);

  // A file where a folder was asked for, a folder this account cannot see, a wrong secret: said in words, and
  // what is saved stays as it was.
  for (const [input, why] of [
    [{ folders: ['file-id-bbbbbbbbbb'] }, /"plan\.pdf" is a file, not a folder/],
    [{ folders: ['folder-nobody-has-0'] }, /was not found with this Google account/],
    [{ clientId: client.clientId, clientSecret: 'a-wrong-client-secret-00', folders: null }, /Google refused the sign-in \(Unauthorized\)/],
  ] as const) {
    const s = new URL((await api('POST', '/logins/google', input)).json.url).searchParams.get('state')!;
    await comeBack('google', { code: 'g-code', state: s });
    const failed = await api('POST', '/logins/finish');
    assert.deepEqual([failed.status, why.test(failed.json.error)], [422, true], failed.text);
  }
  assert.deepEqual(config().drive.roots[1].name, 'My Drive');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).client_secret, client.clientSecret);

  // Disconnect: the file, the folder it added and the permission at Google go. The folder listed by hand stays.
  const off = await api('DELETE', '/services/drive');
  assert.equal(off.status, 200, off.text);
  assert.deepEqual([existsSync(file), config().drive.roots, gg.revoked, /^GOOGLE_APPLICATION_CREDENTIALS=/m.test(envFile())], [false, [byHand], ['g-rt'], false]);
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
});

test('GitHub: the login the gh CLI has is used, and its token is never shown', async () => {
  const github = await fake((req) => (req.url === '/user' && req.headers.authorization === 'Bearer token-from-the-gh-cli-0001' ? { json: { login: 'octo' } } : { status: 401, json: {} }));
  githubEndpoint.api = github;
  script('gh', 'if [ "$1" = "--version" ]; then echo "gh version 2"; exit 0; fi\nif [ "$1 $2" = "auth token" ] && [ ! -f "$here/gh-signed-out" ]; then echo "token-from-the-gh-cli-0001"; exit 0; fi\nexit 1');

  assert.deepEqual((await api('GET', '/logins/gh')).json, { installed: true, login: 'octo' });
  const used = await api('POST', '/services/github', { fromGh: true });
  assert.equal(used.status, 200, used.text);
  assert.equal(used.json.found, 'signed in as octo');
  assert.ok(!used.text.includes('token-from-the-gh'));
  assert.match(envFile(), /^GITHUB_PAT=token-from-the-gh-cli-0001$/m);

  // gh is there but signed out, and gh is not there at all: said plainly, and nothing is saved.
  writeFileSync(join(bin, 'gh-signed-out'), '');
  assert.deepEqual((await api('GET', '/logins/gh')).json, { installed: true, login: null });
  const out = await api('POST', '/services/github', { fromGh: true });
  assert.deepEqual([out.status, /not signed in\. In a terminal: gh auth login/.test(out.json.error)], [422, true]);
  const empty = mkdtempSync(join(tmpdir(), 'kmcp-nobin-'));
  process.env.PATH = empty;
  try {
    assert.deepEqual((await api('GET', '/logins/gh')).json, { installed: false, login: null });
    assert.match((await api('POST', '/services/github', { fromGh: true })).json.error, /not installed on this machine/);
  } finally {
    process.env.PATH = `${bin}:${realPath}`;
  }
  // Neither a token nor the gh login asked for.
  assert.equal((await api('POST', '/services/github', {})).status, 400);
});

test('gcloud: the console makes the Drive service account, without holding up the server', async () => {
  script(
    'gcloud',
    [
      'echo "$*" >> "$here/gcloud.calls"',
      'expired() { [ -f "$here/gcloud-expired" ] && { echo "ERROR: (gcloud.$1) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution." >&2; exit 1; }; }',
      'case "$*" in',
      '  "--version") echo "Google Cloud SDK 500";;',
      '  "auth list"*) [ -f "$here/gcloud-signed-out" ] || echo "ann@example.com";;',
      // Its own sign-in, as it goes without a terminal: it says where the browser was sent and waits for the answer.
      '  "auth login --brief --quiet") echo "Your browser has been opened to visit:" >&2; echo "" >&2; echo "    https://accounts.example.com/o/oauth2/auth?client_id=abc&state=xyz" >&2',
      '    n=0; while [ ! -f "$here/gcloud-login-finish" ] && [ $n -lt 150 ]; do sleep 0.1; n=$((n+1)); done',
      '    [ -f "$here/gcloud-login-finish" ] || exit 1',
      '    rm -f "$here/gcloud-expired" "$here/gcloud-signed-out" "$here/gcloud-login-finish";;',
      '  "config get-value project") echo "acme-lab";;',
      `  "projects list"*) expired projects.list; echo '[{"projectId":"acme-lab","name":"Acme Lab"},{"projectId":"acme-prod","name":"acme-prod"}]';;`,
      '  "services enable"*) expired services.enable; sleep 0.3;;',
      '  "iam service-accounts describe"*) exit 1;;',
      '  "iam service-accounts create"*) ;;',
      `  "iam service-accounts keys create"*) echo '{"type":"service_account","client_email":"knowledge-mcp-drive@acme-lab.iam.gserviceaccount.com","private_key":"k"}' > "$5";;`,
      '  *) exit 1;;',
      'esac',
    ].join('\n'),
  );
  const keyPath = join(dir, 'drive-service-account.json');

  assert.deepEqual((await api('GET', '/logins/gcloud')).json, {
    installed: true,
    account: 'ann@example.com',
    project: 'acme-lab',
    projects: [{ id: 'acme-lab', name: 'Acme Lab' }, { id: 'acme-prod', name: 'acme-prod' }],
    problem: null,
    needsSignIn: false,
  });
  // While gcloud works, the server keeps answering.
  const making = api('POST', '/services/drive', { gcloud: { project: 'acme-lab' } });
  const meanwhile = await fetch(`${base}/health`);
  assert.equal(meanwhile.status, 200);
  const made = await making;
  assert.equal(made.status, 200, made.text);
  assert.equal(made.json.email, 'knowledge-mcp-drive@acme-lab.iam.gserviceaccount.com');
  assert.deepEqual([mode(keyPath), envFile().includes(`GOOGLE_APPLICATION_CREDENTIALS=${keyPath}`)], [0o600, true]);
  // Whoever made the account is the first owner whose shared documents are shown.
  assert.deepEqual(config().drive.trustedOwners, ['example.com']);
  const calls = readFileSync(join(bin, 'gcloud.calls'), 'utf8');
  assert.match(calls, /services enable drive\.googleapis\.com --project=acme-lab/);
  assert.ok(!/add-iam-policy-binding|roles\//.test(calls), 'the account gets no role');

  // Asked again, the key this console wrote makes way for a new one.
  assert.equal((await api('POST', '/services/drive', { gcloud: { project: 'acme-lab' } })).status, 200);
  // Something that is not a project ID never reaches the command line, and a signed-out gcloud is said plainly.
  assert.equal((await api('POST', '/services/drive', { gcloud: { project: '--impersonate-service-account=x' } })).status, 400);
  writeFileSync(join(bin, 'gcloud-signed-out'), '');
  const out = await api('POST', '/services/drive', { gcloud: { project: 'acme-lab' } });
  assert.deepEqual([out.status, /gcloud auth login/.test(out.json.error)], [422, true]);
  assert.deepEqual((await api('GET', '/logins/gcloud')).json, { installed: true, account: null, project: null, projects: [], problem: null, needsSignIn: true });
  rmSync(join(bin, 'gcloud-signed-out'));

  // Signed in, and Google wants the sign-in again (an organization account, after a while). gcloud would ask in a
  // terminal and has none here. The page says what to run, in the list of projects and when the button is pressed,
  // not gcloud's own sentence about tokens and prompts.
  writeFileSync(join(bin, 'gcloud-expired'), '');
  const expected = /^gcloud's sign-in has expired, and gcloud cannot ask for it again from here\. Run this in a terminal, then try again: gcloud auth login$/;
  const stale = (await api('GET', '/logins/gcloud')).json;
  assert.deepEqual([stale.account, stale.projects, expected.test(stale.problem), stale.needsSignIn], ['ann@example.com', [], true, true], JSON.stringify(stale));
  const pressed = await api('POST', '/services/drive', { gcloud: { project: 'acme-lab' } });
  assert.deepEqual([pressed.status, expected.test(pressed.json.error)], [422, true], pressed.text);
  assert.ok(!/non-interactive|refreshing your current auth tokens/.test(pressed.text));

  // The console runs gcloud's sign-in itself. gcloud opens the browser; the page is told where, and waits.
  assert.deepEqual((await api('GET', '/logins/gcloud/sign-in')).json, { running: false, url: null, code: null, line: null, ok: null, error: null });
  assert.equal((await api('POST', '/logins/gcloud/sign-in')).json.running, true);
  const shown = await step('gcloud', 'sign-in', (r) => !!r.url);
  assert.deepEqual([shown.running, shown.url], [true, 'https://accounts.example.com/o/oauth2/auth?client_id=abc&state=xyz']);
  await api('POST', '/logins/gcloud/sign-in'); // pressed twice: still the one sign-in
  assert.equal(readFileSync(join(bin, 'gcloud.calls'), 'utf8').split('\n').filter((l) => l.startsWith('auth login')).length, 1);
  writeFileSync(join(bin, 'gcloud-login-finish'), '');
  assert.deepEqual(await step('gcloud', 'sign-in', (r) => !r.running), { running: false, url: null, code: null, line: null, ok: true, error: null });
  const fresh = (await api('GET', '/logins/gcloud')).json;
  assert.deepEqual([fresh.needsSignIn, fresh.problem, fresh.projects.length], [false, null, 2]);
  assert.equal(existsSync(join(bin, 'gcloud-expired')), false);
});

/** Ask how far a step with a tool is until it is where the test wants it. */
const step = async (tool: string, action: string, there: (r: any) => boolean): Promise<any> => {
  for (let i = 0; i < 300; i++) {
    const r = (await api('GET', `/logins/${tool}/${action}`)).json;
    if (there(r)) return r;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${tool} ${action} did not get there`);
};

test('a tool that is missing or signed out is installed and signed in from the console: gh from nothing to connected', async () => {
  const github = await fake((req) => (req.url === '/user' && req.headers.authorization === 'Bearer token-from-the-gh-cli-0001' ? { json: { login: 'octo' } } : { status: 401, json: {} }));
  githubEndpoint.api = github;
  script(
    'gh',
    [
      '[ -f "$here/gh-missing" ] && exit 127',
      'if [ "$1" = "--version" ]; then echo "gh version 2"; exit 0; fi',
      'if [ "$1 $2" = "auth token" ] && [ ! -f "$here/gh-signed-out" ]; then echo "token-from-the-gh-cli-0001"; exit 0; fi',
      // Its own sign-in, as it goes without a terminal: a code, the address to type it at, and a wait for GitHub.
      'if [ "$*" = "auth login --hostname github.com --web" ]; then',
      '  echo "$*" >> "$here/gh.calls"',
      '  echo "! First copy your one-time code: ABCD-1234" >&2',
      '  echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2',
      '  n=0; while [ ! -f "$here/gh-login-finish" ] && [ $n -lt 150 ]; do sleep 0.1; n=$((n+1)); done',
      '  [ -f "$here/gh-login-finish" ] || exit 1',
      '  rm -f "$here/gh-signed-out" "$here/gh-login-finish"; exit 0',
      'fi',
      'exit 1',
    ].join('\n'),
  );
  script(
    'brew',
    [
      'echo "$*" >> "$here/brew.calls"',
      'case "$*" in',
      '  "--version") echo "Homebrew 4";;',
      '  "install gh") echo "==> Fetching gh"; sleep 0.3; [ -f "$here/brew-fails" ] && { echo "Error: No available formula with the name gh" >&2; exit 1; }; rm -f "$here/gh-missing"; echo "==> Pouring gh";;',
      '  *) exit 1;;',
      'esac',
    ].join('\n'),
  );
  writeFileSync(join(bin, 'gh-missing'), '');
  writeFileSync(join(bin, 'gh-signed-out'), '');
  assert.deepEqual((await api('GET', '/logins/gh')).json, { installed: false, login: null });

  // Install: the page is told what would run before anybody agrees to it.
  const plan = (await api('GET', '/logins/gh/install')).json;
  assert.deepEqual([plan.running, plan.command, plan.page], [false, 'brew install gh', 'https://cli.github.com/']);
  // It fails: what the package manager said is shown, and nothing is half-done.
  writeFileSync(join(bin, 'brew-fails'), '');
  assert.equal((await api('POST', '/logins/gh/install')).status, 200);
  const failed = await step('gh', 'install', (r) => !r.running);
  assert.deepEqual([failed.ok, failed.error], [false, 'Error: No available formula with the name gh']);
  rmSync(join(bin, 'brew-fails'));
  // It works: while it runs the page sees how far it is.
  assert.equal((await api('POST', '/logins/gh/install')).json.running, true);
  assert.match((await step('gh', 'install', (r) => !!r.line || !r.running)).line ?? '==> Fetching gh', /^==> /);
  assert.equal((await step('gh', 'install', (r) => !r.running)).ok, true);
  assert.deepEqual((await api('GET', '/logins/gh')).json, { installed: true, login: null });

  // Sign in: gh gives a code, the page shows it with the address to type it at.
  assert.equal((await api('POST', '/logins/gh/sign-in')).json.running, true);
  const code = await step('gh', 'sign-in', (r) => !!r.code);
  assert.deepEqual([code.code, code.url], ['ABCD-1234', 'https://github.com/login/device']);
  await api('POST', '/logins/gh/sign-in');
  assert.equal(readFileSync(join(bin, 'gh.calls'), 'utf8').trim().split('\n').length, 1);
  // Given up: gh is stopped and nothing is remembered.
  assert.equal((await api('DELETE', '/logins/gh/sign-in')).status, 200);
  assert.deepEqual((await api('GET', '/logins/gh/sign-in')).json, { running: false, url: null, code: null, line: null, ok: null, error: null });
  // Again, and this time the code is typed at GitHub.
  await api('POST', '/logins/gh/sign-in');
  await step('gh', 'sign-in', (r) => !!r.code);
  writeFileSync(join(bin, 'gh-login-finish'), '');
  assert.equal((await step('gh', 'sign-in', (r) => !r.running)).ok, true);
  assert.deepEqual((await api('GET', '/logins/gh')).json, { installed: true, login: 'octo' });
  assert.equal((await api('POST', '/services/github', { fromGh: true })).status, 200);

  // Only these two tools and these two steps, and only with the console token.
  assert.equal((await api('POST', '/logins/bash/install')).status, 400);
  assert.equal((await api('POST', '/logins/gh/remove')).status, 400);
  assert.equal((await fetch(`${base}/console/api/logins/gh/install`, { method: 'POST' })).status, 401);

  // A machine without a package manager this knows: nothing is run, and the page is sent to the tool's own instructions.
  const empty = mkdtempSync(join(tmpdir(), 'kmcp-nobrew-'));
  process.env.PATH = empty;
  try {
    assert.equal((await api('GET', '/logins/gcloud/install')).json.command, null);
    const none = await api('POST', '/logins/gcloud/install');
    assert.deepEqual([none.status, /no package manager the console can use.*https:\/\/cloud\.google\.com\/sdk\/docs\/install/.test(none.json.error)], [422, true], none.text);
  } finally {
    process.env.PATH = `${bin}:${realPath}`;
  }

  // What would be run where. Windows has winget; the gcloud cask is for macOS.
  const has = (...tools: string[]) => async (cmd: string) => ({ status: tools.includes(cmd) ? 0 : 127, stdout: '', stderr: '' });
  assert.deepEqual(await installCommand('gcloud', has('brew'), 'darwin'), ['brew', 'install', '--cask', 'gcloud-cli']);
  assert.deepEqual(await installCommand('gcloud', has('brew'), 'linux'), null);
  assert.deepEqual(await installCommand('gh', has('brew'), 'linux'), ['brew', 'install', 'gh']);
  assert.deepEqual((await installCommand('gcloud', has('winget'), 'win32'))?.slice(0, 4), ['winget', 'install', '--id', 'Google.CloudSDK']);
  assert.deepEqual((await installCommand('gh', has('winget'), 'win32'))?.slice(0, 4), ['winget', 'install', '--id', 'GitHub.cli']);
  assert.deepEqual(await installCommand('gh', has(), 'win32'), null);
});

test('a server cannot borrow another service\'s sign-in, or send this server into the network behind it', async () => {
  // It says its sign-in is for somebody else's address: signing in would hand that address's access to it.
  const borrower = await fakeMcpServer('sign-in', { resource: 'https://mcp.example.org/mcp' });
  const refused = await api('POST', '/upstreams', { name: 'borrower', url: borrower.url });
  assert.deepEqual([refused.status, /says its sign-in is for another address \(https:\/\/mcp\.example\.org\/mcp\)\..*Not added\./.test(refused.json.error)], [422, true], refused.text);
  assert.equal(borrower.st.registered.length, 0, 'nothing was registered anywhere');

  // Where its sign-in sends this server (to register, for the token): not this machine, not a private network,
  // and not without https. A server that is itself on this machine may say what it likes.
  for (const address of ['http://127.0.0.1:6333/collections', 'https://localhost/token', 'http://169.254.169.254/latest', 'https://10.0.0.5/register', 'https://192.168.1.10/x', 'https://[::1]/x', 'https://db.internal/x', 'http://auth.example.com/token']) {
    assert.throws(() => signInAddress(address, 'the token', false), /an address on this machine or a private network, or one without https\. Not added\./, address);
    assert.doesNotThrow(() => signInAddress(address, 'the token', true));
  }
  for (const address of ['https://auth.example.com/token', 'https://8.8.8.8/x', undefined]) assert.doesNotThrow(() => signInAddress(address, 'the token', false));
  assert.throws(() => signInAddress('not an address', 'the token', false), /is not an address/);

  // Is the sign-in at the server's own owner? The page asks before going anywhere else.
  assert.deepEqual(
    [sameOwner('mcp.notion.com', 'www.notion.com'), sameOwner('mcp.example.co.uk', 'login.example.co.uk'), sameOwner('a.example.co.uk', 'b.other.co.uk'), sameOwner('mcp.evil.example', 'mcp.notion.com'), sameOwner('127.0.0.1:1', '127.0.0.1:2')],
    [true, true, false, false, true],
  );
});

/**
 * An MCP server as a service runs one: it answers MCP requests over HTTP POST, and (when it wants a sign-in) says
 * where to sign in, lets a client register itself, and hands out tokens that run out.
 */
async function fakeMcpServer(kind: 'sign-in' | 'token' | 'open', opts: { selfRegistration?: boolean; resource?: string } = {}) {
  const st = { registered: [] as any[], unregistered: [] as string[], revoked: [] as string[], refreshes: 0, challenge: '', valid: 'mat-1', refresh: 'mrt-1', ended: false, calls: [] as string[], tokenForms: [] as URLSearchParams[] };
  const tools = [
    { name: 'notion-search', description: 'Search pages', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'notion-fetch', description: 'Read a page', inputSchema: { type: 'object' } }, // says nothing: its name decides
    { name: 'list_things', description: 'List things', inputSchema: { type: 'object' } },
    { name: 'notion-create-pages', description: 'Create pages', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
    { name: 'get_or_create_page', description: 'Reads, or makes one', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } }, // a read verb, but it says it changes things
    { name: 'archive_thing', description: 'Archive a thing', inputSchema: { type: 'object' } },
  ];
  let base = '';
  base = await fake((req, body) => {
    const url = (req.url ?? '').split('?')[0];
    if (url.startsWith('/.well-known/oauth-protected-resource')) {
      return kind === 'sign-in' ? { json: { resource: opts.resource ?? `${base}/mcp`, authorization_servers: [base], scopes_supported: ['read', 'write'] } } : { status: 404, json: {} };
    }
    if (url.startsWith('/.well-known/oauth-authorization-server')) {
      if (kind !== 'sign-in') return { status: 404, json: {} };
      return {
        json: {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          ...(opts.selfRegistration === false ? {} : { registration_endpoint: `${base}/register` }),
          revocation_endpoint: `${base}/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          scopes_supported: ['read', 'write', 'offline_access'],
        },
      };
    }
    if (url.startsWith('/.well-known/')) return { status: 404, json: {} };
    if (url === '/register' && req.method === 'POST') {
      const asked = JSON.parse(body);
      st.registered.push(asked);
      const id = `c-${st.registered.length}`;
      return { status: 201, json: { ...asked, client_id: id, registration_client_uri: `${base}/register/${id}`, registration_access_token: `reg-${st.registered.length}` } };
    }
    if (url.startsWith('/register/') && req.method === 'DELETE') {
      st.unregistered.push(`${url.split('/').pop()} ${req.headers.authorization}`);
      return { status: 204 };
    }
    if (url === '/revoke') {
      st.revoked.push(new URLSearchParams(body).get('token') ?? '');
      return { json: {} };
    }
    if (url === '/token') {
      const form = new URLSearchParams(body);
      st.tokenForms.push(form);
      if (form.get('grant_type') === 'authorization_code') {
        const proven = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === st.challenge;
        if (form.get('code') !== 'the-code' || !proven) return { status: 400, json: { error: 'invalid_grant', error_description: 'bad code' } };
        return { json: { access_token: 'mat-1', refresh_token: 'mrt-1', token_type: 'Bearer', expires_in: 3600 } };
      }
      if (st.ended || form.get('refresh_token') !== st.refresh) return { status: 400, json: { error: 'invalid_grant', error_description: 'the grant is gone' } };
      st.refreshes++;
      st.valid = `mat-${st.refreshes + 1}`;
      st.refresh = `mrt-${st.refreshes + 1}`;
      return { json: { access_token: st.valid, refresh_token: st.refresh, token_type: 'Bearer', expires_in: 3600 } };
    }
    if (url === '/mcp' && req.method === 'POST') {
      const given = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const allowed = kind === 'open' || (kind === 'token' ? given === 'a-token-the-service-gave-01' : given === st.valid);
      if (!allowed) return { status: 401, json: { error: 'unauthorized' }, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` } };
      const m = JSON.parse(body);
      if (m.id === undefined) return { status: 202 }; // a notification
      if (m.method === 'initialize') return { json: { jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } } };
      if (m.method === 'tools/list') return { json: { jsonrpc: '2.0', id: m.id, result: { tools } } };
      if (m.method === 'tools/call') {
        st.calls.push(`${m.params.name} ${given}`);
        return { json: { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `${m.params.name} ran` }] } } };
      }
      return { json: { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } } };
    }
    return { status: url === '/mcp' ? 405 : 404, json: {} };
  });
  return { base, url: `${base}/mcp`, st };
}

test('what the read-only gateway shows: what the remote says about a tool comes first, then its name', () => {
  const spec = { name: 'notion', url: 'https://mcp.example.com/mcp', prefix: 'notion_' };
  // The remote marks the tool: that decides, whatever it is called.
  assert.equal(isExposed(spec, 'whoami', true), true);
  assert.equal(isExposed(spec, 'get_or_create_page', false), false);
  // It says nothing: the first word decides, and the service's own name in front is not a word about the tool.
  assert.deepEqual(['get_page', 'notion-search', 'notion_fetch', 'listItems'].map((n) => isExposed(spec, n)), [true, true, true, true]);
  assert.deepEqual(['create_page', 'notion-update-page', 'notion', 'archive'].map((n) => isExposed(spec, n)), [false, false, false, false]);
  assert.equal(isExposed({ ...spec, name: 'wiki' }, 'notion-search'), false); // another service's name is just an unknown verb
  // Opened up on purpose.
  assert.equal(isExposed({ ...spec, expose: 'all' }, 'create_page', false), true);
  assert.deepEqual([isExposed({ ...spec, expose: ['create_page'] }, 'create_page'), isExposed({ ...spec, expose: ['create_page'] }, 'get_page', true)], [true, false]);
});

test("another service's MCP server: sign in from the console, and its read tools arrive behind this server", async () => {
  const notion = await fakeMcpServer('sign-in');
  const file = join(data, 'mcp-logins', 'notion.json');
  const upstreamsNow = () => config().upstreams ?? [];

  // What cannot be added, said before anything is asked of the remote.
  for (const [body, why] of [
    [{ name: 'github', url: notion.url }, /already has/],
    [{ name: 'Not A Name', url: notion.url }, /lowercase letters, digits and dashes/],
    [{ name: 'notion', url: 'http://mcp.example.com/mcp' }, /must start with https/],
    [{ name: 'notion', url: 'https://user:secret@mcp.example.com/mcp' }, /Leave the user name and password out/],
    [{ name: 'notion', url: 'not an address' }, /not an address/],
  ] as const) {
    const refused = await api('POST', '/upstreams', body);
    assert.deepEqual([refused.status, why.test(refused.json.error)], [422, true], refused.text);
  }
  assert.equal(notion.st.registered.length, 0);

  // The server wants a sign-in: this server registers itself there and the page is sent to sign in.
  const added = await api('POST', '/upstreams', { name: 'notion', url: notion.url });
  assert.equal(added.status, 200, added.text);
  const q = new URL(added.json.signIn).searchParams;
  assert.equal(added.json.signIn.split('?')[0], `${notion.base}/authorize`);
  // The page is told where the sign-in happens. Here it is the server's own address, so nothing is asked.
  assert.deepEqual([added.json.at, added.json.server, added.json.elsewhere], [new URL(notion.base).host, new URL(notion.url).host, false]);
  assert.deepEqual(
    [q.get('client_id'), q.get('redirect_uri'), q.get('response_type'), q.get('code_challenge_method'), q.get('resource'), q.get('scope')],
    ['c-1', `${base}/console/login/mcp`, 'code', 'S256', notion.url, 'read write offline_access'],
  );
  assert.deepEqual(
    [notion.st.registered[0].redirect_uris, notion.st.registered[0].token_endpoint_auth_method, notion.st.registered[0].application_type],
    [[`${base}/console/login/mcp`], 'none', 'native'],
  );
  notion.st.challenge = q.get('code_challenge')!;
  assert.deepEqual(upstreamsNow(), []); // nothing is in the list until the sign-in is saved

  // Back from the service. The code is traded and the tools are looked at; still nothing is written.
  assert.deepEqual(await comeBack('mcp', { code: 'the-code', state: q.get('state')! }), { status: 302, to: '/console/#/apps' });
  assert.deepEqual([existsSync(file), upstreamsNow()], [false, []]);
  assert.equal(notion.st.tokenForms[0].get('resource'), notion.url);
  assert.deepEqual((await api('GET', '/state')).json.login, { service: 'mcp' });
  const done = await api('POST', '/logins/finish');
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.note, 'notion is connected: 3 of its 6 tools (the rest change things and stay off).');
  assert.ok(!done.text.includes('mat-1') && !done.text.includes('mrt-1'), 'no token goes to the page');
  assert.equal(mode(file), 0o600);
  assert.deepEqual(upstreamsNow(), [{ name: 'notion', url: notion.url, signIn: true }]);
  const view = (await api('GET', '/state')).json.upstreams[0];
  assert.deepEqual([view.name, view.prefix, view.expose, view.via, view.signedIn, view.running], ['notion', 'notion_', 'read', 'login', true, false]);

  // The gateway, as the restarted server builds it: read tools only, under the service's name, called with the sign-in.
  const bearer = (rejected?: string) => upstreamToken('notion', notion.url, rejected);
  const gateway = new UpstreamManager([{ group: 'notion', spec: { name: 'notion', url: notion.url, prefix: 'notion_', bearer } }]);
  await gateway.connectAll();
  assert.deepEqual(gateway.tools().map((t) => t.tool.name), ['notion_notion-search', 'notion_notion-fetch', 'notion_list_things']);
  assert.deepEqual(gateway.statuses()[0], { name: 'notion', connected: true, toolCount: 3, hidden: 3, error: null });
  assert.equal(gateway.owner('notion_get_or_create_page'), null); // a read verb, but the remote says it changes things
  assert.equal(gateway.owner('notion_notion-create-pages'), null);
  await gateway.owner('notion_list_things')!.call({});
  assert.equal(notion.st.calls.at(-1), 'list_things mat-1');

  // The hour is up: the next call renews the sign-in by itself, and the new refresh token is the one kept.
  writeUpstreamLogin('notion', { ...readUpstreamLogin('notion')!, expiresAt: Date.now() - 1000 });
  await Promise.all([gateway.owner('notion_list_things')!.call({}), gateway.owner('notion_notion-search')!.call({})]);
  assert.deepEqual([notion.st.refreshes, notion.st.calls.at(-1)!.split(' ')[1], readUpstreamLogin('notion')!.refreshToken], [1, 'mat-2', 'mrt-2']);
  assert.equal(notion.st.tokenForms.at(-1)!.get('resource'), notion.url);
  // The service withdrew a token before its time: the call is refused once, the sign-in is renewed, and the call goes through.
  notion.st.valid = 'withdrawn';
  await gateway.owner('notion_list_things')!.call({});
  assert.deepEqual([notion.st.refreshes, notion.st.calls.at(-1)], [2, 'list_things mat-3']);
  // A sign-in is for the address it was made for.
  await assert.rejects(() => upstreamToken('notion', 'https://elsewhere.example.com/mcp'), /was made for .* not for this address/);

  // Everything it can do, when the person asks for that. What was saved about the sign-in stays.
  const opened = await api('PATCH', '/upstreams/notion', { expose: 'all' });
  assert.equal(opened.status, 200, opened.text);
  assert.deepEqual(upstreamsNow(), [{ name: 'notion', url: notion.url, signIn: true, expose: 'all' }]);
  const all = new UpstreamManager([{ group: 'notion', spec: { name: 'notion', url: notion.url, prefix: 'notion_', bearer, expose: 'all' } }]);
  await all.connectAll();
  assert.equal(all.tools().length, 6);
  assert.equal((await api('PATCH', '/upstreams/nobody', { expose: 'all' })).status, 404);

  // Signing in again from the same address uses the registration that is there.
  const again = new URL((await api('POST', '/upstreams', { name: 'notion', url: notion.url })).json.signIn).searchParams;
  assert.deepEqual([again.get('client_id'), notion.st.registered.length], ['c-1', 1]);
  // The same name for another address is refused: a name is one server.
  assert.match((await api('POST', '/upstreams', { name: 'notion', url: 'https://other.example.com/mcp' })).json.error, /already in the list with another address/);

  // The service ended the sign-in: the gateway says what to do.
  notion.st.ended = true;
  notion.st.valid = 'withdrawn';
  await assert.rejects(() => gateway.owner('notion_list_things')!.call({}), /sign-in is no longer valid\. Open the console \(Apps\) and sign in again/);

  // Remove: out of the list, the file gone, and the permission and the registration taken back at the service.
  const removed = await api('DELETE', '/upstreams/notion');
  assert.equal(removed.status, 200, removed.text);
  assert.deepEqual([upstreamsNow(), existsSync(file), notion.st.revoked, notion.st.unregistered], [[], false, ['mrt-3'], ['c-1 Bearer reg-1']]);
  assert.equal((await api('DELETE', '/upstreams/notion')).status, 404);
});

test("another service's MCP server: with a token, without anything, and one that cannot be signed in to from here", async () => {
  const upstreamsNow = () => config().upstreams ?? [];
  // The service gives tokens: checked by listing the tools, then kept in .env under a name of its own.
  const withToken = await fakeMcpServer('token');
  const wrong = await api('POST', '/upstreams', { name: 'tracker', url: withToken.url, token: 'not-the-right-token-00' });
  assert.deepEqual([wrong.status, /did not list its tools/.test(wrong.json.error), upstreamsNow()], [422, true, []]);
  const ok = await api('POST', '/upstreams', { name: 'tracker', url: withToken.url, token: 'a-token-the-service-gave-01' });
  assert.equal(ok.status, 200, ok.text);
  // Under this name "notion-fetch" is not a read verb any more: only what the remote marks, and what reads by name.
  assert.equal(ok.json.found, '2 of its 6 tools (the rest change things and stay off)');
  assert.ok(!ok.text.includes('a-token-the-service'));
  assert.match(envFile(), /^TRACKER_MCP_TOKEN=a-token-the-service-gave-01$/m);
  assert.deepEqual(upstreamsNow(), [{ name: 'tracker', url: withToken.url, tokenEnv: 'TRACKER_MCP_TOKEN' }]);
  assert.equal((await api('GET', '/state')).json.upstreams[0].via, 'token');

  // An open server needs nothing.
  const open = await fakeMcpServer('open');
  const plain = await api('POST', '/upstreams', { name: 'docs-site', url: open.url });
  assert.equal(plain.status, 200, plain.text);
  assert.deepEqual(upstreamsNow()[1], { name: 'docs-site', url: open.url });
  // A name is one server, and a name already used by something else here is not free.
  assert.match((await api('POST', '/upstreams', { name: 'docs-site', url: 'https://other.example.com/mcp' })).json.error, /already in the list with another address/);

  // A server that wants an app made by hand first: said so, with the way out.
  const byHand = await fakeMcpServer('sign-in', { selfRegistration: false });
  const cannot = await api('POST', '/upstreams', { name: 'crm', url: byHand.url });
  assert.deepEqual([cannot.status, /wants an app registered with it by hand.*paste one instead/.test(cannot.json.error)], [422, true], cannot.text);
  // Not an MCP server at all.
  const notMcp = await fake(() => ({ status: 404, json: {} }));
  assert.match((await api('POST', '/upstreams', { name: 'site', url: `${notMcp}/` })).json.error, /answered 404 to an MCP request/);

  // Removing the one with a token takes the token out of .env too.
  assert.equal((await api('DELETE', '/upstreams/tracker')).status, 200);
  assert.ok(!/^TRACKER_MCP_TOKEN=/m.test(envFile()));
  assert.equal((await api('DELETE', '/upstreams/docs-site')).status, 200);
  assert.deepEqual(upstreamsNow(), []);
});

