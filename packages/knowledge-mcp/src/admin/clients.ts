/**
 * Adding this server to the AI clients on this machine, in one step.
 *
 * Each client keeps its list of MCP servers its own way. Where the client offers a way in, that way is used:
 *
 *   Claude Code      its command line                 claude mcp add --scope user …
 *   VS Code          its command line                 code --add-mcp '{…}'
 *   Cursor           its install link                 cursor://anysphere.cursor-deeplink/mcp/install?… (Cursor asks first)
 *   Claude Desktop   its config file (no other way)   one entry merged into claude_desktop_config.json
 *
 * Nothing here takes input from a request except which client: the entry is made from this server's own folder and
 * name. A config file is changed only by adding or replacing the entry under this server's name; what else is in
 * it stays, a copy of the file as it was is kept next to it, and a file that is not valid JSON is left alone.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { installPackage, shellQuote, type PackageInstall } from '../core/invocation.js';
import type { SyncExec } from '../setup/auto.js';
import { lastLine } from './cli_runs.js';

/** How a client starts this server over stdio. */
export interface Entry {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** The copy of the server the entry runs, when it has to be installed first (core/invocation.ts stdioEntry). */
  install?: PackageInstall;
}

export const CLIENT_IDS = ['claude-code', 'claude-desktop', 'cursor', 'vscode'] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

export interface ClientView {
  id: ClientId;
  name: string;
  /** Is the client on this machine? */
  installed: boolean;
  /** Is this server in its list? null when that cannot be told from outside. */
  added: boolean | null;
  /** What "Add" does: run the client's command, write its file, or hand its own install link to the browser. */
  how: 'command' | 'file' | 'link';
  /** One sentence for the person, before they click. */
  does: string;
  link?: string;
  /** What to do afterwards so the client picks it up. */
  after: string;
  /** The same thing by hand. */
  manual: { text: string; language: 'bash' | 'json'; file?: string };
}

export interface ClientContext {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exec: SyncExec;
}

/** Commands of other programs get a short time: a click must not hold the server for minutes. */
const quickExec: SyncExec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000 });
  if (r.error) return { status: 127, stdout: '', stderr: r.error.message };
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

export const systemContext = (): ClientContext => ({ home: homedir(), platform: process.platform, env: process.env, exec: quickExec });

/** Is a program of this name on the PATH? (Looked up, not run: some of these open a window when run.) */
function onPath(name: string, ctx: ClientContext): boolean {
  const exts = ctx.platform === 'win32' ? (ctx.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (ctx.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try {
        if (statSync(join(dir, name + ext)).isFile()) return true;
      } catch {
        /* not here */
      }
    }
  }
  return false;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** A JSON file as an object: its value, `null` when there is no file, or 'broken' when it is not a JSON object. */
function readJsonFile(path: string): Json | null | 'broken' {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf8');
    if (!text.trim()) return {};
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : 'broken';
  } catch {
    return 'broken';
  }
}

const has = (file: Json | null | 'broken', key: string, name: string): boolean | null => {
  if (file === 'broken') return null;
  const list = file?.[key];
  return isObject(list) && name in list;
};

