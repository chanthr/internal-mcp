/**
 * A public address through a Cloudflare Tunnel, set up from the console. cloudflared is a script here: it writes
 * down what it was started with and says what the real one says, so no tunnel is made and no account is touched.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|LLM_|EMBEDDING_|KNOWLEDGE_|KMCP_|TUNNEL_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'kmcp-tunnel-'));
const data = join(dir, 'data');
writeFileSync(join(dir, 'mcp.config.json'), '{}');
Object.assign(process.env, { MCP_STORE: 'sqlite', MCP_DATA_DIR: data, MCP_CONFIG_PATH: join(dir, 'mcp.config.json'), MCP_ENV_FILE: 'none', KMCP_SUPERVISE: 'false', KNOWLEDGE_CONSOLE: 'on', KNOWLEDGE_SCAN_ENABLED: 'false', PORT: '0' });

// cloudflared, as far as this server uses it.
const bin = join(dir, 'bin');
mkdirSync(bin);
const calls = join(bin, 'calls');
const ID = '11111111-2222-3333-4444-555555555555';
const ID2 = '66666666-7777-8888-9999-000000000000';
const ZONE = 'example.com';
// What `cloudflared tunnel login` stores: a JSON token in a PEM block, as the real one does.
const cert = (zone: string) => `-----BEGIN ARGO TUNNEL TOKEN-----\n${Buffer.from(JSON.stringify({ zoneID: `zone-${zone}`, accountID: 'acct-1', apiToken: 'cf-token-test' })).toString('base64')}\n-----END ARGO TUNNEL TOKEN-----\n`;
writeFileSync(join(bin, 'cert-example.com'), cert('example.com'));
writeFileSync(join(bin, 'cert-other.org'), cert('other.org'));
writeFileSync(
  join(bin, 'cloudflared'),
  [
    '#!/bin/sh',
    'here="$(dirname "$0")"',
    'echo "$*" >> "$here/calls"',
    '[ "$*" != "--version" ] && echo "$HOME" >> "$here/homes"',
    'zone="$(cat "$here/zone" 2>/dev/null || echo example.com)"',
    'case "$*" in',
    '  "--version") echo "cloudflared version 2026.1.0";;',
    '  "tunnel login") echo "Please open the following URL and log in with your Cloudflare account:" >&2; echo "https://dash.example.com/argotunnel?callback=x" >&2',
    '    n=0; while [ ! -f "$here/login-finish" ] && [ $n -lt 150 ]; do sleep 0.1; n=$((n+1)); done; [ -f "$here/login-finish" ] || exit 1',
    '    mkdir -p "$HOME/.cloudflared" && cp "$here/cert-$zone" "$HOME/.cloudflared/cert.pem"; rm -f "$here/login-finish";;',
    '  *" --url http://localhost:"*) echo "2026-01-01T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com..." >&2',
    '    [ -f "$here/quick-fails" ] && { echo "2026-01-01T00:00:00Z ERR failed to request quick Tunnel: 429 Too Many Requests" >&2; exit 1; }',
    '    echo "2026-01-01T00:00:01Z INF |  https://calm-river-demo.trycloudflare.com  |" >&2; while true; do sleep 1; done;;',
    '  *" create --credentials-file "*) [ -f "$here/name-taken" ] && { echo "failed to create tunnel: tunnel with name already exists" >&2; exit 1; }',
    `    for a in "$@"; do prev2="$prev"; prev="$a"; [ "$prev2" = "--credentials-file" ] && echo '{"AccountTag":"acct-1","TunnelSecret":"s","TunnelID":"${ID}"}' > "$a"; done; echo "Created tunnel";;`,
    '  *" info --output json "*) if [ -f "$here/tunnel-busy" ]; then echo \'{"id":"t","name":"n","conns":[{"id":"c1","conns":[{"colo_name":"icn01"}]}]}\'; else echo \'{"id":"t","name":"n","conns":[]}\'; fi;;',
    `  *" token --cred-file "*) for a in "$@"; do prev2="$prev"; prev="$a"; [ "$prev2" = "--cred-file" ] && echo '{"AccountTag":"acct-1","TunnelSecret":"s2","TunnelID":"${ID2}"}' > "$a"; done; echo "Token written";;`,
    '  *" route dns "*) [ -f "$here/dns-taken" ] && { echo "Failed to add route: code: 1003, reason: An A, AAAA, or CNAME record with that host already exists." >&2; exit 1; }',
    '    for a in "$@"; do last="$a"; done',
    '    case "$last" in *".$zone") name="$last";; *) name="$last.$zone";; esac',
    '    echo "2026-01-01T00:00:02Z INF Added CNAME $name which will route to this tunnel tunnelID=x" >&2;;',
    '  *" --no-autoupdate run") echo "2026-01-01T00:00:01Z INF Registered tunnel connection connIndex=0 location=xyz" >&2; while true; do sleep 1; done;;',
    '  *) exit 1;;',
    'esac',
    '',
  ].join('\n'),
);
chmodSync(join(bin, 'cloudflared'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const { consoleToken } = await import('../src/admin/auth.js');
const { runHttp } = await import('../src/server/http.js');
const { Registry } = await import('../src/plugin/registry.js');
const { builtinPlugins } = await import('../src/plugins/index.js');
const { certPath, cloudflareApi, cloudflaredHome, lookup, reach, resumeTunnel, stopTunnel, tunnelHostname, tunnelView } = await import('../src/admin/tunnel.js');

// Public DNS, Cloudflare's API and the address seen from outside, as the tests need them.
const NS: Record<string, string[]> = { 'example.com': ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], 'other.org': ['ns1.other-host.net', 'ns2.other-host.net'] };
lookup.ns = async (name) => {
  if (NS[name]) return NS[name];
  throw Object.assign(new Error('queryNs ENODATA'), { code: 'ENODATA' });
};
let zoneAnswer: (id: string) => { status: number; body: unknown } = (id) => ({ status: 200, body: { success: true, result: { name: id.replace(/^zone-/, '') } } });
const zoneAsks: Array<{ path: string; auth: string | undefined }> = [];
const api_ = (await import('node:http')).createServer((req, res) => {
  zoneAsks.push({ path: req.url ?? '', auth: req.headers.authorization });
  const a = zoneAnswer(decodeURIComponent((req.url ?? '').replace('/client/v4/zones/', '')));
  res.writeHead(a.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(a.body));
});
await new Promise<void>((r) => api_.listen(0, '127.0.0.1', r));
cloudflareApi.base = `http://127.0.0.1:${(api_.address() as import('node:net').AddressInfo).port}/client/v4`;
let answering = true;
reach.health = async () => (answering ? null : 'its DNS record is not visible yet');

const server = await runHttp(new Registry(builtinPlugins));
const base = `http://localhost:${server.port}`;
const token = consoleToken();
after(async () => {
  stopTunnel();
  api_.close();
  await server.close();
});
const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}/console/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
};
/** What cloudflared was started with, in order. Asking it for its version (is it installed?) is left out. */
const said = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter((l) => l !== '--version') : []);
const config = join(data, 'cloudflared.yml');
const pidOf = () => JSON.parse(readFileSync(join(data, 'tunnel.json'), 'utf8')).pid as number;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number) => {
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
};

