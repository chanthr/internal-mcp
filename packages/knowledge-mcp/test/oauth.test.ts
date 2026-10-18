/**
 * OAuth consent → Google round trip is bound to the browser that approved (login cookie), so a forwarded
 * Google sign-in link cannot deliver a code to the approver's redirect_uri. Also: Google cancel goes back
 * to the client as access_denied. No network: the tests stop before the Google token exchange.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  MCP_OAUTH_ISSUER: 'https://mcp.example.com',
  OAUTH_GOOGLE_CLIENT_ID: 'gid.apps.googleusercontent.com',
  OAUTH_GOOGLE_CLIENT_SECRET: 'gsecret',
  OAUTH_JWT_SECRET: 'x'.repeat(40),
  OAUTH_ALLOWED_EMAILS: 'a@example.com',
  MCP_STORE: 'sqlite',
});
const { oauthProvider, isOAuthConfigured } = await import('../src/core/oauth.js');

type Captured = { headers: Record<string, string | string[]>; body: string };
function fakeRes(): { res: never; out: Captured } {
  const out: Captured = { headers: {}, body: '' };
  const res = {
    setHeader: (k: string, v: string | string[]) => void (out.headers[k.toLowerCase()] = v),
    status: () => res,
    type: () => res,
    send: (b: string) => void (out.body = b),
  };
  return { res: res as never, out };
}

const client = { client_id: 'c1', client_name: 'Evil App', redirect_uris: ['https://evil.example/cb'] } as never;

async function approve() {
  const { res, out } = fakeRes();
  await oauthProvider.authorize(client, { redirectUri: 'https://evil.example/cb', codeChallenge: 'ch', state: 'client-state', scopes: ['mcp'] } as never, res);
  const csrf = /kmcp_consent=([^;]+)/.exec(String(out.headers['set-cookie']))![1]!;
  const id = /name="id" value="([^"]+)"/.exec(out.body)![1]!;
  const r = oauthProvider.consumeConsent(id, csrf, csrf, true);
  const state = new URL(r.redirect).searchParams.get('state')!;
  return { ...r, state };
}

test('OAuth is configured from env', () => {
  assert.equal(isOAuthConfigured(), true);
});

test('approval returns a login binding for the approving browser', async () => {
  const r = await approve();
  assert.ok(r.loginBinding && r.loginBinding.length >= 20);
  assert.match(r.redirect, /^https:\/\/accounts\.google\.com\//);
});

test('a forwarded Google link (no or wrong binding cookie) is refused and the state is burned', async () => {
  const r = await approve();
  await assert.rejects(oauthProvider.completeGoogleLogin({ code: 'g', state: r.state, binding: '' }), /different browser/);
  // the attacker's own browser can no longer use that state either
  await assert.rejects(oauthProvider.completeGoogleLogin({ code: 'g', state: r.state, binding: r.loginBinding! }), /Unknown or expired/);
  const r2 = await approve();
  await assert.rejects(oauthProvider.completeGoogleLogin({ code: 'g', state: r2.state, binding: 'not-the-cookie' }), /different browser/);
});

test('Google cancel returns access_denied to the client instead of hanging', async () => {
  const r = await approve();
  const url = new URL(await oauthProvider.completeGoogleLogin({ error: 'access_denied', state: r.state, binding: r.loginBinding! }));
  assert.equal(url.origin + url.pathname, 'https://evil.example/cb');
  assert.equal(url.searchParams.get('error'), 'access_denied');
  assert.equal(url.searchParams.get('state'), 'client-state');
  assert.equal(url.searchParams.get('code'), null);
});

test('consent POST without the consent cookie is refused', async () => {
  const { res, out } = fakeRes();
  await oauthProvider.authorize(client, { redirectUri: 'https://evil.example/cb', codeChallenge: 'ch', scopes: ['mcp'] } as never, res);
  const csrf = /kmcp_consent=([^;]+)/.exec(String(out.headers['set-cookie']))![1]!;
  const id = /name="id" value="([^"]+)"/.exec(out.body)![1]!;
  assert.throws(() => oauthProvider.consumeConsent(id, csrf, '', true), /Could not verify/);
});
