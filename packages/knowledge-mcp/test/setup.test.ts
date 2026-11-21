/**
 * The setup wizard, driven with scripted answers against fake services: values are checked before they are saved,
 * a rejected token can be retried or skipped, .env keeps what was there, the embedding size is read from the
 * endpoint, and the first admin gets a key.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runSetup, parseSelection } = await import('../src/setup/wizard.js');
const { updateEnvFile, readEnvKeys, readEnvValues, formatEnvValue } = await import('../src/setup/envfile.js');
const { checkEmbedding, checkSlack, checkGithub, checkRailway } = await import('../src/setup/checks.js');
const auto = await import('../src/setup/auto.js');
const { runSetupCommand } = await import('../src/setup/commands.js');
type Exec = import('../src/setup/auto.js').Exec;

/** No CLI installed: every command fails like a missing binary. */
const noTools: Exec = () => ({ status: 127, stdout: '', stderr: 'not found' });

// Everything that is awaited at the top level (imports, servers) happens here, before the first test is
// registered. An await between tests suspends this file while the tests registered so far run; when they finish
// first, the runner takes the file for done and runs the `after` hooks, and the tests registered later find the
// servers closed (ECONNREFUSED). It showed up on a loaded machine, when an import in the middle got slower.
// One fake for Slack, GitHub, Railway and an embedding endpoint. "good-*" tokens pass.
/** The Authorization header of every request for vectors, "(none)" when there was none. */
const embeddingAuth: string[] = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const auth = req.headers.authorization ?? '';
    const good = /Bearer good/.test(auth);
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.url === '/slack/auth.test') return send(200, good ? { ok: true, team: 'Acme', user: 'kbot', bot_id: 'B1' } : { ok: false, error: 'invalid_auth' });
    if (req.url === '/github/user') return good ? send(200, { login: 'octo' }) : send(401, { message: 'Bad credentials' });
    if (req.url === '/railway') return send(200, good ? { data: { me: { email: 'me@acme.com' } } } : { errors: [{ message: 'Not Authorized' }] });
    if (req.url === '/emb/v1/embeddings') {
      embeddingAuth.push(auth || '(none)');
      if (auth && !good) return send(401, { error: { message: 'bad key' } });
      return send(200, { data: [{ index: 0, embedding: Array(1024).fill(0.1) }] });
    }
    send(404, {});
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// A fake Google for the Drive steps: token endpoint + files.list.
const google = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/token') return res.end(JSON.stringify({ access_token: 'fake-access', expires_in: 3600, token_type: 'Bearer' }));
    if (req.url?.startsWith('/drive/files')) {
      return res.end(
        JSON.stringify({
          files: [
            { name: 'Handbook', mimeType: 'application/vnd.google-apps.folder', owners: [{ emailAddress: 'boss@acme.com' }] },
            { name: 'Plan', mimeType: 'application/vnd.google-apps.document', owners: [{ emailAddress: 'ann@gmail.com' }] },
            { name: 'Company policy (urgent)', mimeType: 'application/vnd.google-apps.document', owners: [{ emailAddress: 'mallory@evil.example' }] },
          ],
        }),
      );
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise<void>((r) => google.listen(0, '127.0.0.1', r));
after(() => google.close());
const gbase = `http://127.0.0.1:${(google.address() as AddressInfo).port}`;

/** Scripted terminal: answers are consumed in order, everything said is recorded. */
function scripted(answers: string[]) {
  const said: string[] = [];
  const next = (q: string) => {
    said.push(`? ${q}`);
    if (answers.length === 0) throw new Error(`no scripted answer left for: ${q}`);
    return answers.shift()!;
  };
  return {
    said,
    left: answers,
    io: {
      say: (line = '') => void said.push(line),
      ask: async (q: string, fallback = '') => next(q) || fallback,
      secret: async (q: string) => next(q),
    },
  };
}

test('selection: numbers or names, unknown entries ignored', () => {
  assert.deepEqual(parseSelection('1, 3'), ['drive', 'github']);
  assert.deepEqual(parseSelection('slack railway 9 nope slack'), ['slack', 'railway']);
  assert.deepEqual(parseSelection(''), []);
});

test('.env: existing lines are kept, a commented key is filled in place, new keys are appended, file is owner-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, '# my notes\nPORT=9000\n# SLACK_BOT_TOKEN=\nOLD=1\n');
  const written = updateEnvFile(path, { SLACK_BOT_TOKEN: 'xoxb-1', NEW_PATH: '/Users/me/My Keys/sa.json', OLD: undefined });
  const text = readFileSync(path, 'utf8');
  assert.deepEqual(written, ['SLACK_BOT_TOKEN', 'NEW_PATH']);
  assert.match(text, /^# my notes\nPORT=9000\nSLACK_BOT_TOKEN=xoxb-1\n# OLD=\n/);
  assert.match(text, /NEW_PATH='\/Users\/me\/My Keys\/sa\.json'\n$/);
  assert.deepEqual([...readEnvKeys(path)].sort(), ['NEW_PATH', 'PORT', 'SLACK_BOT_TOKEN']);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(formatEnvValue("it's #1"), '"it\'s #1"');
  // What was written is read back as it was given, whatever quoting it needed.
  updateEnvFile(path, { NOTE: "it's #1", PLAIN: 'abc' });
  const back = readEnvValues(path);
  assert.deepEqual([back.get('NEW_PATH'), back.get('NOTE'), back.get('PLAIN'), back.get('OLD')], ['/Users/me/My Keys/sa.json', "it's #1", 'abc', undefined]);
});

test('.env: whatever a value holds, it stays one variable and the line after it stays its own', async () => {
  const { parse } = await import('dotenv');
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-env-'));
  for (const value of ['ends with a backslash\\', 'C:\\keys\\', 'line one\rline two', 'line one\r\nline two', 'line one\nline two', "quote ' inside", 'both \' and "', 'hash # inside', 'a=b c=d']) {
    const path = join(dir, `${Math.random().toString(36).slice(2)}.env`);
    updateEnvFile(path, { FIRST: value, SECOND: 'kept' });
    const read = parse(readFileSync(path, 'utf8'));
    assert.deepEqual(Object.keys(read), ['FIRST', 'SECOND'], JSON.stringify(value));
    assert.equal(read.SECOND, 'kept', JSON.stringify(value));
  }
  // What cannot be written as one line is refused, and nothing is written.
  const path = join(dir, 'refused.env');
  for (const value of ['nul \0 inside', 'bell \x07', 'quote \' and backslash at the end\\', 'line\nbreak and backslash\\']) {
    assert.throws(() => updateEnvFile(path, { FIRST: value, SECOND: 'kept' }), /not saved|cannot be written/, JSON.stringify(value));
  }
  assert.ok(!existsSync(path));
});

test('checks: each one says what it found, or what to fix', async () => {
  assert.deepEqual(await checkSlack('good-bot', { apiBase: `${base}/slack` }), { team: 'Acme', user: 'kbot', kind: 'bot' });
  await assert.rejects(checkSlack('bad', { apiBase: `${base}/slack` }), /token was rejected/);
  assert.deepEqual(await checkGithub('good', { apiBase: `${base}/github` }), { login: 'octo' });
  await assert.rejects(checkGithub('bad', { apiBase: `${base}/github` }), /rejected/);
  assert.deepEqual(await checkRailway('good', { apiBase: `${base}/railway` }), { who: 'me@acme.com' });
  await assert.rejects(checkRailway('bad', { apiBase: `${base}/railway` }), /Not Authorized/);
  assert.deepEqual(await checkEmbedding({ baseUrl: `${base}/emb/v1`, model: 'bge-m3' }), { dim: 1024, model: 'bge-m3' });
  await assert.rejects(checkEmbedding({ baseUrl: `${base}/emb/v1`, apiKey: 'bad' }), /key was rejected/);
  await assert.rejects(checkEmbedding({ baseUrl: `${base}/nowhere` }), /404/);
});

test('wizard: a rejected token is retried, skipped services write nothing, the admin gets a key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-setup-'));
  writeFileSync(join(dir, '.env'), 'PORT=9000\n');
  const s = scripted(['', 
    'slack, github, railway', // which services
    'bad-token', // slack: rejected
    'good-bot', // slack: accepted
    '', // slack user token: skip
    'bad', // github: rejected
    '', // github: give up
    'good-railway', // railway
    'Boss@Acme.com', // admin email
  ]);
  const admins: string[] = [];
  const r = await runSetup(s.io, {
    dir,
    endpoints: { slack: `${base}/slack`, github: `${base}/github`, railway: `${base}/railway` },
    createAdmin: async (email) => (admins.push(email), { key: 'kmcp_test_key', existed: false }),
    canRunClient: false,
    exec: noTools,
    serveCommand: ['node', '/app/dist/server.js', 'serve', '--stdio'],
  });
  assert.deepEqual(r.connected, ['slack', 'railway']);
  assert.deepEqual(r.envWritten, ['SLACK_BOT_TOKEN', 'RAILWAY_TOKEN']);
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'PORT=9000\n\n# Added by `knowledge-mcp setup`\nSLACK_BOT_TOKEN=good-bot\nRAILWAY_TOKEN=good-railway\n');
  assert.deepEqual(admins, ['boss@acme.com']);
  assert.equal(s.left.length, 0);
  const text = s.said.join('\n');
  assert.match(text, /✗ Slack: the token was rejected/);
  assert.match(text, /✓ Acme as kbot/);
  assert.match(text, /kmcp_test_key/);
  // The entry names this folder, so Claude Code reads these settings whichever project it starts the server in.
  assert.ok(text.includes(`claude mcp add knowledge -e MCP_HOME=${dir} -- node /app/dist/server.js serve --stdio`), text);
  assert.ok(!text.includes('good-bot') && !text.includes('good-railway'), 'tokens are never printed back');
});

