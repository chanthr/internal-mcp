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
const { updateEnvFile, readEnvKeys, formatEnvValue } = await import('../src/setup/envfile.js');
const { checkEmbedding, checkSlack, checkGithub, checkRailway } = await import('../src/setup/checks.js');

// One fake for Slack, GitHub, Railway and an embedding endpoint. "good-*" tokens pass.
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
      if (auth && !good) return send(401, { error: { message: 'bad key' } });
      return send(200, { data: [{ index: 0, embedding: Array(1024).fill(0.1) }] });
    }
    send(404, {});
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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
  const s = scripted([
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
  assert.match(text, /claude mcp add knowledge -- node \/app\/dist\/server\.js serve --stdio/);
  assert.ok(!text.includes('good-bot') && !text.includes('good-railway'), 'tokens are never printed back');
});

test('wizard: nothing picked saves nothing and says how to come back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-setup-'));
  const s = scripted(['']);
  const r = await runSetup(s.io, { dir, canRunClient: false });
  assert.deepEqual(r, { envWritten: [], configWritten: false, connected: [], adminEmail: null });
  assert.match(s.said.join('\n'), /Nothing to save[\s\S]*Run `knowledge-mcp setup` again any time/);
});
