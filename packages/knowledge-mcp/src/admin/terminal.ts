/**
 * Commands the console's chat may run on this machine: one at a time, and each only after the person says yes.
 *
 * The person asks the chat for something a command does (install a skill, a font or a library, run a short
 * script). The model calls run_command with the command and a sentence on why. The console shows both, with the
 * folder it runs in, and waits: nothing runs until the person presses Run. Not answered in 15 minutes, declined,
 * or the conversation stopped: it does not run.
 *
 * What the person reads is what runs. A command with characters that change how it looks without being seen
 * (direction marks, zero-width and other format characters, control characters, line separators), or padded with
 * blank lines or long runs of spaces to push part of it out of sight, is refused before it is shown. The console
 * draws the command from what the server will run, not from what the model said.
 *
 * Who can reach it: the console's chat only. run_command is not one of the server's MCP tools, so an assistant
 * connected with a key never sees it, and the console itself answers this machine only (auth.ts). It runs with
 * the permissions of the account that started the server, in a folder of its own (data/workspace), with /bin/sh.
 *
 * What a command is given: a plain environment (PATH, HOME, the locale, the temp folder), not the server's: the
 * keys the server was started with are not in it. (An approved command can still read any file the account can,
 * the server's own .env among them: it is the person's own account.) It gets no input, and stops after 10 minutes.
 * What it starts in the background ends with it: its whole process group is stopped when it ends, is stopped, or
 * runs out of time, and when the server stops.
 *
 * Every command asked for is written to data/terminal.log as it happens: refused, asked, declined, started, ended.
 * Its output is not (it may hold what the command printed about the machine).
 *
 * KNOWLEDGE_TERMINAL=false turns it off: the chat is then not offered the tool.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../core/paths.js';
import type { ChatTool } from '../core/llm_chat.js';
import { skillsDir } from '../plugins/knowledge/skills.js';
import { fontsDir } from './fonts.js';
import { settingsDir } from '../core/config.js';
import { plainOutput } from '../core/plain_text.js';

export { plainOutput };

export const TERMINAL_TOOL = 'run_command';

export const terminalOn = (env: NodeJS.ProcessEnv = process.env): boolean => !['false', 'off', '0', 'no'].includes((env.KNOWLEDGE_TERMINAL ?? '').trim().toLowerCase());

/** Where commands run: a folder of their own beside the server's data, so what they leave is in one place. */
export const workspaceDir = (): string => join(dataDir(), 'workspace');

/** How long a command may wait for the person, and run. (Milliseconds; the environment can change them, for tests.) */
const askMs = () => Number(process.env.TERMINAL_ASK_MS) || 15 * 60_000;
const runMs = () => Number(process.env.TERMINAL_TIMEOUT_MS) || 10 * 60_000;
const MOST_COMMAND = 8_000;
const MOST_LINES = 60;
const MOST_WHY = 500;
/** What is kept of the output while it runs: its start and its end. */
const HEAD_CHARS = 20_000;
const TAIL_CHARS = 180_000;
/** What the model is given back: the start and the end, where errors and summaries are. */
const BACK_HEAD = 2_000;
const BACK_TAIL = 10_000;
/** Most characters of output sent to the page at once; it gets the whole of it in the result. */
const PAGE_CHARS = 16_000;
/** Commands running at once, over all conversations. */
const MOST_RUNNING = 2;
/** After the shell ends, how long what it left in the background may hold its output open. */
const LINGER_MS = 2_000;
/** After asking a command to stop, how long before it is made to. */
const KILL_AFTER_MS = 3_000;

export type CommandState = 'waiting' | 'running' | 'done' | 'declined';
/** A command as the console shows it. */
export interface CommandView {
  id: string;
  callId: string;
  command: string;
  why: string;
  cwd: string;
  state: CommandState;
  output: string;
  exit?: number | null;
  seconds?: number;
}
/** What the console is told while a command is asked for and runs (beside the chat's own events). */
export type TerminalEvent =
  | { type: 'approve'; id: string; callId: string; command: string; why: string; cwd: string }
  | { type: 'decided'; id: string; run: boolean }
  | { type: 'output'; id: string; text: string }
  | { type: 'ran'; id: string; exit: number | null; seconds: number };

interface Pending extends CommandView {
  chatId: string;
  decide?: (run: boolean) => void;
}
const commands = new Map<string, Pending>();

// ── What the person reads is what runs ──

/**
 * Characters that change how a command looks without being seen: direction marks and overrides, zero-width and
 * other format characters, control characters but a new line and a tab, the Unicode line and paragraph
 * separators, and the blank Hangul fillers.
 */