test('wizard: nothing picked saves nothing and says how to come back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-setup-'));
  const s = scripted(['', '']);
  const r = await runSetup(s.io, { dir, canRunClient: false, exec: noTools });
  assert.deepEqual(r, { envWritten: [], configWritten: false, connected: [], adminEmail: null });
  assert.match(s.said.join('\n'), /Nothing to save[\s\S]*Run `knowledge-mcp setup` again any time/);
});

/** A fake gcloud and gh. Records every call; `fail` makes one gcloud step fail with the given stderr. */
function fakeCli(o: { account?: string; fail?: { match: string; stderr: string }; saExists?: boolean; gh?: string } = {}) {
  const calls: string[] = [];
  const exec: Exec = (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (args[0] === '--version') return cmd === 'gcloud' || (cmd === 'gh' && o.gh) ? ok('1.0') : { status: 127, stdout: '', stderr: '' };
    if (cmd === 'gh' && line === 'gh auth token') return o.gh ? ok(`${o.gh}\n`) : { status: 1, stdout: '', stderr: 'not logged in' };
    if (cmd !== 'gcloud') return { status: 127, stdout: '', stderr: '' };
    if (o.fail && line.includes(o.fail.match)) return { status: 1, stdout: '', stderr: o.fail.stderr };
    if (line.startsWith('gcloud auth list')) return ok(o.account === undefined ? 'me@acme.com\n' : o.account);
    if (line.startsWith('gcloud projects list')) return ok(JSON.stringify([{ projectId: 'acme-prod', name: 'Acme' }, { projectId: 'acme-lab', name: 'acme-lab' }]));
    if (line.startsWith('gcloud config get-value project')) return ok('acme-lab\n');
    if (line.includes('service-accounts describe')) return o.saExists ? ok('x') : { status: 1, stdout: '', stderr: 'NOT_FOUND' };
    return ok();
  };
  return { exec, calls };
}