export function claudeDesktopConfig(ctx: ClientContext): string {
  if (ctx.platform === 'darwin') return join(ctx.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (ctx.platform === 'win32') return join(ctx.env.APPDATA?.trim() || join(ctx.home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return join(ctx.env.XDG_CONFIG_HOME?.trim() || join(ctx.home, '.config'), 'Claude', 'claude_desktop_config.json');
}

function vscodeUserConfig(ctx: ClientContext): string {
  if (ctx.platform === 'darwin') return join(ctx.home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  if (ctx.platform === 'win32') return join(ctx.env.APPDATA?.trim() || join(ctx.home, 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json');
  return join(ctx.env.XDG_CONFIG_HOME?.trim() || join(ctx.home, '.config'), 'Code', 'User', 'mcp.json');
}

const server = (e: Entry) => ({ command: e.command, args: e.args, ...(e.env ? { env: e.env } : {}) });
const envFlags = (e: Entry) => Object.entries(e.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
const claudeAddArgs = (e: Entry) => ['mcp', 'add', '--scope', 'user', e.name, ...envFlags(e), '--', e.command, ...e.args];
const vscodeJson = (e: Entry) => JSON.stringify({ name: e.name, type: 'stdio', ...server(e) });

/** Cursor's own install link: the entry as base64 JSON. Cursor shows it and asks before adding. */
export function cursorLink(e: Entry): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(e.name)}&config=${encodeURIComponent(Buffer.from(JSON.stringify(server(e))).toString('base64'))}`;
}

/** Every client: is it here, is this server in it, and what adding it would do. */
export function describeClients(entry: Entry, ctx: ClientContext = systemContext()): ClientView[] {
  const desktop = claudeDesktopConfig(ctx);
  const cursorFile = join(ctx.home, '.cursor', 'mcp.json');
  const windows = ctx.platform === 'win32';
  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      // On Windows the command is a .cmd file, which needs a shell to run: shown, not run.
      installed: !windows && onPath('claude', ctx),
      added: has(readJsonFile(join(ctx.home, '.claude.json')), 'mcpServers', entry.name),
      how: 'command',
      does: 'Runs `claude mcp add` for you, for every project of yours.',
      after: 'Start a new Claude Code session.',
      manual: { text: ['claude', ...claudeAddArgs(entry)].map(shellQuote).join(' '), language: 'bash' },
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      installed: existsSync(dirname(desktop)),
      added: has(readJsonFile(desktop), 'mcpServers', entry.name),
      how: 'file',
      does: 'Adds one entry to claude_desktop_config.json. The rest of the file stays, and a copy of it as it was is kept next to it.',
      after: 'Quit Claude Desktop and open it again.',
      manual: { text: JSON.stringify({ mcpServers: { [entry.name]: server(entry) } }, null, 2), language: 'json', file: desktop },
    },
    {
      id: 'cursor',
      name: 'Cursor',
      installed: existsSync(join(ctx.home, '.cursor')),
      added: has(readJsonFile(cursorFile), 'mcpServers', entry.name),
      how: 'link',
      does: 'Opens Cursor, which shows the entry and asks before it adds it.',
      link: cursorLink(entry),
      after: 'Confirm in Cursor.',
      manual: { text: JSON.stringify({ mcpServers: { [entry.name]: server(entry) } }, null, 2), language: 'json', file: cursorFile },
    },
    {
      id: 'vscode',
      name: 'VS Code',
      installed: !windows && onPath('code', ctx),
      added: existsSync(vscodeUserConfig(ctx)) ? has(readJsonFile(vscodeUserConfig(ctx)), 'servers', entry.name) : null,
      how: 'command',
      does: 'Runs `code --add-mcp` for you, for your VS Code profile.',
      after: 'Open the chat in VS Code: the server is in its tools list.',
      manual: { text: `code --add-mcp ${shellQuote(vscodeJson(entry))}`, language: 'bash' },
    },
  ];
}

/**
 * Install the copy of the server an entry runs, when it needs one, before the entry is given to a client. Returns a
 * sentence when something was installed. Throws with npm's last line when it could not be.
 */
export async function installForEntry(entry: Entry, install: typeof installPackage = installPackage): Promise<string | null> {
  if (!entry.install) return null;
  const r = await install(entry.install);
  if (!r.ok) throw new Error(`Installing ${entry.install.spec} into ${entry.install.prefix} did not work: ${lastLine(r.output) || 'npm ended with an error'}`);
  return `Installed ${entry.install.spec} into ${entry.install.prefix}.`;
}

const said = (r: { stdout: string; stderr: string }) => (r.stderr.trim() || r.stdout.trim()).split('\n').slice(-3).join(' ').slice(0, 300);

/** Add this server to one client. Returns what was done, in a sentence. Throws with a sentence when it could not. */
export function addToClient(id: ClientId, entry: Entry, ctx: ClientContext = systemContext()): string {
  const view = describeClients(entry, ctx).find((c) => c.id === id)!;
  if (id === 'cursor') throw new Error('Cursor adds a server itself: use the link.');
  if (!view.installed) throw new Error(`${view.name} was not found on this machine. Add the entry by hand once it is installed.`);

  if (id === 'claude-code') {
    // The same name again is an error for `claude mcp add`: an entry of ours that is already there is replaced.
    if (view.added) ctx.exec('claude', ['mcp', 'remove', '--scope', 'user', entry.name]);
    const r = ctx.exec('claude', claudeAddArgs(entry));
    if (r.status !== 0) throw new Error(`\`claude mcp add\` did not work: ${said(r) || `exit ${r.status}`}`);
    return `Added to Claude Code as "${entry.name}". ${view.after}`;
  }

  if (id === 'vscode') {
    const r = ctx.exec('code', ['--add-mcp', vscodeJson(entry)]);
    if (r.status !== 0) throw new Error(`\`code --add-mcp\` did not work: ${said(r) || `exit ${r.status}`}`);
    return `Added to VS Code as "${entry.name}". ${view.after}`;
  }

  // Claude Desktop: its file is the only way in.
  const path = claudeDesktopConfig(ctx);
  const current = readJsonFile(path);
  if (current === 'broken') throw new Error(`${path} is not valid JSON, so it was left alone. Fix it (or move it away) and try again.`);
  const servers = current?.mcpServers;
  if (servers !== undefined && !isObject(servers)) throw new Error(`"mcpServers" in ${path} is not an object, so the file was left alone.`);
  const next = { ...(current ?? {}), mcpServers: { ...(isObject(servers) ? servers : {}), [entry.name]: server(entry) } };
  mkdirSync(dirname(path), { recursive: true });
  if (current) copyFileSync(path, `${path}.before-${entry.name}`);
  // Written beside the file and moved over it, so the client never reads half a file.
  const draft = `${path}.${process.pid}.tmp`;
  writeFileSync(draft, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(draft, path);
  return `Added to Claude Desktop as "${entry.name}". ${view.after}`;
}