const HIDDEN = /[\u2028\u2029\u115f\u1160\u3164\uffa0]|(?![\n\t])[\p{Cc}\p{Cf}]/u;
/** Why a command cannot be shown as it is, or null. */
export function unreadable(command: string): string | null {
  const hidden = HIDDEN.exec(command);
  if (hidden) return `The command has a character that cannot be seen (U+${hidden[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}). Write it with visible characters only.`;
  const lines = command.split('\n');
  if (lines.length > MOST_LINES) return `The command has more than ${MOST_LINES} lines. Write a script file in one step and run it in the next.`;
  if (/\n[ \t]*\n[ \t]*\n/.test(command)) return 'The command has two or more blank lines in a row. Remove them.';
  if (/[ \t]{64,}/.test(command)) return 'The command has a long run of spaces. Remove it.';
  return null;
}

/** /bin/sh on macOS and Linux (not the person's own shell, which reads their start-up files and the keys in them); cmd on Windows. */
function shellFor(command: string): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform === 'win32') return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], verbatim: true };
  return { file: '/bin/sh', args: ['-c', command], verbatim: false };
}

/** What may pass from the server's environment to a command: where things are, never a key. */
const PASS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ',
  'NVM_DIR', 'PYENV_ROOT', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'HOMEBREW_PREFIX',
  // Windows
  'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData',
];
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of PASS) if (env[k] !== undefined) out[k] = env[k];
  return {
    ...out,
    // No terminal: plain output, and tools that would ask a question take the default or fail at once.
    TERM: 'dumb',
    NO_COLOR: '1',
    npm_config_yes: 'true',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    PIP_NO_INPUT: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    GIT_TERMINAL_PROMPT: '0',
    // Where this server looks for what a command may add.
    KNOWLEDGE_SKILLS_DIR: skillsDir(),
    KNOWLEDGE_FONTS_DIR: fontsDir(settingsDir()),
    KNOWLEDGE_WORKSPACE: workspaceDir(),
  };
}

/** The tool as the chat's model is offered it. */
export function terminalTool(): ChatTool {
  const sh = shellFor('').file;
  return {
    name: TERMINAL_TOOL,
    description: [
      `Run a shell command on the computer this server runs on (${process.platform}, ${sh}). The person sees the command and your reason, and it runs only if they approve it.`,
      'Use it to install a skill, a font or a library, or to run a short script the task needs. Not for reading documents: the other tools do that.',
      `It runs in ${workspaceDir()}. Skills go in ${skillsDir()} (one folder per skill, with SKILL.md), fonts (.ttf, .otf, .woff, .woff2) in ${fontsDir(settingsDir())}. The same places are in $KNOWLEDGE_SKILLS_DIR, $KNOWLEDGE_FONTS_DIR and $KNOWLEDGE_WORKSPACE.`,
      `Nothing can be typed into it: pass the flags that answer questions (-y, --yes). It is stopped after ${Math.round(runMs() / 60_000)} minutes, and what it starts in the background is stopped when it ends. The server's keys are not in its environment; never print or ask for a key or password.`,
      `One command per call, doing one step, in visible characters, at most ${MOST_LINES} lines. You get back its exit code and output.`,
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command, as it is typed in a terminal.' },
        why: { type: 'string', description: 'One sentence the person reads before approving: what it does and why the task needs it.' },
      },
      required: ['command', 'why'],
    },
  };
}

/** The commands of a conversation that wait for the person or run now: the console shows them when it is opened again. */
export function commandsOf(chatId: string): CommandView[] {
  return [...commands.values()].filter((c) => c.chatId === chatId && (c.state === 'waiting' || c.state === 'running')).map(view);
}
const view = (c: Pending): CommandView => ({ id: c.id, callId: c.callId, command: c.command, why: c.why, cwd: c.cwd, state: c.state, output: c.output.slice(-8_000), exit: c.exit, seconds: c.seconds });

/** The person's answer: run it or not. False when no command waits under that id. */
export function decide(id: string, run: boolean): boolean {
  const c = commands.get(id);
  if (!c || c.state !== 'waiting' || !c.decide) return false;
  c.decide(run);
  return true;
}

/** One line in data/terminal.log, written at once (synchronously: also while the server stops). */
function log(entry: Record<string, unknown>): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(join(dataDir(), 'terminal.log'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    /* the log is a record, not a condition for running */
  }
}

// ── Stopping a command and all it started ──