test('gcloud: the plan lists the exact commands, and the account gets no role', () => {
  const plan = { project: 'acme-lab', name: 'knowledge-mcp-drive', keyPath: '/tmp/k.json' };
  assert.equal(auto.serviceAccountEmail(plan), 'knowledge-mcp-drive@acme-lab.iam.gserviceaccount.com');
  const cmds = auto.serviceAccountCommands(plan).map((c) => c.join(' '));
  assert.equal(cmds.length, 3);
  assert.match(cmds[0], /^gcloud services enable drive\.googleapis\.com --project=acme-lab$/);
  assert.match(cmds[2], /keys create \/tmp\/k\.json --iam-account=knowledge-mcp-drive@acme-lab\.iam\.gserviceaccount\.com/);
  assert.ok(!cmds.some((c) => /add-iam-policy-binding|roles\//.test(c)), 'no role is granted');
});

test('gcloud: creates the account once, reuses an existing one, and explains a blocked key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-gc-'));
  const plan = { project: 'acme-lab', name: 'knowledge-mcp-drive', keyPath: join(dir, 'k.json') };
  const fresh = fakeCli();
  assert.deepEqual(await auto.createDriveServiceAccount(fresh.exec, plan), { email: 'knowledge-mcp-drive@acme-lab.iam.gserviceaccount.com', created: true });
  assert.ok(fresh.calls.some((c) => c.includes('service-accounts create knowledge-mcp-drive')));
  const again = fakeCli({ saExists: true });
  assert.equal((await auto.createDriveServiceAccount(again.exec, plan)).created, false);
  assert.ok(!again.calls.some((c) => c.includes('service-accounts create')));
  const blocked = fakeCli({ fail: { match: 'keys create', stderr: 'ERROR: (gcloud.iam.service-accounts.keys.create) FAILED_PRECONDITION: Key creation is not allowed on this service account.\n- constraints/iam.disableServiceAccountKeyCreation' } });
  await assert.rejects(() => auto.createDriveServiceAccount(blocked.exec, plan), /organization blocks service account keys/);
  const noBilling = fakeCli({ fail: { match: 'services enable', stderr: 'ERROR: Billing account for project is not found.' } });
  await assert.rejects(() => auto.createDriveServiceAccount(noBilling.exec, plan), /no billing account/);
  await assert.rejects(() => auto.createDriveServiceAccount(fresh.exec, { ...plan, name: 'Bad Name' }), /6-30 characters/);
  writeFileSync(plan.keyPath, '{}');
  await assert.rejects(() => auto.createDriveServiceAccount(fresh.exec, plan), /already exists/);
});

test('wizard + gcloud: shows the commands, creates nothing without a yes, and falls back to a key file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-setup-'));
  const cli = fakeCli();
  const s = scripted(['', 
    'drive', // which services
    '1', // create with gcloud
    '2', // project number → acme-lab
    'n', // do not create
    '', // key file path: skip
  ]);
  const r = await runSetup(s.io, { dir, canRunClient: false, exec: cli.exec, retryDelayMs: 0 });
  const text = s.said.join('\n');
  assert.match(text, /Signed in to Google Cloud as me@acme\.com/);
  assert.match(text, /2\. acme-lab  \[current\]/);
  assert.match(text, /gcloud iam service-accounts keys create .*drive-service-account\.json --iam-account=knowledge-mcp-drive@acme-lab/);
  assert.match(text, /gets no project role/);
  assert.ok(!cli.calls.some((c) => /services enable|service-accounts create|keys create/.test(c)), 'nothing was created');
  assert.deepEqual(r.connected, []);
  assert.equal(s.left.length, 0);
});

test('wizard + gcloud: a signed-out gcloud is explained, then the key file path is asked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-setup-'));
  const s = scripted(['', '1', '1', '', '']);
  await runSetup(s.io, { dir, canRunClient: false, exec: fakeCli({ account: '' }).exec, retryDelayMs: 0 });
  const text = s.said.join('\n');
  assert.match(text, /gcloud is not signed in[\s\S]*gcloud auth login/);
  assert.match(text, /Path to the key file/);
});

test('wizard + gh: the gh login is offered with a warning and only used after a yes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-setup-'));
  const s = scripted(['', 'github', 'y']);
  const r = await runSetup(s.io, { dir, canRunClient: false, exec: fakeCli({ gh: 'good-gh-token' }).exec, endpoints: { github: `${base}/github` } });
  assert.deepEqual(r.envWritten, ['GITHUB_PAT']);
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /GITHUB_PAT=good-gh-token/);
  const text = s.said.join('\n');
  assert.match(text, /can do everything your gh login can/);
  assert.ok(!text.includes('good-gh-token'));

  const s2 = scripted(['', 'github', 'n', '']);
  const r2 = await runSetup(s2.io, { dir: mkdtempSync(join(tmpdir(), 'kmcp-setup-')), canRunClient: false, exec: fakeCli({ gh: 'good-gh-token' }).exec, endpoints: { github: `${base}/github` } });
  assert.deepEqual(r2.envWritten, []);
});

function collect() {
  const lines: string[] = [];
  return { lines, out: (l: string) => void lines.push(l) };
}

