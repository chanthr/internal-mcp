/**
 * Connecting a service by signing in instead of pasting a token: Railway (the server registers itself), Google
 * (through an OAuth client of the person's own), the login the gh CLI already has, and a service account made by
 * gcloud. The other sites are local fakes and the command lines are scripts, so nothing leaves this machine.
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
const { credentialsFromJson } = await import('../src/plugins/drive/client.js');

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
const fake = async (handle: (req: IncomingMessage, body: string) => { status?: number; json?: unknown }) => {
  const s = createServer(async (req, res) => {
    const out = handle(req, await read(req));
    res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
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
  const rw = { registered: [] as any[], deleted: [] as string[], refreshes: 0, current: 'rt-1', challenge: '', ended: false };
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
    if (url === '/graphql/v2') {
      if (!/^Bearer at-\d$/.test(req.headers.authorization ?? '')) return { json: { errors: [{ message: 'Not Authorized' }] } };
      return { json: body.includes('projects') ? { data: { projects: { edges: [{ node: { id: 'p1' } }, { node: { id: 'p2' } }] } } } : { data: { me: { name: 'Ann', email: 'ann@example.com' } } } };
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
  assert.deepEqual(q.get('scope')!.split(' ').sort(), ['email', 'offline_access', 'openid', 'workspace:viewer']); // it only reads
  assert.deepEqual([rw.registered[0].redirect_uris, rw.registered[0].token_endpoint_auth_method], [[`${base}/console/login/railway`], 'none']);
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
  assert.equal(done.json.found, 'ann@example.com, 2 projects visible');
  assert.match(done.json.note, /^Railway is connected: ann@example\.com/);
  assert.ok(!done.text.includes('rt-1') && !done.text.includes('at-1'), 'no token goes to the page');
  assert.equal(mode(file), 0o600);
  assert.equal(readRailwayLogin().refreshToken, 'rt-1');
  const after1 = (await api('GET', '/state')).json;
  assert.deepEqual([after1.login, after1.services.railway], [null, { set: true, via: 'login', who: 'ann@example.com' }]);
  assert.ok(!JSON.stringify(after1).includes('rt-1'));
  assert.equal((await api('POST', '/logins/finish')).status, 422); // nothing is waiting any more

  // The tools: the saved token while it lasts. When the hour is up it is renewed once, however many ask at the
  // same moment, and the refresh token that came with it is the one kept.
  assert.equal(railwayConfigured(), true);
  assert.deepEqual(await railwayAuth(), { token: 'at-1', api: `${railway}/graphql/v2` });
  writeRailwayLogin({ ...readRailwayLogin(), expiresAt: Date.now() - 1000 });
  const both = await Promise.all([railwayAuth(), railwayAuth(), railwayAuth()]);
  assert.deepEqual([both.map((b) => b.token), rw.refreshes, readRailwayLogin().refreshToken], [['at-2', 'at-2', 'at-2'], 1, 'rt-2']);
  // A token in the environment is used as it always was, and the sign-in is left alone.
  process.env.RAILWAY_TOKEN = 'a-pasted-token-000';
  assert.deepEqual(await railwayAuth(), { token: 'a-pasted-token-000', api: 'https://backboard.railway.app/graphql/v2' });
  assert.equal((await api('GET', '/state')).json.services.railway.via, 'token');
  delete process.env.RAILWAY_TOKEN;

  // Signing in again from the same address uses the same registration. Cancelling at Railway changes nothing.
  const again = new URL((await api('POST', '/logins/railway', {})).json.url).searchParams;
  assert.deepEqual([again.get('client_id'), rw.registered.length], ['rlwy_test_1', 1]);
  assert.deepEqual(await comeBack('railway', { error: 'access_denied', state: again.get('state')! }), { status: 302, to: '/console/#/apps' });
  const cancelled = await api('POST', '/logins/finish');
  assert.deepEqual([cancelled.status, /cancelled\. Nothing was changed/.test(cancelled.json.error)], [422, true]);
  assert.deepEqual([readRailwayLogin().refreshToken, rw.deleted], ['rt-2', []]);

  // Railway withdrew the sign-in: the tools say what to do, instead of an error code.
  rw.ended = true;
  writeRailwayLogin({ ...readRailwayLogin(), expiresAt: Date.now() - 1000 });
  await assert.rejects(() => railwayAuth(), /sign in again, or set RAILWAY_TOKEN/);

  // Disconnect: the file goes, and so does the registration at Railway.
  const off = await api('DELETE', '/services/railway');
  assert.equal(off.status, 200, off.text);
  assert.deepEqual([existsSync(file), rw.deleted, railwayConfigured()], [false, ['rlwy_test_1 Bearer reg-1'], false]);
  assert.deepEqual((await api('GET', '/state')).json.services.railway, { set: false, via: null, who: null });
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
      'case "$*" in',
      '  "--version") echo "Google Cloud SDK 500";;',
      '  "auth list"*) [ -f "$here/gcloud-signed-out" ] || echo "ann@example.com";;',
      '  "config get-value project") echo "acme-lab";;',
      `  "projects list"*) echo '[{"projectId":"acme-lab","name":"Acme Lab"},{"projectId":"acme-prod","name":"acme-prod"}]';;`,
      '  "services enable"*) sleep 0.3;;',
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
  assert.deepEqual((await api('GET', '/logins/gcloud')).json, { installed: true, account: null, project: null, projects: [], problem: null });
  rmSync(join(bin, 'gcloud-signed-out'));
});
