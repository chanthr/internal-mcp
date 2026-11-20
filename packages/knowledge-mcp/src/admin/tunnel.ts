/**
 * Reaching this server from outside, through a Cloudflare Tunnel set up from the console.
 *
 * The server stays on this machine, with the documents and the index. cloudflared (Cloudflare's program) connects
 * out to Cloudflare, and Cloudflare gives the server a public https address: nothing to open in a router, no
 * certificate to make. Two ways:
 *
 *   quick   A temporary address (https://<words>.trycloudflare.com). No account. For trying it out: Cloudflare
 *           gives no guarantee, the address is new every time, and it carries no streamed answers.
 *   named   An address of the person's own (mcp.example.com) on a domain in their Cloudflare account. They sign
 *           in once (cloudflared opens the browser, they pick that domain); the tunnel and its DNS record are made
 *           for them, and the address counts as working only once it answers from outside.
 *
 * What does not change: the MCP endpoint asks for a key or a sign-in exactly as before, and the console answers
 * on this machine only (a request that came through a tunnel is refused by its own rules, auth.ts).
 *
 * cloudflared runs beside the server, not under it, so that a restart after a saved setting does not drop the
 * address. It is found again by a note in the data directory, and stopped when the server is stopped.
 *
 * The person's own cloudflared setup is never read, used or changed: not ~/.cloudflared/config.yml, not their
 * tunnels, and not the certificate of their own sign-in, which is for whichever domain they picked back then. This
 * server signs in for itself: cloudflared is run with HOME pointed into the data directory, where its certificate
 * is kept, and every command names that certificate and a config file of its own.
 *
 * A sign-in is for one domain (one zone). Before anything is made in the account, the address is checked against
 * it: the domain must be on Cloudflare (public DNS says so), and the sign-in must be for that domain (Cloudflare's
 * API, asked with the sign-in's own token, says which one it is). After the DNS record is made, what cloudflared
 * says it made is compared with what was asked for.
 */
import { spawn } from 'node:child_process';
import { promises as dns } from 'node:dns';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { dataFile } from '../core/data_file.js';
import { dataDir } from '../core/paths.js';
import { backgroundExec, hasTool, type Exec } from '../setup/auto.js';
import { RELOAD_EXIT_CODE } from './supervisor.js';

interface Saved {
  mode: 'quick' | 'named';
  /** Should it be running? Kept so the tunnel comes back when the server is started again. */
  on: boolean;
  /** named: the address, and the tunnel made for it (in which Cloudflare account). */
  hostname?: string;
  tunnelId?: string;
  tunnelName?: string;
  accountId?: string;
  /** named: the address answered from outside the last time it was checked. */
  verified?: boolean;
  /** The cloudflared that is running, and the address it serves. */
  pid?: number;
  url?: string;
  port?: number;
}
const saved = dataFile<Saved>('tunnel.json');
/** A config with nothing of a tunnel in it yet. One setting, so that cloudflared does not log it as empty. */
const PLACEHOLDER = '# Written by Knowledge MCP for its tunnel.\nno-autoupdate: true\n';
const logPath = () => join(dataDir(), 'tunnel.log');
const configPath = () => join(dataDir(), 'cloudflared.yml');
const credentialsPath = (id: string) => join(dataDir(), `cloudflared-${id}.json`);

/**
 * This server's own Cloudflare sign-in. `cloudflared tunnel login` writes its certificate under $HOME/.cloudflared,
 * so it is run with HOME set here (cli_runs.ts), and the certificate lands in the data directory.
 */
export const cloudflaredHome = (): string => join(dataDir(), 'cloudflared');
export const certPath = (): string => join(cloudflaredHome(), '.cloudflared', 'cert.pem');
export const cloudflaredSignedIn = (): boolean => existsSync(certPath());
/** The flags every account command takes: this server's certificate and config, never the person's own. */
const own = (): string[] => ['--origincert', certPath(), '--config', configPath()];

/** Cloudflare's API. A test points it at a fake. */
export const cloudflareApi: { base: string } = { base: 'https://api.cloudflare.com/client/v4' };

interface Cert {
  zoneId: string;
  accountId: string;
  apiToken: string;
}
/** What the sign-in holds: the zone it is for, the account, and a token for the API. Never shown or logged. */
function readCert(): Cert | null {
  try {
    const pem = readFileSync(certPath(), 'utf8');
    const block = /-----BEGIN ARGO TUNNEL TOKEN-----([\s\S]*?)-----END ARGO TUNNEL TOKEN-----/.exec(pem)?.[1];
    if (!block) return null;
    const j = JSON.parse(Buffer.from(block.replace(/\s+/g, ''), 'base64').toString('utf8')) as { zoneID?: string; accountID?: string; apiToken?: string };
    return j.zoneID && j.accountID && j.apiToken ? { zoneId: j.zoneID, accountId: j.accountID, apiToken: j.apiToken } : null;
  } catch {
    return null;
  }
}