test('setup check: verifies what is configured, reports what is not, exit code follows failures', async () => {
  const endpoints = { slack: `${base}/slack`, github: `${base}/github`, railway: `${base}/railway` };
  const ok = collect();
  // The OpenAI key is not sent to another embedding address (the fake refuses any key it was not given).
  const openai = { OPENAI_API_KEY: 'sk-given-for-openai-only' };
  assert.equal(await runSetupCommand(['check'], { dir: '/tmp', out: ok.out, endpoints, env: { ...openai, SLACK_BOT_TOKEN: 'good-bot', GITHUB_PAT: 'good', EMBEDDING_BASE_URL: `${base}/emb/v1`, EMBEDDING_MODEL: 'bge-m3', EMBEDDING_DIM: '1024' } }), 0, ok.lines.join('\n'));
  assert.match(ok.lines.join('\n'), /✓ slack\s+Acme as kbot[\s\S]*✓ github\s+signed in as octo/);
  assert.match(ok.lines.join('\n'), /✓ embeddings\s+bge-m3 \(1024 dimensions\)/);
  assert.match(ok.lines.join('\n'), /· drive\s+not configured/);
  const bad = collect();
  assert.equal(await runSetupCommand(['check'], { dir: '/tmp', out: bad.out, endpoints, env: { SLACK_BOT_TOKEN: 'expired', EMBEDDING_BASE_URL: `${base}/emb/v1`, EMBEDDING_MODEL: 'bge-m3', EMBEDDING_DIM: '768' } }), 1);
  assert.match(bad.lines.join('\n'), /✗ slack\s+Slack: the token was rejected/);
  assert.match(bad.lines.join('\n'), /returns 1024-dimension vectors but EMBEDDING_DIM is 768/);
  const none = collect();
  assert.equal(await runSetupCommand(['check'], { dir: '/tmp', out: none.out, env: {} }), 0);
  assert.match(none.lines.join('\n'), /Nothing is configured yet/);
});

test('setup drive --gcloud: prints the plan and creates nothing without --yes; says who must sign in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-cmd-'));
  const cli = fakeCli();
  const plan = collect();
  assert.equal(await runSetupCommand(['drive', '--gcloud', '--project', 'acme-prod'], { dir, out: plan.out, exec: cli.exec }), 2);
  assert.match(plan.lines.join('\n'), /Project: acme-prod[\s\S]*keys create[\s\S]*Nothing was created[\s\S]*--yes/);
  assert.ok(!cli.calls.some((c) => /services enable|keys create/.test(c)));
  const out = collect();
  assert.equal(await runSetupCommand(['drive', '--gcloud'], { dir, out: out.out, exec: fakeCli({ account: '' }).exec }), 1);
  assert.match(out.lines.join('\n'), /gcloud is not signed in[\s\S]*gcloud auth login/);
  const missing = collect();
  assert.equal(await runSetupCommand(['drive', '--gcloud'], { dir, out: missing.out, exec: noTools }), 1);
  assert.match(missing.lines.join('\n'), /gcloud CLI is not installed/);
});

test('setup drive --gcloud --yes: runs the three steps and saves the key path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-cmd-'));
  const cli = fakeCli();
  const o = collect();
  assert.equal(await runSetupCommand(['drive', '--gcloud', '--yes'], { dir, out: o.out, exec: cli.exec, retryDelayMs: 0 }), 0);
  const made = cli.calls.filter((c) => /services enable|service-accounts create|keys create/.test(c));
  assert.equal(made.length, 3);
  assert.ok(made.every((c) => c.includes('--project=acme-lab')), 'uses the project gcloud is set to');
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /GOOGLE_APPLICATION_CREDENTIALS=.*drive-service-account\.json/);
  assert.match(o.lines.join('\n'), /Created knowledge-mcp-drive@acme-lab\.iam\.gserviceaccount\.com[\s\S]*share a Drive folder or document with/);
});

test('setup github --from-gh and setup embeddings: saved only after the live check passes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-cmd-'));
  const o = collect();
  assert.equal(await runSetupCommand(['github', '--from-gh'], { dir, out: o.out, exec: fakeCli({ gh: 'good-gh' }).exec, endpoints: { github: `${base}/github` } }), 0, o.lines.join('\n'));
  assert.equal(await runSetupCommand(['embeddings', '--base-url', `${base}/emb/v1`, '--model', 'bge-m3'], { dir, out: o.out, env: {} }), 0);
  const env = readFileSync(join(dir, '.env'), 'utf8');
  assert.match(env, /GITHUB_PAT=good-gh\n/);
  assert.match(env, /EMBEDDING_MODEL=bge-m3\nEMBEDDING_DIM=1024\n/);
  assert.ok(!o.lines.join('\n').includes('good-gh'), 'the token is not printed');
  const dir2 = mkdtempSync(join(tmpdir(), 'kmcp-cmd-'));
  const bad = collect();
  assert.equal(await runSetupCommand(['github', '--from-gh'], { dir: dir2, out: bad.out, exec: fakeCli({ gh: 'expired' }).exec, endpoints: { github: `${base}/github` } }), 1);
  assert.equal(await runSetupCommand(['embeddings', '--base-url', `${base}/nowhere`, '--model', 'x'], { dir: dir2, out: bad.out, env: {} }), 1);
  assert.equal(await runSetupCommand(['nope'], { dir: dir2, out: bad.out }), 2);
  assert.throws(() => readFileSync(join(dir2, '.env'), 'utf8'), /ENOENT/);
});

