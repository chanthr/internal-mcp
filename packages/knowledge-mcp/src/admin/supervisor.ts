/**
 * Restarting the server when its settings change.
 *
 * Settings are read when the process starts: the config file once, and many modules read their env vars while they
 * load. Making all of that reloadable in place would touch every plugin. Starting again is simple and always
 * right, so that is what a saved change does: the server runs as the child of a small supervisor, and when the
 * console saves something the child exits with a code that means "start me again".
 *
 *   knowledge-mcp serve            supervisor
 *     └─ knowledge-mcp serve       the server (KMCP_SUPERVISED=1)
 *
 * The child is started with the environment the supervisor itself was given, before any .env file was read, so a
 * changed .env takes effect. The two are joined by an IPC channel: when the supervisor goes away, however it dies,
 * the channel closes and the child stops instead of holding the port as an orphan.
 *
 * Only used where the console is: an HTTP server a person started in a terminal. A stdio session reads its settings
 * when it starts anyway, and a deployment is restarted by its platform.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { ORIGINAL_ENV } from '../bootstrap.js';
import { consoleEnabled } from './auth.js';

/** Exit code of a server that wants to be started again. */
export const RELOAD_EXIT_CODE = 75;

const isChild = () => process.env.KMCP_SUPERVISED === '1';

/**
 * Should this `serve` process become a supervisor instead of serving itself?
 * By default only when a person started it in a terminal. A container, a service manager and a test start it
 * without one: there the platform restarts processes, and the server runs as it always did.
 * KMCP_SUPERVISE=true or false decides it outright.
 */
export function shouldSupervise(): boolean {
  if (isChild() || !consoleEnabled()) return false;
  const forced = process.env.KMCP_SUPERVISE?.trim().toLowerCase();
  if (forced === 'true') return true;
  if (forced === 'false') return false;
  return !!(process.stdout.isTTY || process.stderr.isTTY);
}

/** In the server: can a restart be asked for? */
export function canReload(): boolean {
  return isChild() && typeof process.send === 'function';
}

/** In the server: stop when the supervisor is gone. Call once at start. */
export function followSupervisor(): void {
  if (!canReload()) return;
  process.on('disconnect', () => process.exit(0));
}

/** In the server: tell the supervisor that the port is open (it prints the console address once). */
export function reportReady(info: { port: number; consoleUrl: string | null }): void {
  if (canReload()) process.send!({ type: 'ready', ...info });
}

/**
 * In the server: start again with the new settings. Returns false when nothing supervises this process (then the
 * person restarts it). The exit is delayed a moment so the answer to the request that asked for it gets out.
 */
export function requestReload(): boolean {
  if (!canReload()) return false;
  setTimeout(() => process.exit(RELOAD_EXIT_CODE), 150).unref();
  return true;
}

/** Become the supervisor: run the server as a child and start it again whenever it asks. Never returns. */
export async function supervise(onReady: (info: { port: number; consoleUrl: string | null }, first: boolean) => void): Promise<never> {
  let child: ChildProcess | null = null;
  let stopping = false;
  let starts = 0;
  const recent: number[] = [];

  const forward = (signal: NodeJS.Signals) => {
    stopping = true;
    if (child && child.exitCode === null) child.kill(signal);
    else process.exit(0);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  for (;;) {
    const first = starts === 0;
    starts++;
    const code = await new Promise<number>((resolve) => {
      child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: { ...ORIGINAL_ENV, KMCP_SUPERVISED: '1' },
      });
      child.on('message', (m: { type?: string; port?: number; consoleUrl?: string | null }) => {
        if (m?.type === 'ready' && typeof m.port === 'number') onReady({ port: m.port, consoleUrl: m.consoleUrl ?? null }, first);
      });
      child.on('error', (e) => {
        console.error(`[knowledge-mcp] could not start the server: ${e.message}`);
        resolve(1);
      });
      child.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0)));
    });
    if (stopping || code !== RELOAD_EXIT_CODE) process.exit(code === RELOAD_EXIT_CODE ? 0 : code);
    // A server that asks to be restarted over and over is broken settings, not a change: stop rather than spin.
    const now = Date.now();
    recent.push(now);
    while (recent.length && now - recent[0] > 10_000) recent.shift();
    if (recent.length > 8) {
      console.error('[knowledge-mcp] the server asked to restart 8 times in 10 seconds; stopping.');
      process.exit(1);
    }
    console.error('[knowledge-mcp] settings changed, starting again');
  }
}
