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
writeFileSync(
  join(bin, 'cloudflared'),
  [
    '#!/bin/sh',
    'here="$(dirname "$0")"',
    'echo "$*" >> "$here/calls"',
    'case "$*" in',
    '  "--version") echo "cloudflared version 2026.1.0";;',
    '  "tunnel login") echo "Please open the following URL and log in with your Cloudflare account:" >&2; echo "https://dash.example.com/argotunnel?callback=x" >&2',
    '    n=0; while [ ! -f "$here/login-finish" ] && [ $n -lt 150 ]; do sleep 0.1; n=$((n+1)); done; [ -f "$here/login-finish" ] || exit 1',
    '    mkdir -p "$here/home" && echo cert > "$here/home/cert.pem"; rm -f "$here/login-finish";;',
    '  *" --url http://localhost:"*) echo "2026-01-01T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com..." >&2',
    '    [ -f "$here/quick-fails" ] && { echo "2026-01-01T00:00:00Z ERR failed to request quick Tunnel: 429 Too Many Requests" >&2; exit 1; }',
    '    echo "2026-01-01T00:00:01Z INF |  https://calm-river-demo.trycloudflare.com  |" >&2; while true; do sleep 1; done;;',
    '  *" create --credentials-file "*) [ -f "$here/name-taken" ] && { echo "failed to create tunnel: tunnel with name already exists" >&2; exit 1; }',
    `    for a in "$@"; do prev2="$prev"; prev="$a"; [ "$prev2" = "--credentials-file" ] && echo '{"AccountTag":"a","TunnelSecret":"s","TunnelID":"${ID}"}' > "$a"; done; echo "Created tunnel";;`,
    '  *" route dns "*) [ -f "$here/dns-taken" ] && { echo "Failed to add route: code: 1003, reason: An A, AAAA, or CNAME record with that host already exists." >&2; exit 1; }; echo "Added CNAME";;',
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
const { cloudflaredHome, resumeTunnel, stopTunnel, tunnelHostname, tunnelView } = await import('../src/admin/tunnel.js');
cloudflaredHome.dir = join(bin, 'home');

const server = await runHttp(new Registry(builtinPlugins));
const base = `http://localhost:${server.port}`;
const token = consoleToken();
after(async () => {
  stopTunnel();
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
  assert.deepEqual((await api('GET', '/tunnel')).json, { installed: true, signedIn: false, running: false, mode: null, url: null, hostname: null, problem: null });

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

test('an address of one\'s own: signed in once, the tunnel and its DNS record made, nothing of the person\'s written over', async () => {
  for (const bad of ['localhost', 'no spaces.example.com', 'http://', 'a..b', '-x.example.com', 'example']) assert.throws(() => tunnelHostname(bad), /not a host name/, bad);
  assert.equal(tunnelHostname(' https://MCP.Example.com/path '), 'mcp.example.com');

  const early = await api('POST', '/tunnel', { mode: 'named', hostname: 'mcp.example.com' });
  assert.deepEqual([early.status, /not signed in to Cloudflare yet/.test(early.json.error)], [422, true]);

  // The console runs cloudflared's own sign-in: the page is told where the browser was sent.
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
  assert.equal((await api('GET', '/tunnel')).json.signedIn, true);

  // A name that already has a record in the person's DNS is left as it is.
  writeFileSync(join(bin, 'dns-taken'), '');
  const taken = await api('POST', '/tunnel', { mode: 'named', hostname: 'mcp.example.com' });
  assert.deepEqual([taken.status, /already has a DNS record in Cloudflare\. It is not written over/.test(taken.json.error)], [422, true], taken.text);
  assert.ok(!said().some((l) => l.includes('overwrite')));
  rmSync(join(bin, 'dns-taken'));

  const on = await api('POST', '/tunnel', { mode: 'named', hostname: 'MCP.Example.com' });
  assert.deepEqual([on.status, on.json.running, on.json.mode, on.json.url, on.json.hostname], [200, true, 'named', 'https://mcp.example.com', 'mcp.example.com'], on.text);
  const lines = said();
  assert.ok(lines.includes(`tunnel --config ${config} route dns ${ID} mcp.example.com`));
  assert.equal(lines.at(-1), `tunnel --config ${config} --no-autoupdate run`);
  // The tunnel's key is kept with this server's data, and the config names this server and nothing else.
  assert.ok(existsSync(join(data, `cloudflared-${ID}.json`)));
  const yml = readFileSync(config, 'utf8');
  assert.match(yml, new RegExp(`tunnel: ${ID}\\ncredentials-file: "[^"]*cloudflared-${ID}\\.json"\\ningress:\\n  - hostname: mcp\\.example\\.com\\n    service: http://localhost:${server.port}\\n  - service: http_status:404\\n`));

  // Started again for the same address: the tunnel that was made is used, not a second one.
  const creates = () => said().filter((l) => l.includes(' create ')).length;
  const before = creates();
  assert.equal((await api('POST', '/tunnel', { mode: 'named', hostname: 'mcp.example.com' })).status, 200);
  assert.equal(creates(), before);

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