test('a temporary address: started with a config of its own, shown, and stopped', async () => {
  assert.deepEqual((await api('GET', '/tunnel')).json, { installed: true, signedIn: false, signedInFor: null, verified: false, running: false, mode: null, url: null, hostname: null, problem: null });

  const on = await api('POST', '/tunnel', { mode: 'quick' });
  assert.deepEqual([on.status, on.json.running, on.json.mode, on.json.url], [200, true, 'quick', 'https://calm-river-demo.trycloudflare.com'], on.text);
  // Its own config file, so that the person's own cloudflared setup is neither read nor in the way.
  assert.equal(said().at(-1), `tunnel --config ${config} --no-autoupdate --url http://localhost:${server.port}`);
  const pid = pidOf();
  assert.ok(alive(pid));

  const off = await api('DELETE', '/tunnel');
  assert.deepEqual([off.json.running, off.json.url], [false, null]);
  assert.ok(await gone(pid), 'cloudflared was stopped');

  // Cloudflare gives no address: said with what cloudflared said, and nothing is left running.
  writeFileSync(join(bin, 'quick-fails'), '');
  const failed = await api('POST', '/tunnel', { mode: 'quick' });
  assert.deepEqual([failed.status, /Cloudflare gave no address \(failed to request quick Tunnel: 429 Too Many Requests\)/.test(failed.json.error)], [422, true], failed.text);
  assert.equal((await api('GET', '/tunnel')).json.running, false);
  rmSync(join(bin, 'quick-fails'));
});