/** The domain the sign-in is for, as Cloudflare names it. Asked once per sign-in. */
let zoneKnown: { stamp: number; name: string | null; why: string | null } | null = null;
export async function signedInDomain(): Promise<{ name: string | null; why: string | null } | null> {
  if (!cloudflaredSignedIn()) return null;
  const stamp = statSync(certPath()).mtimeMs;
  if (zoneKnown?.stamp === stamp && zoneKnown.name) return zoneKnown;
  const cert = readCert();
  let known: { name: string | null; why: string | null };
  if (!cert) known = { name: null, why: 'the sign-in could not be read' };
  else {
    try {
      const res = await fetch(`${cloudflareApi.base}/zones/${encodeURIComponent(cert.zoneId)}`, { headers: { Authorization: `Bearer ${cert.apiToken}` }, signal: AbortSignal.timeout(15_000) });
      const body = (await res.json().catch(() => ({}))) as { result?: { name?: string }; errors?: Array<{ message?: string }> };
      known = res.ok && body.result?.name ? { name: body.result.name.toLowerCase(), why: null } : { name: null, why: `Cloudflare answered ${res.status}${body.errors?.[0]?.message ? `: ${body.errors[0].message}` : ''}` };
    } catch (e) {
      known = { name: null, why: `Cloudflare could not be reached (${e instanceof Error ? e.message : String(e)})` };
    }
  }
  zoneKnown = { stamp, ...known };
  return known;
}

/** Forget this server's sign-in (the file only: the token stays valid in Cloudflare until it is revoked there). */
export function signOutCloudflare(): void {
  rmSync(certPath(), { force: true });
  zoneKnown = null;
}

/** Name servers, through the system's resolver. A test answers for it. */
export const lookup: { ns: (name: string) => Promise<string[]> } = { ns: (name) => dns.resolveNs(name) };

/**
 * The zone a name belongs to, by public DNS: the nearest name up the tree that has name servers. And whether those
 * are Cloudflare's, which they must be for a tunnel's record to be made there.
 */
export async function domainOf(hostname: string): Promise<{ apex: string; cloudflare: boolean; ns: string[] } | null> {
  const labels = hostname.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const name = labels.slice(i).join('.');
    try {
      const ns = (await lookup.ns(name)).map((n) => n.toLowerCase().replace(/\.$/, ''));
      if (ns.length) return { apex: name, cloudflare: ns.every((n) => n.endsWith('.ns.cloudflare.com')), ns };
    } catch {
      /* no name servers here: one level up */
    }
  }
  return null;
}

export interface AddressCheck {
  hostname: string;
  /** The domain the address is under. */
  apex: string;
  /** The domain this server is signed in for, null when it is not signed in or Cloudflare did not say. */
  signedInFor: string | null;
  /** Why the domain of the sign-in is not known, when signed in. */
  unknown: string | null;
  /** Signed in, and for this domain. */
  ready: boolean;
}

/** Can a tunnel be made for this address? Nothing is made: DNS and the sign-in are only read. */
export async function checkAddress(raw: string): Promise<AddressCheck> {
  const hostname = tunnelHostname(raw);
  const domain = await domainOf(hostname);
  if (!domain) throw new Error(`No domain was found for ${hostname} in public DNS. Is the domain registered?`);
  if (!domain.cloudflare) {
    throw new Error(`${domain.apex} is not on Cloudflare: its name servers are ${domain.ns.slice(0, 2).join(', ')}. Add the domain to your Cloudflare account first (Cloudflare gives it two name servers), or use a temporary address.`);
  }
  const signed = await signedInDomain();
  return {
    hostname,
    apex: domain.apex,
    signedInFor: signed?.name ?? null,
    unknown: signed && !signed.name ? signed.why : null,
    ready: !!signed && (signed.name === domain.apex || (!signed.name && !!readCert())),
  };
}

/** A name a browser can reach: letters, digits and dashes in labels, at least two labels. */
export function tunnelHostname(raw: string): string {
  const h = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)) throw new Error('That is not a host name. It looks like mcp.example.com, on a domain that is in your Cloudflare account.');
  return h;
}