// ── Drive in the wizard, against a fake Google: token endpoint + files.list ──
import { generateKeyPairSync } from 'node:crypto';
function fakeKeyFile(dir: string): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const path = join(dir, 'sa.json');
  writeFileSync(
    path,
    JSON.stringify({ type: 'service_account', client_email: 'kb@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${gbase}/token` }),
  );
  return path;
}

test('wizard + Drive: owners are listed and must be typed, a public mail domain is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-setup-'));
  const key = fakeKeyFile(dir);
  const s = scripted(['', 
    'drive',
    key, // key file path (no gcloud)
    'acme.com', // own domain: typed, nothing is guessed from what is shared
    'gmail.com, ann@gmail.com', // extra: a public mail domain is refused, the address is accepted
    '', // exclude folders
    '3', // search by meaning: not now
  ]);
  const r = await runSetup(s.io, { dir, canRunClient: false, exec: noTools, endpoints: { drive: `${gbase}/drive` } });
  const text = s.said.join('\n');
  assert.deepEqual(r.connected, ['drive']);
  assert.match(text, /signed in as kb@proj\.iam\.gserviceaccount\.com/);
  assert.match(text, /Anyone who knows this account's address can share a document with it/);
  assert.match(text, /Your organization's domain, or your own address \(Enter for none\):/);
  assert.match(text, /Also shared with this account by:[\s\S]*ann@gmail\.com — 1 item \(Plan\)[\s\S]*evil\.example — 1 item \(Company policy \(urgent\)\)/);
  assert.match(text, /"gmail\.com" is a public mail provider/);
  const cfg = JSON.parse(readFileSync(join(dir, 'mcp.config.json'), 'utf8'));
  assert.deepEqual(cfg.drive.trustedOwners, ['acme.com', 'ann@gmail.com']);
  assert.match(text, /1 shared item stays hidden \(owner not trusted\): Company policy \(urgent\)/);
});

test('wizard + Drive: pressing Enter everywhere never trusts a stranger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-setup-'));
  const s = scripted(['', 'drive', fakeKeyFile(dir), '', '', '', '3']);
  const r = await runSetup(s.io, { dir, canRunClient: false, exec: noTools, endpoints: { drive: `${gbase}/drive` } });
  assert.equal(r.configWritten, false);
  assert.match(s.said.join('\n'), /No owner is trusted, so shared documents stay hidden/);
});

test('setup trust and setup check: hidden items are counted with their owners, entries are validated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-cmd-'));
  const key = fakeKeyFile(dir);
  const env = { GOOGLE_APPLICATION_CREDENTIALS: key };
  const before = collect();
  assert.equal(await runSetupCommand(['check'], { dir, out: before.out, env, endpoints: { drive: `${gbase}/drive` } }), 0);
  assert.match(before.lines.join('\n'), /3 shared items, 3 hidden because the owner is not trusted \(boss@acme\.com, ann@gmail\.com, mallory@evil\.example\)/);
  assert.match(before.lines.join('\n'), /setup trust acme\.com ann@gmail\.com evil\.example/);

  const t = collect();
  assert.equal(await runSetupCommand(['trust', 'acme.com', 'Ann@Gmail.com'], { dir, out: t.out }), 0);
  assert.equal(await runSetupCommand(['trust', 'gmail.com'], { dir, out: t.out }), 1);
  assert.equal(await runSetupCommand(['trust'], { dir, out: t.out }), 1);
  assert.match(t.lines.join('\n'), /Now trusted: acme\.com, ann@gmail\.com[\s\S]*public mail provider/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'mcp.config.json'), 'utf8')).drive.trustedOwners, ['acme.com', 'ann@gmail.com']);

  const afterTrust = collect();
  await runSetupCommand(['check'], { dir, out: afterTrust.out, env, endpoints: { drive: `${gbase}/drive` } });
  assert.match(afterTrust.lines.join('\n'), /3 shared items, 1 hidden because the owner is not trusted \(mallory@evil\.example\)/);
});

// ── Local folders: the path that needs no account and no key ──
import { mkdirSync } from 'node:fs';
function docsFolder(): string {
  const d = mkdtempSync(join(tmpdir(), 'kmcp-folder-'));
  mkdirSync(join(d, 'sub'));
  mkdirSync(join(d, 'node_modules'));
  writeFileSync(join(d, 'a.md'), '# A');
  writeFileSync(join(d, 'sub', 'b.pdf'), 'x');
  writeFileSync(join(d, 'sub', 'c.png'), 'x'); // not a document
  writeFileSync(join(d, 'node_modules', 'd.md'), '# D'); // build folder
  return d;
}

test('wizard: a folder is asked first, counted, and saved; search by meaning is then offered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-setup-'));
  const folder = docsFolder();
  // a wrong path, then the folder (quoted, as dragging it into a terminal gives), no services, no model
  const s = scripted([join(folder, 'nope'), `'${folder}'`, '', '3']);
  const r = await runSetup(s.io, { dir, canRunClient: false, exec: noTools });
  const text = s.said.join('\n');
  assert.match(text, /nope is not a folder/);
  assert.match(text, /✓ .*: 2 documents to index/);
  assert.match(text, /Search by meaning \(optional\)[\s\S]*Search already works by keywords/);
  assert.deepEqual(r.connected, ['local folder']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'mcp.config.json'), 'utf8')).folders, [{ path: folder }]);
  assert.equal(r.envWritten.length, 0); // nothing secret was needed
});

