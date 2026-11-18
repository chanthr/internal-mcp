/**
 * The start of `serve` on a person's machine: become the supervisor (see supervisor.ts) and open the console.
 *
 * Kept apart from run.ts and free of everything the server needs (plugins, store, transports), so the binary can
 * decide to supervise before any of that is loaded. A supervisor only waits for its child: loaded with the whole
 * server it held about 120 MB for that, without it about 50.
 */
import '../bootstrap.js'; // .env first: whether to supervise and whether there is a console may be set there
import { spawn } from 'node:child_process';
import { shouldSupervise, supervise } from './supervisor.js';

const info = (s: string): void => void process.stderr.write(`${s}\n`);

/** Is this `serve` an HTTP server (not a stdio session)? */
export function servesHttp(argv: string[]): boolean {
  return !argv.includes('--stdio') && (process.env.MCP_TRANSPORT || 'http').toLowerCase() !== 'stdio';
}

/**
 * Open a page in the person's browser. Best effort: a missing opener is not an error.
 * A command line is visible to every user of the machine (`ps`), so what is opened is never the address with the
 * console token: it is the one-time address of the server (see routes.ts, /console/open).
 */
function openInBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
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
    if (!consoleUrl || !first) return;
    // The address carries the access token, so it is printed only to a terminal, never into a log file.
    if (process.stderr.isTTY) info(`[knowledge-mcp] console · ${consoleUrl}`);
    else info(`[knowledge-mcp] console · http://localhost:${port}/console/ (the access token is in the data directory, file console-token)`);
    if (open && openUrl && process.stderr.isTTY && !process.env.CI) openInBrowser(openUrl);
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
