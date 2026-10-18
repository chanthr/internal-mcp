/** SQLite store: keys, users, OAuth refresh rotation, plugin state, Slack map, file permissions. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kmcp-store-'));
const { SqliteStore } = await import('../src/store/sqlite.js');
const { hashKey, parseExpiry, toRole } = await import('../src/store/keys.js');
const store = await SqliteStore.open(join(dir, 'sub', 'knowledge-mcp.db'));

test('the database file is private to the owner', () => {
  if (process.platform === 'win32') return;
  assert.equal(statSync(join(dir, 'sub')).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'sub', 'knowledge-mcp.db')).mode & 0o777, 0o600);
});

test('keys: create, validate, revoke, expire', async () => {
  const { id, key } = await store.createKey({ email: 'A@X.com', orgId: 'acme', label: 'laptop' });
  assert.match(key, /^kmcp_[A-Za-z0-9_-]{43}$/);
  const ok = await store.validateKey(key);
  assert.deepEqual(ok, { ok: true, keyId: id, orgId: 'acme', role: 'member', email: 'a@x.com' });
  assert.deepEqual(await store.validateKey(key + 'x'), { ok: false, reason: 'key not found' });
  const listed = await store.listKeys();
  assert.equal(listed.length, 1);
  assert.equal(JSON.stringify(listed).includes(key), false); // never the key itself
  assert.equal(await store.revokeKey(id), true);
  assert.equal(await store.revokeKey(id), false);
  assert.deepEqual(await store.validateKey(key), { ok: false, reason: 'key inactive' });

  const old = await store.createKey({ orgId: 'acme', role: 'admin', expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.deepEqual(await store.validateKey(old.key), { ok: false, reason: 'key expired' });
});

test('key hash matches the Postgres expression used by validate_mcp_key', () => {
  // encode(sha256(convert_to('abc','UTF8')),'hex')
  assert.equal(hashKey('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('roles: engineer (pre-0.3) reads as member, unknown as viewer', () => {
  assert.equal(toRole('engineer'), 'member');
  assert.equal(toRole('admin'), 'admin');
  assert.equal(toRole('whatever'), 'viewer');
  assert.ok(Date.parse(parseExpiry('90d')) > Date.now() + 89 * 86_400_000);
  assert.throws(() => parseExpiry('soon'), /invalid expiry/);
});

test('users: upsert keeps arrays, remove deletes', async () => {
  await store.upsertUser({ email: 'M@X.com', role: 'member', allowedTools: ['drive', 'notes'], allowedSlackChannels: [] });
  const u = await store.getUser('m@x.com');
  assert.deepEqual(u?.allowedTools, ['drive', 'notes']);
  assert.equal(u?.allowedSlackChannels, null); // empty = no limit, stored as null
  await store.upsertUser({ email: 'm@x.com', role: 'admin' });
  assert.equal((await store.getUser('m@x.com'))?.role, 'admin');
  assert.equal((await store.listUsers()).length, 1);
  assert.equal(await store.removeUser('m@x.com'), true);
  assert.equal(await store.getUser('m@x.com'), null);
});

test('refresh tokens: one rotation wins, reuse is detected', async () => {
  const exp = new Date(Date.now() + 60_000).toISOString();
  await store.recordRefreshToken('j1', 'a@x.com', 'c1', exp);
  assert.equal(await store.consumeRefreshToken('j1', 'j2'), 'ok');
  assert.equal(await store.consumeRefreshToken('j1', 'j3'), 'revoked');
  assert.equal(await store.consumeRefreshToken('nope', 'j4'), 'unknown');
  await store.recordRefreshToken('j5', 'a@x.com', 'c1', new Date(Date.now() - 1000).toISOString());
  assert.equal(await store.consumeRefreshToken('j5', 'j6'), 'revoked'); // expired rows are not consumable
  await store.purgeExpiredRefreshTokens();
  assert.equal(await store.consumeRefreshToken('j5', 'j6'), 'unknown');
});

test('oauth clients round-trip', async () => {
  const client = { client_id: 'c1', client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] } as never;
  await store.saveOAuthClient(client);
  assert.deepEqual(await store.getOAuthClient('c1'), client);
  assert.equal(await store.getOAuthClient('c2'), null);
});

test('plugin state is namespaced', async () => {
  await store.setState('a', 'k', { v: 1 });
  await store.setState('b', 'k', 'other');
  assert.deepEqual(await store.getState('a', 'k'), { v: 1 });
  assert.equal(await store.getState('b', 'k'), 'other');
  await store.deleteState('a', 'k');
  assert.equal(await store.getState('a', 'k'), null);
});

test('slack map: insert ignores duplicates, update only touches known columns', async () => {
  const row = { channel_name: 'dev', channel_id: 'C1', purpose: '', category: null, enabled: false, sort_order: 100 };
  await store.insertSlackChannels([row, row]);
  const [r] = await store.listSlackChannels();
  assert.equal((await store.listSlackChannels()).length, 1);
  await store.updateSlackChannel(r!.id, { purpose: 'deploys', enabled: true, ...({ 'id = id; drop table app_users; --': 1 } as object) });
  const [u] = await store.listSlackChannels();
  assert.equal(u!.purpose, 'deploys');
  assert.equal(u!.enabled, true);
  assert.equal(Array.isArray(await store.listUsers()), true); // table still there
});

test('tool-call log never throws', async () => {
  await store.logToolCall({ tool: 't', email: null, role: null, ok: false, error: 'x'.repeat(5000), durationMs: 1 });
});