test('setup folder: adds a folder once, validates it, and setup check reports it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-cmd-'));
  const folder = docsFolder();
  const o = collect();
  assert.equal(await runSetupCommand(['folder', folder, '--name', 'handbook', '--source', 'docs'], { dir, out: o.out }), 0);
  assert.equal(await runSetupCommand(['folder', folder], { dir, out: o.out }), 0); // again: no duplicate
  assert.equal(await runSetupCommand(['folder', join(folder, 'missing')], { dir, out: o.out }), 1);
  assert.equal(await runSetupCommand(['folder', folder, '--name', 'a/b'], { dir, out: o.out }), 1);
  assert.equal(await runSetupCommand(['folder'], { dir, out: o.out }), 1);
  assert.match(o.lines.join('\n'), /added: 2 documents[\s\S]*already listed[\s\S]*is not a folder/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'mcp.config.json'), 'utf8')).folders, [{ path: folder, name: 'handbook', source: 'docs' }]);

  const c = collect();
  assert.equal(await runSetupCommand(['check'], { dir, out: c.out, env: {} }), 0);
  assert.match(c.lines.join('\n'), /✓ folder\s+.* — 2 documents/);
  assert.match(c.lines.join('\n'), /search works by keywords/);
  writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ folders: [{ path: join(folder, 'gone') }] }));
  const bad = collect();
  assert.equal(await runSetupCommand(['check'], { dir, out: bad.out, env: {} }), 1);
  assert.match(bad.lines.join('\n'), /✗ folder\s+.*does not exist or is not a folder/);
});