test('an address of one\'s own: the server signs in for itself, checks the domain first, and calls it working only when it answers', async () => {
  for (const bad of ['localhost', 'no spaces.example.com', 'http://', 'a..b', '-x.example.com', 'example']) assert.throws(() => tunnelHostname(bad), /not a host name/, bad);
  assert.equal(tunnelHostname(' https://MCP.Example.com/path '), 'mcp.example.com');

  const early = await api('POST', '/tunnel', { mode: 'named', hostname: 'mcp.example.com' });
  assert.deepEqual([early.status, /not signed in to Cloudflare yet/.test(early.json.error)], [422, true]);

  // A domain whose DNS is not run by Cloudflare is turned down before anything else, signed in or not.
  const elsewhere = await api('POST', '/tunnel/check', { hostname: 'mcp.other.org' });
  assert.deepEqual([elsewhere.status, /other\.org is not on Cloudflare: its name servers are ns1\.other-host\.net/.test(elsewhere.json.error)], [422, true], elsewhere.text);
  const unknown = await api('POST', '/tunnel/check', { hostname: 'mcp.nowhere.test' });
  assert.match(unknown.json.error, /No domain was found for mcp\.nowhere\.test/);
  assert.deepEqual((await api('POST', '/tunnel/check', { hostname: 'mcp.example.com' })).json, { hostname: 'mcp.example.com', apex: 'example.com', signedInFor: null, unknown: null, ready: false });

  // The console runs cloudflared's own sign-in, with HOME in this server's data: the person's ~/.cloudflared is
  // neither read nor written. The page is told where the browser was sent.
  const signIn = async (zone: string) => {
    writeFileSync(join(bin, 'zone'), zone);
    assert.equal((await api('POST', '/logins/cloudflared/sign-in')).json.running, true);
    let step: any;
    for (let i = 0; i < 100; i++) {
      step = (await api('GET', '/logins/cloudflared/sign-in')).json;
      if (step.url) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(step.url, 'https://dash.example.com/argotunnel?callback=x');
    writeFileSync(join(bin, 'login-finish'), '');
    for (let i = 0; i < 200 && (await api('GET', '/logins/cloudflared/sign-in')).json.running; i++) await new Promise((r) => setTimeout(r, 30));
  };
  // Signed in for the wrong domain: said, and nothing is made in the account.
  writeFileSync(join(bin, 'cert-other.org'), cert('example.net'));
  NS['example.net'] = NS['example.com'];
  await signIn('other.org');
  assert.equal(readFileSync(join(bin, 'homes'), 'utf8').trim().split('\n').at(-1), cloudflaredHome());
  assert.ok(existsSync(certPath()) && certPath().startsWith(data));
  const view = (await api('GET', '/tunnel')).json;
  assert.deepEqual([view.signedIn, view.signedInFor], [true, 'example.net']);
  // The token in the sign-in was used to ask which domain it is for, and for nothing else.
  assert.deepEqual(zoneAsks.at(-1), { path: '/client/v4/zones/zone-example.net', auth: 'Bearer cf-token-test' });
  const wrong = await api('POST', '/tunnel', { mode: 'named', hostname: 'mcp.example.com' });
  assert.deepEqual([wrong.status, /The sign-in is for example\.net, and mcp\.example\.com is under example\.com\. Sign in again and pick example\.com/.test(wrong.json.error)], [422, true], wrong.text);
  assert.ok(!said().some((l) => l.includes(' create ') || l.includes(' route ')), 'nothing was made');

  // Signed out (this server's file only) and in again, for the right domain.
  assert.equal((await api('DELETE', '/tunnel/sign-in')).json.signedIn, false);
  await signIn('example.com');
  assert.deepEqual((await api('POST', '/tunnel/check', { hostname: 'mcp.example.com' })).json, { hostname: 'mcp.example.com', apex: 'example.com', signedInFor: 'example.com', unknown: null, ready: true });

  // A name that already has a record in the person's DNS is left as it is.
  writeFileSync(join(bin, 'dns-taken'), '');
  const taken = await api('POST', '/tunnel', { mode: 'named', hostname: 'mcp.example.com' });
  assert.deepEqual([taken.status, /already has a DNS record in Cloudflare\. It is not written over/.test(taken.json.error)], [422, true], taken.text);
  assert.ok(!said().some((l) => l.includes('overwrite')));
  rmSync(join(bin, 'dns-taken'));

  const on = await api('POST', '/tunnel', { mode: 'named', hostname: 'MCP.Example.com' });
  assert.deepEqual([on.status, on.json.running, on.json.mode, on.json.url, on.json.hostname, on.json.verified, on.json.problem], [200, true, 'named', 'https://mcp.example.com', 'mcp.example.com', true, null], on.text);
  const lines = said();
  const own = `--origincert ${certPath()} --config ${config}`;
  assert.ok(lines.includes(`tunnel ${own} route dns ${ID} mcp.example.com`), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith(`tunnel ${own} create --credentials-file `)));
  assert.equal(lines.at(-1), `tunnel --config ${config} --no-autoupdate run`);
  // The tunnel's key is kept with this server's data, and the config names this server and nothing else.
  assert.ok(existsSync(join(data, `cloudflared-${ID}.json`)));
  const yml = readFileSync(config, 'utf8');
  assert.match(yml, new RegExp(`tunnel: ${ID}\\ncredentials-file: "[^"]*cloudflared-${ID}\\.json"\\ningress:\\n  - hostname: mcp\\.example\\.com\\n    service: http://localhost:${server.port}\\n  - service: http_status:404`));

  // Started again for the same address: the tunnel that was made is used, not a second one.
  const creates = () => said().filter((l) => l.includes(' create ')).length;
  const before = creates();
  assert.equal((await api('POST', '/tunnel', { mode: 'named', hostname: 'mcp.example.com' })).status, 200);
  assert.equal(creates(), before);

  // Connected but not answering from outside: not called working, and asked again on request.
  answering = false;
  const silent = await api('POST', '/tunnel/recheck');
  assert.deepEqual([silent.json.running, silent.json.verified, /does not answer yet \(its DNS record is not visible yet\)/.test(silent.json.problem)], [true, false, true], silent.text);
  answering = true;
  assert.equal((await api('POST', '/tunnel/recheck')).json.verified, true);

  // cloudflared is gone (the machine was restarted): it comes back with the server, for the same address.
  const pid = pidOf();
  process.kill(pid);
  assert.ok(await gone(pid));
  assert.equal((await tunnelView()).running, false);
  await resumeTunnel(server.port);
  const back = await tunnelView();
  assert.deepEqual([back.running, back.url, creates()], [true, 'https://mcp.example.com', before]);

  // Turned off by the person, it stays off.
  await api('DELETE', '/tunnel');
  await resumeTunnel(server.port);
  assert.equal((await tunnelView()).running, false);
});