const alive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const logText = (): string => {
  try {
    return readFileSync(logPath(), 'utf8');
  } catch {
    return '';
  }
};
/** The last thing cloudflared said that reads like a failure, for the page. */
const lastProblem = (): string | null => {
  const line = logText().split('\n').filter((l) => /\bERR\b|error|failed|Unauthorized/i.test(l)).pop();
  return line ? line.replace(/^\S+\s+(ERR|INF|WRN)\s+/, '').slice(0, 240) : null;
};

export interface TunnelView {
  installed: boolean;
  /** This server is signed in to Cloudflare (needed for an address of one's own), and for which domain. */
  signedIn: boolean;
  signedInFor: string | null;
  /** named: the address answered from outside. */
  verified: boolean;
  running: boolean;
  mode: 'quick' | 'named' | null;
  /** The public address of the server, without a path. */
  url: string | null;
  hostname: string | null;
  problem: string | null;
}

export async function tunnelView(exec: Exec = backgroundExec): Promise<TunnelView> {
  const s = saved.read();
  const running = alive(s?.pid);
  const signed = cloudflaredSignedIn() ? await signedInDomain() : null;
  return {
    installed: await hasTool(exec, 'cloudflared'),
    signedIn: cloudflaredSignedIn(),
    signedInFor: signed?.name ?? null,
    verified: running && s?.mode === 'named' ? !!s.verified : false,
    running,
    mode: s?.mode ?? null,
    url: running ? s?.url ?? null : null,
    hostname: s?.hostname ?? null,
    // It was meant to run and is not: say what cloudflared said last.
    problem: s?.on && !running ? lastProblem() ?? 'cloudflared stopped.' : null,
  };
}