test('wizard, a later run: a folder set up before is kept, and the model question is still asked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-setup-'));
  const folder = docsFolder();
  writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ folders: [{ path: folder }] }));
  const s = scripted(['', '', '3']); // keep the folder list, no services, no model
  const r = await runSetup(s.io, { dir, canRunClient: false, exec: noTools });
  const text = s.said.join('\n');
  assert.match(text, new RegExp(`Indexed now: ${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(text, /Search by meaning \(optional\)/);
  assert.equal(r.configWritten, false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'mcp.config.json'), 'utf8')).folders, [{ path: folder }]);
});

// ── Databases and APIs: connections for tools declared in the config ──
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync as statFile } from 'node:fs';
function shopDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'kmcp-db-'));
  const path = join(d, 'shop.db');
  const db = new DatabaseSync(path);
  db.exec("create table orders (id integer primary key, total real); insert into orders values (1, 10), (2, 20); create table customers (id integer primary key, email text)");
  db.close();
  return path;
}

test('setup connection: writes the connection, names the env var, and never takes a secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-cmd-'));
  const db = shopDb();
  const o = collect();
  const run = (...argv: string[]) => runSetupCommand(['connection', ...argv], { dir, out: o.out, env: {} });
  const config = () => JSON.parse(readFileSync(join(dir, 'mcp.config.json'), 'utf8'));

  assert.equal(await run('shop', '--postgres', '--env', 'SHOP_DATABASE_URL', '--description', 'Orders'), 0);
  assert.deepEqual(config().connections.shop, { type: 'postgres', urlEnv: 'SHOP_DATABASE_URL', description: 'Orders' });
  assert.match(o.lines.join('\n'), /SHOP_DATABASE_URL is not set\. The person who owns it types it into \.env, unseen, with: knowledge-mcp setup secret SHOP_DATABASE_URL/);
  assert.match(o.lines.join('\n'), /No tools yet\. Declare them under "tools"/);

  assert.equal(await run('books', '--sqlite', db, '--explore'), 0);
  assert.deepEqual(config().connections.books, { type: 'sqlite', path: db, explore: true });
  assert.match(o.lines.join('\n'), /explore is on: the assistant can run any read-only query through books_query/);

  assert.equal(await run('crm', '--http', 'https://crm.example.com/api', '--header', 'Authorization: Bearer ${CRM_TOKEN}', '--header', 'Accept: application/json', '--query', 'tenant=acme'), 0);
  assert.deepEqual(config().connections.crm, {
    type: 'http',
    baseUrl: 'https://crm.example.com/api',
    headers: { Authorization: 'Bearer ${CRM_TOKEN}', Accept: 'application/json' },
    query: { tenant: 'acme' },
  });
  assert.match(o.lines.join('\n'), /CRM_TOKEN is not set/);

  o.lines.length = 0;
  for (const [argv, re] of [
    [['crm', '--http', 'https://crm.example.com', '--header', 'Authorization: Bearer abc123'], /looks like a secret\. Write its value as \$\{ENV_NAME\}/],
    [['crm', '--http', 'https://crm.example.com', '--query', 'api_key=abc123'], /looks like a secret/],
    [['crm', '--http', 'https://user:pw@crm.example.com'], /must not hold a user name or password/],
    [['pg', '--postgres'], /--postgres needs --env NAME/],
    [['pg', '--postgres', '--env', 'postgres://user:pw@host/db'], /urlEnv|Invalid/i], // a URL is not an env var name
    [['drive', '--sqlite', db], /name of a built-in plugin/],
    [['x', '--sqlite', db, '--http', 'https://a.example'], /choose one of/],
    [['x', '--sqlite', join(dir, 'nope.db')], /does not exist/],
    [['x', '--http', 'https://a.example', '--explore'], /--explore is for databases/],
    [['Bad_Name', '--sqlite', db], /Invalid|connections/i],
    [[], /needs one name/],
  ] as const) {
    assert.equal(await run(...argv), 1, argv.join(' '));
    assert.match(o.lines[o.lines.length - 1], re, argv.join(' '));
  }
  assert.deepEqual(Object.keys(config().connections), ['shop', 'books', 'crm']); // the refused ones changed nothing
  assert.ok(!readFileSync(join(dir, 'mcp.config.json'), 'utf8').includes('abc123'));
});

test('setup secret: the value is typed unseen into .env, never passed as an argument', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-cmd-'));
  const o = collect();
  const asked: string[] = [];
  const readSecret = async (q: string) => (asked.push(q), ' postgres://app:p@ss w0rd@db.example.com:5432/shop ');
  assert.equal(await runSetupCommand(['secret', 'SHOP_DATABASE_URL'], { dir, out: o.out, readSecret }), 0);
  assert.deepEqual(asked, ['Value for SHOP_DATABASE_URL (not shown):']);
  const envText = readFileSync(join(dir, '.env'), 'utf8');
  assert.match(envText, /^SHOP_DATABASE_URL='postgres:\/\/app:p@ss w0rd@db\.example\.com:5432\/shop'$/m);
  assert.equal(statFile(join(dir, '.env')).mode & 0o777, 0o600);
  assert.ok(!o.lines.join('\n').includes('w0rd')); // the value is not echoed

  assert.equal(await runSetupCommand(['secret', 'EMPTY'], { dir, out: o.out, readSecret: async () => '  ' }), 1);
  assert.ok(!readFileSync(join(dir, '.env'), 'utf8').includes('EMPTY'));
  assert.equal(await runSetupCommand(['secret', 'bad name'], { dir, out: o.out, readSecret }), 1);
  assert.equal(await runSetupCommand(['secret'], { dir, out: o.out, readSecret }), 1);
  // No terminal (an agent's shell): the command says who has to run it instead of reading from a pipe.
  assert.equal(await runSetupCommand(['secret', 'X_TOKEN'], { dir, out: o.out }), 1);
  assert.match(o.lines[o.lines.length - 1], /needs a terminal\. The person who owns the secret runs it themselves: knowledge-mcp setup secret X_TOKEN/);
});

test('setup check: each connection is reached and each declared query is compiled; a broken config is listed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-cmd-'));
  const db = shopDb();
  const write = (tools: unknown[]) =>
    writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ connections: { shop: { type: 'sqlite', path: db, explore: true }, pg: { type: 'postgres', urlEnv: 'NOT_SET_DATABASE_URL' } }, tools }));

  write([
    { name: 'big_orders', connection: 'shop', description: 'Orders over an amount', params: { min: { type: 'number' } }, sql: 'select id, total from orders where total >= :min' },
    { name: 'typo', connection: 'shop', description: 'A misspelled column', sql: 'select totl from orders' },
  ]);
  const a = collect();
  assert.equal(await runSetupCommand(['check'], { dir, out: a.out, env: {} }), 1);
  const text = a.lines.join('\n');
  assert.match(text, /^✓ shop\s+SQLite \d+\.\d+\.\d+, 2 tables readable, explore on \(any read-only query\)$/m);
  assert.match(text, /^✓ shop › big_orders\s+the query compiles$/m);
  assert.match(text, /^✗ shop › typo\s+the database answered: no such column: totl$/m);
  assert.match(text, /^✗ pg\s+set NOT_SET_DATABASE_URL in \.env \(the postgres connection reads it\)$/m);

  write([{ name: 'big_orders', connection: 'shop', description: 'd', params: { min: { type: 'number' } }, sql: 'select id from orders where total >= :mni; select 2' }]);
  const b = collect();
  assert.equal(await runSetupCommand(['check'], { dir, out: b.out, env: {} }), 1);
  assert.match(b.lines.join('\n'), /^✗ config\s+tool "big_orders": only one statement can be run/m);
  assert.match(b.lines.join('\n'), /The server does not start until mcp\.config\.json is fixed/);
});

test('wizard: a database is connected, checked, and explore is off unless asked for', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-setup-'));
  const db = shopDb();
  // no folder, pick the database, SQLite, a taken name then a good one, a wrong path then the file, explore: Enter (no)
  const s = scripted(['', 'database', '2', 'drive', 'shop', join(dir, 'nope.db'), db, '']);
  const r = await runSetup(s.io, { dir, canRunClient: false, exec: noTools });
  const text = s.said.join('\n');
  assert.match(text, /5\. Database\s+Postgres or a SQLite file/);
  assert.match(text, /"drive" is already used/);
  assert.match(text, /✗ the database file of "shop" does not exist/);
  assert.match(text, /✓ SQLite \d+\.\d+\.\d+, 2 tables/);
  assert.match(text, /It reads whatever this database user can read/);
  assert.match(text, /Saved without tools\. Declare them under "tools"/);
  assert.deepEqual(r.connected, ['database']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'mcp.config.json'), 'utf8')).connections, { shop: { type: 'sqlite', path: db } });

  // A second run adds another one with explore on; a Postgres URL that does not answer is not saved.
  const again = scripted(['', '5', '1', 'pg', 'mysql://nope', 'postgres://app:hunter2-secret@127.0.0.1:1/app', '', '', '5', '2', 'books', db, 'y']);
  const first = await runSetup({ ...again.io }, { dir, canRunClient: false, exec: noTools });
  assert.match(again.said.join('\n'), /starts with postgres:\/\//);
  assert.match(again.said.join('\n'), /cannot connect to the database of "pg"/);
  assert.ok(!again.said.join('\n').includes('hunter2-secret'));
  assert.deepEqual(first.connected, []);
  const second = await runSetup({ ...again.io }, { dir, canRunClient: false, exec: noTools });
  assert.deepEqual(second.connected, ['database']);
  const saved = JSON.parse(readFileSync(join(dir, 'mcp.config.json'), 'utf8')).connections;
  assert.deepEqual(saved, { shop: { type: 'sqlite', path: db }, books: { type: 'sqlite', path: db, explore: true } });
  assert.ok(!existsSync(join(dir, '.env')) || !readFileSync(join(dir, '.env'), 'utf8').includes('DATABASE_URL'));
});

// ── The embedding key goes only to the address it was given for (as in the console) ──

test('setup embeddings: a saved key is not sent to, or kept for, a new address; --api-key types one unseen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-emb-'));
  const voyage = { EMBEDDING_BASE_URL: 'https://api.voyage.example/v1', EMBEDDING_API_KEY: 'key-given-for-voyage' };
  writeFileSync(join(dir, '.env'), 'EMBEDDING_BASE_URL=https://api.voyage.example/v1\nEMBEDDING_API_KEY=key-given-for-voyage\nEMBEDDING_MODEL=voyage-3\n');
  // As the CLI runs: the .env of the folder is loaded into the environment too.
  const moved = collect();
  embeddingAuth.length = 0;
  assert.equal(await runSetupCommand(['embeddings', '--base-url', `${base}/emb/v1/`, '--model', 'bge-m3'], { dir, out: moved.out, env: voyage }), 0, moved.lines.join('\n'));
  assert.deepEqual(embeddingAuth, ['(none)'], 'the check sends no key to the new address');
  const after = readEnvValues(join(dir, '.env'));
  assert.deepEqual([after.get('EMBEDDING_BASE_URL'), after.has('EMBEDDING_API_KEY')], [`${base}/emb/v1`, false]);
  assert.match(moved.lines.join('\n'), /The key saved for the previous address was removed[\s\S]*--api-key/);

  // At the address it was saved for, the saved key is used for the check and stays.
  updateEnvFile(join(dir, '.env'), { EMBEDDING_API_KEY: 'good-local' });
  embeddingAuth.length = 0;
  assert.equal(await runSetupCommand(['embeddings', '--base-url', `${base}/emb/v1`, '--model', 'bge-m3'], { dir, out: collect().out, env: {} }), 0);
  assert.deepEqual([embeddingAuth, readEnvValues(join(dir, '.env')).get('EMBEDDING_API_KEY')], [['Bearer good-local'], 'good-local']);

  // A key for the new address is typed unseen (never an argument), checked, and saved.
  const typed = collect();
  embeddingAuth.length = 0;
  const asked: string[] = [];
  const readSecret = async (q: string) => (asked.push(q), 'good-typed');
  assert.equal(await runSetupCommand(['embeddings', '--base-url', `${base}/emb/v1`, '--model', 'bge-m3', '--api-key'], { dir, out: typed.out, env: {}, readSecret }), 0);
  assert.deepEqual([embeddingAuth, readEnvValues(join(dir, '.env')).get('EMBEDDING_API_KEY')], [['Bearer good-typed'], 'good-typed']);
  assert.match(asked[0], /API key for .* \(not shown\)/);
  assert.match(typed.lines.join('\n'), /EMBEDDING_API_KEY\./);
  assert.ok(!typed.lines.join('\n').includes('good-typed'), 'the key is not printed');
  const noTerminal = collect();
  assert.equal(await runSetupCommand(['embeddings', '--base-url', `${base}/emb/v1`, '--model', 'bge-m3', '--api-key'], { dir, out: noTerminal.out, env: {} }), 1);
  assert.match(noTerminal.lines.join('\n'), /needs a terminal/);
});

test('wizard, search by meaning: a saved key stays with its address, and choosing OpenAI drops another provider\'s key', async () => {
  // The wizard reads the environment as the server does; a key set in the shell that runs the tests is not part of this.
  for (const k of Object.keys(process.env)) if (/^(EMBEDDING_|OPENAI_)/.test(k)) delete process.env[k];
  const folder = docsFolder();
  const wizard = async (env: string, answers: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'kmcp-setup-'));
    writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ folders: [{ path: folder }] }));
    writeFileSync(join(dir, '.env'), env);
    const s = scripted(['', '', ...answers]); // keep the folder list, no services, then the model
    embeddingAuth.length = 0;
    await runSetup(s.io, { dir, canRunClient: false, exec: noTools, endpoints: { openai: `${base}/emb/v1` } });
    assert.equal(s.left.length, 0);
    return { saved: readEnvValues(join(dir, '.env')), said: s.said.join('\n'), sent: [...embeddingAuth] };
  };
  const voyage = 'EMBEDDING_BASE_URL=https://api.voyage.example/v1\nEMBEDDING_API_KEY=key-given-for-voyage\nEMBEDDING_MODEL=voyage-3\n';

  // Another endpoint, no key typed: the voyage key is neither sent there nor kept for it.
  const moved = await wizard(voyage, ['2', `${base}/emb/v1`, 'bge-m3', '']);
  assert.deepEqual([moved.sent, moved.saved.get('EMBEDDING_BASE_URL'), moved.saved.has('EMBEDDING_API_KEY')], [['(none)'], `${base}/emb/v1`, false]);
  assert.match(moved.said, /API key \(Enter if the server needs none\)/);
  // The same endpoint again: Enter keeps the saved key, which is what the check sends.
  const same = await wizard(`EMBEDDING_BASE_URL=${base}/emb/v1\nEMBEDDING_API_KEY=good-saved\n`, ['2', `${base}/emb/v1`, 'bge-m3', '']);
  assert.deepEqual([same.sent, same.saved.get('EMBEDDING_API_KEY')], [['Bearer good-saved'], 'good-saved']);
  assert.match(same.said, /API key \(Enter keeps the saved one\)/);
  // OpenAI: the key typed for it is the one the server will send, so another provider's key goes.
  const openai = await wizard(voyage, ['1', 'good-openai']);
  assert.deepEqual([openai.sent, openai.saved.get('OPENAI_API_KEY'), openai.saved.has('EMBEDDING_API_KEY'), openai.saved.has('EMBEDDING_BASE_URL')], [['Bearer good-openai'], 'good-openai', false, false]);
});
