/**
 * The start of `serve` on a person's machine: become the supervisor (see supervisor.ts) and open the console.
 *
 * Kept apart from run.ts and free of everything the server needs (plugins, store, transports), so the binary can
 * decide to supervise before any of that is loaded. A supervisor only waits for its child: loaded with the whole
 * server it held about 120 MB for that, without it about 50.
 */
import '../bootstrap.js'; // .env first: whether to supervise and whether there is a console may be set there
import { spawn } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../core/paths.js';
import { shouldSupervise, supervise } from './supervisor.js';

const info = (s: string): void => void process.stderr.write(`${s}\n`);

/** Is this `serve` an HTTP server (not a stdio session)? */
export function servesHttp(argv: string[]): boolean {
  return !argv.includes('--stdio') && (process.env.MCP_TRANSPORT || 'http').toLowerCase() !== 'stdio';
}

/**
 * Open the console in the browser of the person who runs the server. Best effort: a missing opener is not an error.
 *
 * What is opened is never the address with the console token: it is the one-time address of the server (see
 * routes.ts, /console/open). And where other users of the machine can read command lines (`ps`), even that address
 * is kept off the command line, since whoever asks for it first gets the console:
 *   macOS    the address goes to osascript on its input, not as an argument
 *   Linux    a page only the owner can read (in the data directory) sends the browser on
 *   Windows  a command line, which other users cannot read there
 */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  try {
    if (platform === 'darwin') {
      const child = spawn('osascript', [], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
      child.on('error', () => {});
      child.stdin?.on('error', () => {});
      child.stdin?.end(`open location "${url.replace(/[\\"]/g, '')}"\n`);
      child.unref();
      return;
    }
    if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
      return;
    }
    const page = join(dataDir(), 'console-open.html');
    const safe = url.replace(/[<>"']/g, '');
    writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>Knowledge MCP</title><meta http-equiv="refresh" content="0;url=${safe}"><p><a href="${safe}">Open the console</a></p>\n`, { mode: 0o600 });
    chmodSync(page, 0o600);
    // The address in it works once and for two minutes: the page has no use after that.
    setTimeout(() => rmSync(page, { force: true }), 120_000).unref();
    spawn('xdg-open', [page], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* no browser to open */
  }
}

/**
 * Run the HTTP server under the supervisor, so a change saved in the console takes effect by itself.
 * `open`: also open the console in the browser the first time the server is up.
 */
export async function serveSupervised(open: boolean): Promise<never> {
  return supervise(({ port, consoleUrl, openUrl }, first) => {
    if (!consoleUrl) return;
    // After every start, not only the first: a restart pushes the earlier line out of sight, and this is the line
    // a person looks for. The address carries the access token, so it goes to a terminal only, never into a log file.
    if (process.stderr.isTTY) info(`[knowledge-mcp] console · ${consoleUrl}`);
    else info(`[knowledge-mcp] console · http://localhost:${port}/console/ (the access token is in the data directory, file console-token)`);
    if (first && open && openUrl && process.stderr.isTTY && !process.env.CI) openInBrowser(openUrl);
  });
}

/**
 * Given the command line: when it starts an HTTP server on a person's machine, supervise it and never return.
 * Started with no arguments at all, the console is opened in the browser as well. Otherwise returns at once.
 */
export async function superviseIfServing(argv: string[]): Promise<void> {
  const [cmd = 'serve', ...rest] = argv;
  if (cmd === 'serve' && servesHttp(rest) && shouldSupervise()) await serveSupervised(argv.length === 0 || rest.includes('--open'));
}