test('a tunnel made before for the address is taken over, unless it runs somewhere now', async () => {
  writeFileSync(join(bin, 'name-taken'), '');
  try {
    // Running on another computer: not joined, and the person is told why.
    writeFileSync(join(bin, 'tunnel-busy'), '');
    const busy = await api('POST', '/tunnel', { mode: 'named', hostname: 'docs.example.com' });
    assert.deepEqual([busy.status, /running somewhere else now \(1 connector\)\. Stop cloudflared there/.test(busy.json.error)], [422, true], busy.text);
    assert.ok(!said().some((l) => l.includes(' token ')), 'no key is fetched for a tunnel in use');
    rmSync(join(bin, 'tunnel-busy'));

    // Not running: its key is fetched from Cloudflare into this server's data, and it is run here.
    const on = await api('POST', '/tunnel', { mode: 'named', hostname: 'docs.example.com' });
    assert.deepEqual([on.status, on.json.running, on.json.url], [200, true, 'https://docs.example.com'], on.text);
    const own = `--origincert ${certPath()} --config ${config}`;
    const lines = said();
    assert.ok(lines.some((l) => l.startsWith(`tunnel ${own} info --output json knowledge-mcp-docs-example-com`)), lines.join('\n'));
    assert.ok(lines.some((l) => l.startsWith(`tunnel ${own} token --cred-file `) && l.endsWith(' knowledge-mcp-docs-example-com')), lines.join('\n'));
    assert.ok(lines.includes(`tunnel ${own} route dns ${ID2} docs.example.com`), lines.join('\n'));
    assert.ok(existsSync(join(data, `cloudflared-${ID2}.json`)));
    assert.match(readFileSync(config, 'utf8'), new RegExp(`tunnel: ${ID2}\\n`));
    await api('DELETE', '/tunnel');
  } finally {
    rmSync(join(bin, 'name-taken'), { force: true });
    rmSync(join(bin, 'tunnel-busy'), { force: true });
  }
});