/** Start cloudflared beside the server, writing what it says to the tunnel log. Returns its process id. */
function launch(args: string[]): number {
  rmSync(logPath(), { force: true });
  const out = openSync(logPath(), 'a', 0o600);
  try {
    const child = spawn('cloudflared', args, { detached: true, stdio: ['ignore', out, out] });
    child.on('error', () => {});
    child.unref();
    if (!child.pid) throw new Error('cloudflared could not be started.');
    return child.pid;
  } finally {
    closeSync(out);
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until the log says what is asked for, or cloudflared has stopped, or the time is up. */
async function until(pid: number, found: () => string | null, ms: number): Promise<string | null> {
  const end = Date.now() + ms;
  for (;;) {
    const got = found();
    if (got) return got;
    if (!alive(pid) || Date.now() > end) return null;
    await wait(250);
  }
}

export function stopTunnel(keep = false): void {
  const s = saved.read();
  if (s?.pid && alive(s.pid)) {
    try {
      process.kill(s.pid);
    } catch {
      /* already gone */
    }
  }
  if (s && !keep) saved.write({ ...s, on: false, pid: undefined, verified: false, url: s.mode === 'named' ? s.url : undefined });
}

/** A temporary address, without an account. */
export async function startQuickTunnel(port: number): Promise<TunnelView> {
  stopTunnel();
  // Its own config: cloudflared refuses a quick tunnel when it finds a config file of the person's.
  writeFileSync(configPath(), PLACEHOLDER, { mode: 0o600 });
  const pid = launch(['tunnel', '--config', configPath(), '--no-autoupdate', '--url', `http://localhost:${port}`]);
  saved.write({ mode: 'quick', on: true, pid, port });
  const url = await until(pid, () => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(logText())?.[0] ?? null, 30_000);
  if (!url) {
    const why = lastProblem();
    stopTunnel();
    throw new Error(`Cloudflare gave no address${why ? ` (${why})` : ''}. Try again in a moment.`);
  }
  saved.write({ mode: 'quick', on: true, pid, port, url });
  return tunnelView();
}

const said = (r: { stdout: string; stderr: string }): string => `${r.stderr}\n${r.stdout}`.split('\n').map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 240) ?? '';

/** What cloudflared says it put in DNS: "Added CNAME <name> which will route to this tunnel", or that it was there. */
function routedName(out: string): string | null {
  return /Added CNAME (\S+)/i.exec(out)?.[1]?.toLowerCase().replace(/\.$/, '') ?? /(\S+) is already configured to route to your tunnel/i.exec(out)?.[1]?.toLowerCase().replace(/\.$/, '') ?? null;
}

/** Answers from outside. A test answers for it. */
export const reach: { health: (hostname: string) => Promise<string | null> } = {
  /**
   * Does https://<hostname>/health answer as this server does? Asked through Cloudflare's public resolver, so a
   * record that was just made is found even where the system's resolver still remembers that there was none.
   * Returns null when it answers, or what went wrong.
   */
  health: async (hostname) => {
    const resolver = new dns.Resolver();
    resolver.setServers(['1.1.1.1', '1.0.0.1']);
    let ip: string;
    try {
      ip = (await resolver.resolve4(hostname))[0];
    } catch {
      return 'its DNS record is not visible yet';
    }
    return new Promise<string | null>((resolve) => {
      const req = request({ host: ip, servername: hostname, path: '/health', headers: { Host: hostname }, timeout: 10_000 }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString('utf8')));
        res.on('end', () => {
          try {
            resolve(res.statusCode === 200 && (JSON.parse(body) as { server?: string }).server === 'knowledge-mcp' ? null : `it answered ${res.statusCode}`);
          } catch {
            resolve(`it answered ${res.statusCode}, not as this server`);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('no answer in 10 seconds')));
      req.on('error', (e) => resolve(e.message));
      req.end();
    });
  },
};

/**
 * How many connectors run a tunnel right now, as Cloudflare lists them (tunnel info). 0 when none, and when the list
 * cannot be read: the key fetch that follows says what is wrong then.
 */
async function connectorsOf(exec: Exec, name: string): Promise<number> {
  const r = await exec('cloudflared', ['tunnel', ...own(), 'info', '--output', 'json', name]);
  if (r.status !== 0) return 0;
  try {
    // cloudflared's Info: `conns` are the connectors, each with its own `conns` to Cloudflare. A connector counts when
    // one of them is up (not waiting to reconnect); one whose connections are not listed counts too.
    const info = JSON.parse(r.stdout) as { conns?: Array<{ conns?: Array<{ is_pending_reconnect?: boolean }> | null }> | null };
    return (info.conns ?? []).filter((c) => !Array.isArray(c.conns) || c.conns.some((x) => !x.is_pending_reconnect)).length;
  } catch {
    return 0;
  }
}

/** Is the address answering yet? Asked a few times: a new record takes a moment to be served. */
async function answers(hostname: string, ms: number): Promise<string | null> {
  const end = Date.now() + ms;
  let why: string | null = 'not checked';
  while (Date.now() < end) {
    why = await reach.health(hostname);
    if (!why) return null;
    await wait(3000);
  }
  return why;
}

/**
 * An address of the person's own. Checks the address against the sign-in first, makes the tunnel in their account
 * (once per address and account), points the address at it, starts it, and says whether it answers from outside.
 * A tunnel of that name made before (by another copy of this server, or an earlier version) is taken over: its key
 * is fetched from Cloudflare, unless it is running somewhere right now. A DNS record that already exists under that
 * name for something else is not written over: the person is told.
 */
export async function startNamedTunnel(port: number, rawHostname: string, exec: Exec = backgroundExec, opts: { waitMs?: number } = {}): Promise<TunnelView> {
  if (!cloudflaredSignedIn()) throw new Error('This server is not signed in to Cloudflare yet. Sign in first, and pick the domain of the address.');
  const check = await checkAddress(rawHostname);
  const hostname = check.hostname;
  if (check.signedInFor && check.signedInFor !== check.apex) {
    throw new Error(`The sign-in is for ${check.signedInFor}, and ${hostname} is under ${check.apex}. Sign in again and pick ${check.apex} on Cloudflare's page.`);
  }
  const cert = readCert();
  if (!cert) throw new Error('The Cloudflare sign-in could not be read. Sign in again.');
  stopTunnel();
  mkdirSync(dataDir(), { recursive: true });
  // The commands need a config file to name (the person's own is never read): an empty one until the tunnel's is written.
  if (!existsSync(configPath())) writeFileSync(configPath(), PLACEHOLDER, { mode: 0o600 });
  let s = saved.read();
  // A tunnel made before is used again for the same address, in the same account.
  let id =
    s?.mode === 'named' && s.hostname === hostname && s.tunnelId && s.accountId === cert.accountId && existsSync(credentialsPath(s.tunnelId)) ? s.tunnelId : undefined;
  const name = `knowledge-mcp-${hostname.replace(/\./g, '-')}`.slice(0, 60);
  if (!id) {
    // The credentials are written where this server keeps its data, not among the person's own tunnels.
    const pending = join(dataDir(), 'cloudflared-new.json');
    rmSync(pending, { force: true });
    const made = await exec('cloudflared', ['tunnel', ...own(), 'create', '--credentials-file', pending, name]);
    if (made.status !== 0) {
      if (!/already exists/i.test(`${made.stderr}${made.stdout}`)) throw new Error(`Cloudflare did not make the tunnel (${said(made)}).`);
      // Made before, for this address: used again. Two computers on one tunnel would share its requests between
      // two servers, so one that is running somewhere now is left to the person to stop first.
      const running = await connectorsOf(exec, name);
      if (running > 0) {
        throw new Error(`The tunnel ${name} for this address is running somewhere else now (${running} connector${running === 1 ? '' : 's'}). Stop cloudflared there, then try again here: two computers on one tunnel would split its requests.`);
      }
      const fetched = await exec('cloudflared', ['tunnel', ...own(), 'token', '--cred-file', pending, name]);
      if (fetched.status !== 0 || !existsSync(pending)) {
        throw new Error(`Your Cloudflare account has a tunnel named ${name} already, and its key could not be fetched (${said(fetched)}). Delete it in the Cloudflare dashboard (Networks, Tunnels), or choose another address.`);
      }
    }
    try {
      id = String((JSON.parse(readFileSync(pending, 'utf8')) as { TunnelID?: string }).TunnelID ?? '');
    } catch {
      id = '';
    }
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Cloudflare made a tunnel, but its credentials could not be read.');
    writeFileSync(credentialsPath(id), readFileSync(pending), { mode: 0o600 });
    rmSync(pending, { force: true });
  }
  const routed = await exec('cloudflared', ['tunnel', ...own(), 'route', 'dns', id, hostname]);
  const out = `${routed.stderr}\n${routed.stdout}`;
  if (routed.status !== 0) {
    if (/already exists|record with that host/i.test(out)) throw new Error(`${hostname} already has a DNS record in Cloudflare. It is not written over: remove it in the Cloudflare dashboard, or choose another name.`);
    if (/zone|not found|authoriz/i.test(out)) throw new Error(`${hostname} is not on a domain this Cloudflare sign-in may change. Sign in again and pick ${check.apex}.`);
    throw new Error(`Cloudflare did not point ${hostname} at the tunnel (${said(routed)}).`);
  }
  // Cloudflare puts a name that is not under the signed-in domain under it instead (mcp.other.com.signed-in.com).
  const made = routedName(out);
  if (made && made !== hostname) {
    throw new Error(`Cloudflare made the record ${made} instead of ${hostname}: the sign-in is for another domain. Remove ${made} in the Cloudflare dashboard (DNS of that domain), then sign in again and pick ${check.apex}.`);
  }
  writeFileSync(
    configPath(),
    [`# Written by Knowledge MCP for its tunnel to ${hostname}.`, `tunnel: ${id}`, `credentials-file: ${JSON.stringify(credentialsPath(id))}`, 'ingress:', `  - hostname: ${hostname}`, `    service: http://localhost:${port}`, '  - service: http_status:404', ''].join('\n'),
    { mode: 0o600 },
  );
  const pid = launch(['tunnel', '--config', configPath(), '--no-autoupdate', 'run']);
  s = { mode: 'named', on: true, hostname, tunnelId: id, tunnelName: name, accountId: cert.accountId, pid, port, url: `https://${hostname}`, verified: false };
  saved.write(s);
  const up = await until(pid, () => (/Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(logText()) ? 'up' : null), 30_000);
  if (!up) {
    const why = lastProblem();
    stopTunnel();
    throw new Error(`The tunnel did not connect${why ? ` (${why})` : ''}.`);
  }
  // Connected is not the same as reachable: the address counts once it answers from outside.
  const why = await answers(hostname, opts.waitMs ?? 60_000);
  saved.write({ ...s, verified: !why });
  const view = await tunnelView();
  return why ? { ...view, problem: `The tunnel is connected, but https://${hostname} does not answer yet (${why}). Check again in a minute.` } : view;
}

/** Ask the address again: does it answer from outside now? */
export async function recheckTunnel(): Promise<TunnelView> {
  const s = saved.read();
  if (!s?.on || s.mode !== 'named' || !s.hostname || !alive(s.pid)) return tunnelView();
  const why = await answers(s.hostname, 1);
  saved.write({ ...s, verified: !why });
  const view = await tunnelView();
  return why ? { ...view, problem: `https://${s.hostname} does not answer yet (${why}).` } : view;
}

/**
 * At start: a tunnel that was on comes back. The cloudflared of before a restart is still there and is kept; one
 * that is gone (the machine was restarted) is started again, on the port the server has now.
 */
export async function resumeTunnel(port: number): Promise<void> {
  const s = saved.read();
  if (!s?.on) return;
  if (alive(s.pid) && s.port === port) return;
  try {
    if (s.mode === 'named' && s.hostname) await startNamedTunnel(port, s.hostname);
    else await startQuickTunnel(port);
  } catch {
    /* the page says what cloudflared said */
  }
}

// The server is stopped (not restarted for a setting): the address should not stay up pointing at nothing.
process.once('exit', (code) => {
  if (code !== RELOAD_EXIT_CODE) stopTunnel(true);
});
