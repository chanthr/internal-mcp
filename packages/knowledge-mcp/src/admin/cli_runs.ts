/**
 * A command-line tool this server leans on, looked after from the console: installing it and signing it in.
 *
 * Two ways to connect use a tool that is signed in on this machine: gcloud (it makes the Drive service account)
 * and gh (its login is reused for GitHub). The console used to say "go to a terminal and type …" when the tool
 * was missing, signed out, or asked to sign in again. It runs that one command itself instead:
 *
 *   install   the machine's package manager installs the tool (Homebrew, or winget on Windows)
 *   sign-in   the tool's own sign-in: gcloud opens the browser, gh gives a code to type at github.com
 *
 * The page waits and shows how far the command is. What is run is fixed: one command per tool and step, and no
 * part of it comes from the request. This is not a terminal. The tool keeps what it gets (its own login, where it
 * always keeps it); this server reads none of it here.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { backgroundExec, hasTool, type Exec } from '../setup/auto.js';

export type CliTool = 'gcloud' | 'gh';
export type CliAction = 'install' | 'sign-in';
export const CLI_TOOLS: readonly CliTool[] = ['gcloud', 'gh'];
export const CLI_ACTIONS: readonly CliAction[] = ['install', 'sign-in'];

/** The tool's own instructions, for a machine this cannot install on. */
const PAGE: Record<CliTool, string> = { gcloud: 'https://cloud.google.com/sdk/docs/install', gh: 'https://cli.github.com/' };

const SIGN_IN: Record<CliTool, string[]> = {
  // gcloud opens the browser by itself and listens for the answer. --quiet: it never waits for a reply on a
  // terminal, because here there is none.
  gcloud: ['gcloud', 'auth', 'login', '--brief', '--quiet'],
  // Without a terminal gh prints a one-time code and the address to type it at, and waits for GitHub.
  gh: ['gh', 'auth', 'login', '--hostname', 'github.com', '--web'],
};

/**
 * The command that installs the tool on this machine, or null when it has no package manager this knows.
 * Homebrew where it is (macOS, and Linux for gh; the gcloud cask is for macOS), winget on Windows.
 */
export async function installCommand(tool: CliTool, exec: Exec = backgroundExec, platform: NodeJS.Platform = process.platform): Promise<string[] | null> {
  if (platform === 'win32') {
    if (!(await hasTool(exec, 'winget'))) return null;
    return ['winget', 'install', '--id', tool === 'gh' ? 'GitHub.cli' : 'Google.CloudSDK', '-e', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements'];
  }
  if (!(await hasTool(exec, 'brew'))) return null;
  if (tool === 'gh') return ['brew', 'install', 'gh'];
  return platform === 'darwin' ? ['brew', 'install', '--cask', 'gcloud-cli'] : null;
}

/** How long a step gets. One left open does not keep a process (and gcloud's port) for ever. */
const LIMIT_MS: Record<CliAction, number> = { 'install': 20 * 60_000, 'sign-in': 5 * 60_000 };
const TOO_LONG: Record<CliAction, string> = {
  'install': 'The install did not finish in twenty minutes and was stopped.',
  'sign-in': 'The sign-in was not finished in five minutes. Nothing was changed.',
};

export interface CliRun {
  running: boolean;
  /** sign-in: where it happens, once the tool has said. gcloud's page (it opens it too), or GitHub's page for the code. */
  url: string | null;
  /** gh sign-in: the one-time code to type there. */
  code: string | null;
  /** The last thing the tool said: how far an install is. */
  line: string | null;
  /** How it ended. null while it runs, and before any was started. */
  ok: boolean | null;
  error: string | null;
}
const NONE: CliRun = { running: false, url: null, code: null, line: null, ok: null, error: null };

interface Run {
  action: CliAction;
  child: ChildProcess | null;
  output: string;
  ended: { ok: boolean; error: string | null } | null;
  timer: NodeJS.Timeout | null;
}
const runs = new Map<string, Run>();
const key = (tool: CliTool, action: CliAction) => `${tool} ${action}`;

/** The tools print in colour for a terminal. Asked not to, some still do. Progress bars rewrite their line with \r. */
const plain = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[^\n]*\r(?!\n)/g, '');
const lastLine = (text: string): string => plain(text).split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

