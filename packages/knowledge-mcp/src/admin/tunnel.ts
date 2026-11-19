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
 *           in once (cloudflared opens the browser); the tunnel and its DNS record are made for them.
 *
 * What does not change: the MCP endpoint asks for a key or a sign-in exactly as before, and the console answers
 * on this machine only (a request that came through a tunnel is refused by its own rules, auth.ts).
 *
 * cloudflared runs beside the server, not under it, so that a restart after a saved setting does not drop the
 * address. It is found again by a note in the data directory, and stopped when the server is stopped.
 *
 * The person's own cloudflared setup (~/.cloudflared/config.yml and their tunnels) is never read or changed:
 * every command here names its own config file, and the tunnel's credentials are kept in the data directory.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataFile } from '../core/data_file.js';
import { dataDir } from '../core/paths.js';
import { backgroundExec, hasTool, type Exec } from '../setup/auto.js';
import { RELOAD_EXIT_CODE } from './supervisor.js';

interface Saved {
  mode: 'quick' | 'named';
  /** Should it be running? Kept so the tunnel comes back when the server is started again. */
  on: boolean;
  /** named: the address, and the tunnel made for it. */
  hostname?: string;
  tunnelId?: string;
  tunnelName?: string;
  /** The cloudflared that is running, and the address it serves. */
  pid?: number;
  url?: string;
  port?: number;
}
const saved = dataFile<Saved>('tunnel.json');
const logPath = () => join(dataDir(), 'tunnel.log');
const configPath = () => join(dataDir(), 'cloudflared.yml');
const credentialsPath = (id: string) => join(dataDir(), `cloudflared-${id}.json`);

/** Where cloudflared keeps the account certificate after `cloudflared tunnel login`. */
export const cloudflaredHome: { dir: string } = { dir: join(homedir(), '.cloudflared') };
export const cloudflaredSignedIn = (): boolean => existsSync(join(cloudflaredHome.dir, 'cert.pem'));

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
  /** cloudflared holds a Cloudflare account certificate on this machine (needed for an address of one's own). */
  signedIn: boolean;
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
  return {
    installed: await hasTool(exec, 'cloudflared'),
    signedIn: cloudflaredSignedIn(),
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
  if (s && !keep) saved.write({ ...s, on: false, pid: undefined, url: s.mode === 'named' ? s.url : undefined });
}

/** A temporary address, without an account. */
export async function startQuickTunnel(port: number): Promise<TunnelView> {
  stopTunnel();
  // Its own (empty) config: cloudflared refuses a quick tunnel when it finds a config file of the person's.
  writeFileSync(configPath(), '# Written by Knowledge MCP for its tunnel. Nothing to set here.\n', { mode: 0o600 });
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

/**
 * An address of the person's own. Makes the tunnel in their account (once per address), points the address at
 * it, and starts it. A DNS record that already exists under that name is not written over: the person is told.
 */
export async function startNamedTunnel(port: number, rawHostname: string, exec: Exec = backgroundExec): Promise<TunnelView> {
  const hostname = tunnelHostname(rawHostname);
  if (!cloudflaredSignedIn()) throw new Error('cloudflared is not signed in to Cloudflare yet. Sign in first.');
  stopTunnel();
  let s = saved.read();
  let id = s?.mode === 'named' && s.hostname === hostname && s.tunnelId && existsSync(credentialsPath(s.tunnelId)) ? s.tunnelId : undefined;
  const name = `knowledge-mcp-${hostname.replace(/\./g, '-')}`.slice(0, 60);
  if (!id) {
    // The credentials are written where this server keeps its data, not among the person's own tunnels.
    const pending = join(dataDir(), 'cloudflared-new.json');
    rmSync(pending, { force: true });
    const made = await exec('cloudflared', ['tunnel', '--config', configPath(), 'create', '--credentials-file', pending, name]);
    if (made.status !== 0) {
      if (/already exists/i.test(`${made.stderr}${made.stdout}`)) throw new Error(`Your Cloudflare account already has a tunnel named ${name}, made elsewhere. Delete it in the Cloudflare dashboard (Networks, Tunnels), or choose another address.`);
      throw new Error(`Cloudflare did not make the tunnel (${said(made)}).`);
    }
    try {
      id = String((JSON.parse(readFileSync(pending, 'utf8')) as { TunnelID?: string }).TunnelID ?? '');
    } catch {
      id = '';
    }
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Cloudflare made a tunnel, but its credentials could not be read.');
    writeFileSync(credentialsPath(id), readFileSync(pending), { mode: 0o600 });
    rmSync(pending, { force: true });
    const routed = await exec('cloudflared', ['tunnel', '--config', configPath(), 'route', 'dns', id, hostname]);
    if (routed.status !== 0) {
      const why = `${routed.stderr}${routed.stdout}`;
      if (/already exists|record with that host/i.test(why)) throw new Error(`${hostname} already has a DNS record in Cloudflare. It is not written over: remove it in the Cloudflare dashboard, or choose another name.`);
      if (/zone|not found|authoriz/i.test(why)) throw new Error(`${hostname} is not on a domain this Cloudflare sign-in may change. Use a name under the domain you picked when signing in.`);
      throw new Error(`Cloudflare did not point ${hostname} at the tunnel (${said(routed)}).`);
    }
  }
  writeFileSync(
    configPath(),
    [`# Written by Knowledge MCP for its tunnel to ${hostname}.`, `tunnel: ${id}`, `credentials-file: ${JSON.stringify(credentialsPath(id))}`, 'ingress:', `  - hostname: ${hostname}`, `    service: http://localhost:${port}`, '  - service: http_status:404', ''].join('\n'),
    { mode: 0o600 },
  );
  const pid = launch(['tunnel', '--config', configPath(), '--no-autoupdate', 'run']);
  s = { mode: 'named', on: true, hostname, tunnelId: id, tunnelName: name, pid, port, url: `https://${hostname}` };
  saved.write(s);
  const up = await until(pid, () => (/Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(logText()) ? 'up' : null), 30_000);
  if (!up) {
    const why = lastProblem();
    stopTunnel();
    throw new Error(`The tunnel did not connect${why ? ` (${why})` : ''}.`);
  }
  return tunnelView();
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