/** Send a signal to the command's process group: the shell and everything it started. True when it was sent. */
function signalGroup(child: ChildProcess, sig: NodeJS.Signals): boolean {
  if (!child.pid) return false;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
    return true;
  }
  try {
    process.kill(-child.pid, sig);
    return true;
  } catch {
    return false;
  }
}
/** Is anything of the group left (the shell may have ended, what it started not)? */
function groupAlive(child: ChildProcess): boolean {
  if (!child.pid) return false;
  if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** Ask the group to stop, and make it a few seconds later if any of it is left. */
function stopGroup(child: ChildProcess): void {
  signalGroup(child, 'SIGTERM');
  setTimeout(() => {
    if (groupAlive(child)) signalGroup(child, 'SIGKILL');
  }, KILL_AFTER_MS).unref();
}

/** Commands running now, with what they are: they end with the server, not after it. */
const running = new Map<ChildProcess, Pending>();
/** Stop every running command at once, as the server ends. Synchronous: it runs in an exit or signal handler. */
function endAll(because: string): void {
  for (const [child, c] of running) {
    if (process.platform === 'win32') {
      if (child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else signalGroup(child, 'SIGKILL');
    log({ id: c.id, chat: c.chatId, event: 'ended', because });
  }
  running.clear();
}
process.once('exit', () => endAll('the server stopped'));
/**
 * Ctrl+C, a service manager's stop, a closed terminal: Node ends without its exit handlers on these. While commands
 * run, they are caught here, the commands are stopped, and the signal goes on as if it had not been caught.
 */
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const hooks = new Map<NodeJS.Signals, () => void>();
function hook(): void {
  if (hooks.size) return;
  for (const sig of SIGNALS) {
    const onSignal = () => {
      endAll(`the server got ${sig}`);
      unhook();
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    hooks.set(sig, onSignal);
    process.on(sig, onSignal);
  }
}
function unhook(): void {
  for (const [sig, onSignal] of hooks) process.off(sig, onSignal);
  hooks.clear();
}

/**
 * run_command for one conversation: ask the person, wait, run, and say how it went. The text goes back to the
 * model; `ok` is whether it ran and ended with 0.
 */
export async function runCommand(
  input: Record<string, unknown>,
  ctx: { chatId: string; callId: string; signal: AbortSignal; say: (e: TerminalEvent) => void },
): Promise<{ ok: boolean; text: string }> {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  const why = (typeof input.why === 'string' ? input.why.replace(/\s+/g, ' ').trim() : '').slice(0, MOST_WHY);
  const refused = (text: string) => {
    log({ chat: ctx.chatId, event: 'refused', command: command.slice(0, MOST_COMMAND), why, because: text });
    return { ok: false, text };
  };
  if (!terminalOn()) return refused('Running commands is turned off on this server (KNOWLEDGE_TERMINAL=false).');
  if (!command) return refused('Give the command to run.');
  if (command.length > MOST_COMMAND) return refused(`The command is longer than ${MOST_COMMAND} characters. Write a script file in one step, and run it in the next.`);
  const hidden = unreadable(command) ?? (HIDDEN.test(why) ? 'The reason has a character that cannot be seen. Write it with visible characters only.' : null);
  if (hidden) return refused(hidden);
  if (!why) return refused('Say in `why` what the command does and why the task needs it: the person reads it before approving.');
  if (commandsOf(ctx.chatId).length) return refused('A command of this conversation is waiting or running already. Wait for it.');
  if (running.size >= MOST_RUNNING) return refused(`${MOST_RUNNING} commands are running already on this computer. Try again when they are done.`);
  if (ctx.signal.aborted) return refused('The conversation was stopped.');

  const cwd = workspaceDir();
  const c: Pending = { id: randomUUID(), callId: ctx.callId, chatId: ctx.chatId, command, why, cwd, state: 'waiting', output: '' };
  commands.set(c.id, c);
  try {
    // ── Ask ──
    log({ id: c.id, chat: ctx.chatId, event: 'asked', command, why });
    ctx.say({ type: 'approve', id: c.id, callId: c.callId, command, why, cwd });
    const answer = await new Promise<'run' | 'declined' | 'late' | 'stopped'>((resolve) => {
      // Whichever comes first: the person's answer, the time limit, or the conversation stopped.
      const finish = (how: 'run' | 'declined' | 'late' | 'stopped') => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        c.decide = undefined;
        resolve(how);
      };
      const timer = setTimeout(() => finish('late'), askMs());
      const onAbort = () => finish('stopped');
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      c.decide = (run) => finish(run ? 'run' : 'declined');
    });
    const busy = answer === 'run' && running.size >= MOST_RUNNING;
    if (answer !== 'run' || busy) {
      c.state = 'declined';
      ctx.say({ type: 'decided', id: c.id, run: false });
      log({ id: c.id, chat: ctx.chatId, event: 'declined', because: busy ? 'busy' : answer });
      return {
        ok: false,
        text: busy
          ? `${MOST_RUNNING} commands are running already on this computer. It was not run; try again when they are done.`
          : answer === 'declined'
            ? 'The person chose not to run it. Do not run it another way; ask what they want instead.'
            : answer === 'late'
              ? `No one approved it within ${Math.round(askMs() / 60_000)} minutes, so it was not run.`
              : 'The conversation was stopped, so it was not run.',
      };
    }

    // ── Run ──
    c.state = 'running';
    ctx.say({ type: 'decided', id: c.id, run: true });
    mkdirSync(cwd, { recursive: true });
    const started = Date.now();
    const sh = shellFor(command);
    const child = spawn(sh.file, sh.args, {
      cwd,
      env: commandEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so that it and all it starts can be stopped together.
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: sh.verbatim,
      windowsHide: true,
    });
    running.set(child, c);
    hook();
    log({ id: c.id, chat: ctx.chatId, event: 'started', pid: child.pid ?? null });
    let head = '';
    let tail = '';
    let cut = 0;
    let pending = '';
    let flush: NodeJS.Timeout | null = null;
    const toPage = () => {
      flush = null;
      // A page is sent the end of what came since the last time, not all of it: the result has the whole.
      const text = pending.length > PAGE_CHARS ? `… [${pending.length - PAGE_CHARS} characters not shown]\n${pending.slice(-PAGE_CHARS)}` : pending;
      pending = '';
      ctx.say({ type: 'output', id: c.id, text });
    };
    const take = (raw: string) => {
      const text = plainOutput(raw);
      if (!text) return;
      if (head.length < HEAD_CHARS) {
        const room = HEAD_CHARS - head.length;
        head += text.slice(0, room);
        tail += text.slice(room);
      } else tail += text;
      if (tail.length > TAIL_CHARS) {
        cut += tail.length - TAIL_CHARS;
        tail = tail.slice(-TAIL_CHARS);
      }
      c.output = head + (cut ? `\n… [${cut} characters left out]\n` : '') + tail;
      pending = (pending + text).slice(-(PAGE_CHARS * 2));
      // To the page a few times a second, not once per chunk.
      flush ??= setTimeout(toPage, 150);
    };
    // Text, not bytes: a character split between two chunks is put together again.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const stop = () => stopGroup(child);
    ctx.signal.addEventListener('abort', stop, { once: true });
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      stop();
    }, runMs());
    const exit = await new Promise<number | null>((resolve) => {
      let code: number | null = null;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve(code);
      };
      child.on('error', (e) => {
        take(`${e.message}\n`);
        settle();
      });
      child.on('exit', (exitCode) => {
        code = exitCode;
        // What the shell left in the background may hold its output open: a moment to finish, then it is stopped.
        setTimeout(() => {
          if (settled) return;
          signalGroup(child, 'SIGKILL');
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle();
        }, LINGER_MS).unref();
      });
      child.on('close', (closeCode) => {
        code ??= closeCode;
        settle();
      });
    });
    // Nothing it started outlives it.
    if (groupAlive(child)) stopGroup(child);
    running.delete(child);
    if (!running.size) unhook();
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', stop);
    if (flush) {
      clearTimeout(flush);
      toPage();
    }
    const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
    Object.assign(c, { state: 'done' as const, exit, seconds });
    ctx.say({ type: 'ran', id: c.id, exit, seconds });
    log({ id: c.id, chat: ctx.chatId, event: 'ended', exit, seconds, ...(late ? { because: 'time limit' } : ctx.signal.aborted ? { because: 'stopped' } : {}) });

    const out = c.output;
    const back = out.length > BACK_HEAD + BACK_TAIL ? `${out.slice(0, BACK_HEAD)}\n… [${out.length - BACK_HEAD - BACK_TAIL} characters left out]\n${out.slice(-BACK_TAIL)}` : out;
    const how = late
      ? `It was stopped after ${Math.round(runMs() / 60_000)} minutes, the most a command may run.`
      : ctx.signal.aborted
        ? 'It was stopped: the person stopped the conversation.'
        : `It ended with exit code ${exit ?? 'none (it could not start, or was killed)'} after ${seconds} s.`;
    return { ok: exit === 0 && !late, text: `${how}\n\nOutput:\n${back.trim() || '(nothing)'}` };
  } finally {
    commands.delete(c.id);
  }
}
