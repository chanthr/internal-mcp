/**
 * Drive REST client against a fake Google: service-account JWT grant (signature, iss, aud, scope),
 * refresh-token grant, query parameters, media download, export, changes, retry on 429 and 403 rate limits, token refresh on 401.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { jwtVerify, importSPKI } from 'jose';
import { createDriveClient, resolveCredentials, DriveApiError } from '../src/plugins/drive/client.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const calls: Array<{ path: string; query: URLSearchParams; auth?: string }> = [];
let tokensIssued = 0;
let fail429Once = true;
let reject401Once = true;
let rateLimit403Once = true;

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  if (url.pathname === '/token') {
    const form = new URLSearchParams(await body(req));
    if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
      const { payload } = await jwtVerify(form.get('assertion')!, await importSPKI(pubPem, 'RS256'), {
        issuer: 'sa@test.iam.gserviceaccount.com',
        audience: `${base}/token`,
      });
      assert.equal(payload.scope, 'https://www.googleapis.com/auth/drive.readonly');
    } else if (form.get('grant_type') === 'refresh_token') {
      if (form.get('refresh_token') !== 'rt-1') {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
    }
    tokensIssued++;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: `tok-${tokensIssued}`, expires_in: 3600 }));
    return;
  }
  calls.push({ path: url.pathname, query: url.searchParams, auth: req.headers.authorization });
  const json = (status: number, v: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));
  if (url.pathname === '/drive/v3/files') {
    if (fail429Once) {
      fail429Once = false;
      return json(429, { error: { message: 'rate limited' } });
    }
    return json(200, { files: [{ id: 'f1', name: 'a.md' }], nextPageToken: 'p2' });
  }
  if (url.pathname === '/drive/v3/files/f%201') {
    if (url.searchParams.get('alt') === 'media') return res.writeHead(200).end(Buffer.from([0, 1, 2, 255]));
    return json(200, { name: 'f 1', parents: ['root'] });
  }
  if (url.pathname === '/drive/v3/files/doc1/export') return res.writeHead(200).end('# exported');
  if (url.pathname === '/drive/v3/files/gone') return json(404, { error: { code: 404, message: 'File not found: gone.' } });
  if (url.pathname === '/drive/v3/files/busy') {
    if (rateLimit403Once) {
      rateLimit403Once = false;
      return json(403, { error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } });
    }
    return json(200, { name: 'busy' });
  }
  if (url.pathname === '/drive/v3/files/denied') {
    return json(403, { error: { code: 403, message: 'The user does not have sufficient permissions.', errors: [{ reason: 'insufficientFilePermissions' }] } });
  }
  if (url.pathname === '/drive/v3/changes/startPageToken') {
    if (reject401Once) {
      reject401Once = false;
      return json(401, { error: { message: 'expired' } });
    }
    return json(200, { startPageToken: '42' });
  }
  if (url.pathname === '/drive/v3/changes') return json(200, { changes: [{ fileId: 'f1', removed: true }], newStartPageToken: '43' });
  json(404, { error: { message: 'no route' } });
});
server.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const saCreds = resolveCredentials({
  GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify({
    type: 'service_account',
    client_email: 'sa@test.iam.gserviceaccount.com',
    private_key: privPem,
    token_uri: `${base}/token`,
  }),
});

test('service account: signed JWT grant, query params, retry on 429', async () => {
  const drive = createDriveClient(saCreds, `${base}/drive/v3`);
  const { data } = await drive.files.list({ q: "name contains 'a' and trashed = false", fields: 'files(id,name)', pageSize: 5, supportsAllDrives: true });
  assert.deepEqual(data.files, [{ id: 'f1', name: 'a.md' }]);
  const last = calls.at(-1)!;
  assert.equal(last.query.get('q'), "name contains 'a' and trashed = false");
  assert.equal(last.query.get('pageSize'), '5');
  assert.equal(last.query.get('supportsAllDrives'), 'true');
  assert.equal(last.auth, 'Bearer tok-1');
  assert.equal(calls.filter((c) => c.path === '/drive/v3/files').length, 2); // 429 then success
});

test('metadata, media as bytes, export as text, ids are URL-encoded, token is reused', async () => {
  const drive = createDriveClient(saCreds, `${base}/drive/v3`);
  const before = tokensIssued;
  assert.deepEqual((await drive.files.get({ fileId: 'f 1', fields: 'name,parents' })).data, { name: 'f 1', parents: ['root'] });
  const media = await drive.files.get({ fileId: 'f 1', alt: 'media' }, { responseType: 'arraybuffer' });
  assert.deepEqual([...new Uint8Array(media.data as ArrayBuffer)], [0, 1, 2, 255]);
  assert.equal((await drive.files.export({ fileId: 'doc1', mimeType: 'text/markdown' }, { responseType: 'text' })).data, '# exported');
  assert.equal(calls.at(-1)!.query.get('mimeType'), 'text/markdown');
  assert.equal(tokensIssued, before + 1); // one token for this client, reused for three calls
});

test('errors carry the HTTP status and Google message', async () => {
  const drive = createDriveClient(saCreds, `${base}/drive/v3`);
  await assert.rejects(drive.files.get({ fileId: 'gone' }), (e: unknown) => {
    assert.ok(e instanceof DriveApiError);
    assert.equal(e.code, 404);
    assert.match(e.message, /File not found: gone\./);
    return true;
  });
});

test('403 rate limit is retried, 403 permission denied is not', async () => {
  const drive = createDriveClient(saCreds, `${base}/drive/v3`);
  assert.deepEqual((await drive.files.get({ fileId: 'busy' })).data, { name: 'busy' });
  assert.equal(calls.filter((c) => c.path === '/drive/v3/files/busy').length, 2);
  await assert.rejects(drive.files.get({ fileId: 'denied' }), (e: unknown) => e instanceof DriveApiError && e.code === 403);
  assert.equal(calls.filter((c) => c.path === '/drive/v3/files/denied').length, 1);
});

test('refresh token: 401 triggers one new token, changes endpoints work', async () => {
  const creds = resolveCredentials({ GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'sec', GOOGLE_OAUTH_REFRESH_TOKEN: 'rt-1' });
  assert.equal(creds.kind, 'refresh_token');
  const drive = createDriveClient({ ...creds, tokenUri: `${base}/token` }, `${base}/drive/v3`);
  const before = tokensIssued;
  assert.equal((await drive.changes.getStartPageToken({ supportsAllDrives: true })).data.startPageToken, '42');
  assert.equal(tokensIssued, before + 2); // first token rejected with 401, second accepted
  const { data } = await drive.changes.list({ pageToken: '42', includeRemoved: true });
  assert.equal(data.newStartPageToken, '43');
  const bad = createDriveClient({ ...creds, refreshToken: 'wrong', tokenUri: `${base}/token` }, `${base}/drive/v3`);
  await assert.rejects(bad.files.list({}), /token request failed 400: invalid_grant/);
});

test('credentials: clear errors for missing or malformed settings', () => {
  assert.throws(() => resolveCredentials({}), /Drive credentials missing/);
  assert.throws(() => resolveCredentials({ GOOGLE_SERVICE_ACCOUNT_KEY: '{nope' }), /not valid JSON/);
  assert.throws(() => resolveCredentials({ GOOGLE_SERVICE_ACCOUNT_KEY: '{"type":"service_account"}' }), /service account key/);
  const user = resolveCredentials({ GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify({ type: 'authorized_user', client_id: 'a', client_secret: 'b', refresh_token: 'c' }) });
  assert.equal(user.kind, 'refresh_token');
});