test('a sign-in whose domain Cloudflare does not say: the record cloudflared reports is checked, and a wrong one is named', async () => {
  // As if the token could not read the zone: the domain is unknown, so the record decides.
  zoneAnswer = () => ({ status: 403, body: { success: false, errors: [{ message: 'Authentication error' }] } });
  rmSync(certPath(), { force: true });
  mkdirSync(join(cloudflaredHome(), '.cloudflared'), { recursive: true });
  writeFileSync(certPath(), cert('other.org')); // for other.org, which Cloudflare does not tell us
  NS['other.org'] = NS['example.com'];
  try {
    const check = (await api('POST', '/tunnel/check', { hostname: 'mcp.example.com' })).json;
    assert.deepEqual([check.signedInFor, /Cloudflare answered 403: Authentication error/.test(check.unknown), check.ready], [null, true, true]);
    writeFileSync(join(bin, 'zone'), 'other.org');
    const r = await api('POST', '/tunnel', { mode: 'named', hostname: 'mcp.example.com' });
    assert.deepEqual([r.status, /Cloudflare made the record mcp\.example\.com\.other\.org instead of mcp\.example\.com/.test(r.json.error)], [422, true], r.text);
    assert.equal((await tunnelView()).running, false, 'nothing is left running');
  } finally {
    zoneAnswer = (id) => ({ status: 200, body: { success: true, result: { name: id.replace(/^zone-/, '') } } });
    NS['other.org'] = ['ns1.other-host.net', 'ns2.other-host.net'];
    writeFileSync(join(bin, 'zone'), 'example.com');
  }
});

test('what comes through a tunnel never reaches the console', async () => {
  // As Cloudflare delivers a request: from this machine, marked with its own headers, whatever host it names.
  const marked: Array<Record<string, string>> = [{ 'Cf-Connecting-Ip': '203.0.113.9' }, { 'Cf-Ray': '8f2a-ICN' }, { 'X-Forwarded-Proto': 'https' }, { 'X-Forwarded-Host': 'mcp.example.com' }];
  for (const headers of marked) {
    assert.equal((await api('GET', '/state', undefined, headers)).status, 403, JSON.stringify(headers));
    assert.equal((await fetch(`${base}/console/`, { headers })).status, 403);
  }
  assert.equal((await api('GET', '/state')).status, 200);
  // The MCP endpoint is what a tunnel is for: it asks for a key as it always did.
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Cf-Connecting-Ip': '203.0.113.9' }, body: '{}' })).status, 401);
});