function view(run: Run | undefined): CliRun {
  if (!run) return NONE;
  const text = plain(run.output);
  const going = !run.ended;
  const signIn = going && run.action === 'sign-in';
  return {
    running: going,
    // Only an https address is handed to the page as a link.
    url: signIn ? (/https:\/\/[^\s'"<>]+/.exec(text)?.[0] ?? null) : null,
    code: signIn ? (/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/i.exec(text)?.[1] ?? null) : null,
    line: going && run.action === 'install' ? lastLine(text).slice(0, 160) || null : null,
    ok: run.ended?.ok ?? null,
    error: run.ended?.error ?? null,
  };
}

export function cliRun(tool: CliTool, action: CliAction): CliRun {
  return view(runs.get(key(tool, action)));
}

/** What installing would run here, in words for the page, and where the tool's own instructions are. */
export async function installPlan(tool: CliTool): Promise<{ command: string | null; page: string }> {
  const command = await installCommand(tool);
  return { command: command ? command.slice(0, command[0] === 'winget' ? 4 : command.length).join(' ') : null, page: PAGE[tool] };
}

function stop(run: Run): void {
  if (run.timer) clearTimeout(run.timer);
  run.timer = null;
  if (run.child && run.child.exitCode === null) run.child.kill();
}

/** Start the step, or say how far the one that is running has come. Throws when this machine cannot do it. */
export async function startCliRun(tool: CliTool, action: CliAction): Promise<CliRun> {
  const running = runs.get(key(tool, action));
  if (running && !running.ended) return view(running);

  const command = action === 'install' ? await installCommand(tool) : SIGN_IN[tool];
  if (!command) throw new Error(`This machine has no package manager the console can use (Homebrew, or winget on Windows). Install ${tool} from ${PAGE[tool]}, then look again.`);
  const [cmd, ...args] = command;
  const run: Run = { action, child: null, output: '', ended: null, timer: null };
  runs.set(key(tool, action), run);
  const end = (ok: boolean, error: string | null) => {
    if (run.ended) return;
    run.ended = { ok, error };
    stop(run);
  };
  try {
    // No terminal and no input: a tool that asks a question gets no answer and says so, instead of waiting.
    run.child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', CLOUDSDK_CORE_DISABLE_PROMPTS: '1', NONINTERACTIVE: '1', HOMEBREW_NO_ENV_HINTS: '1' },
    });
  } catch (e) {
    end(false, `${cmd} could not be started (${e instanceof Error ? e.message : String(e)}).`);
    return view(run);
  }
  const take = (chunk: Buffer) => {
    // Enough for the address and the last lines; a tool that talks without end does not fill the memory.
    run.output = (run.output + chunk.toString('utf8')).slice(-16_000);
  };
  run.child.stdout?.on('data', take);
  run.child.stderr?.on('data', take);
  run.child.on('error', (e) => end(false, (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${cmd} is not installed on this machine.` : `${cmd} could not be started (${e.message}).`));
  run.child.on('exit', (code) => end(code === 0, code === 0 ? null : lastLine(run.output).slice(0, 240) || `${cmd} ended with an error.`));
  run.timer = setTimeout(() => end(false, TOO_LONG[action]), LIMIT_MS[action]);
  run.timer.unref?.();
  return view(run);
}

/** The person gave up, or closed the dialog: the command is stopped and nothing is remembered about the try. */
export function cancelCliRun(tool: CliTool, action: CliAction): void {
  const run = runs.get(key(tool, action));
  if (!run) return;
  if (!run.ended) run.ended = { ok: false, error: null };
  stop(run);
  runs.delete(key(tool, action));
}

// A step that is still waiting when the server stops (a restart after a saved change) would stay behind, holding
// gcloud's port for the next try.
process.once('exit', () => {
  for (const run of runs.values()) stop(run);
});
