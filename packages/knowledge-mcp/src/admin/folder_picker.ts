/**
 * The computer's own folder chooser, opened from the console.
 *
 * A browser can let a page read the files of a folder, but never tell it where the folder is: choosing a folder
 * on a page uploads every file in it, and the browser first asks "Upload N files to this site?". The server runs on
 * this same computer, so it can open the system's chooser instead (Finder's on macOS) and add the folder where it
 * is: nothing is copied, nothing asks, and later edits to the files are followed.
 *
 *   macOS     osascript's "choose folder"
 *   Windows   the folder browser of Windows Forms, through PowerShell
 *   Linux     zenity, or kdialog
 *
 * What runs is fixed: no part of a request goes into the command. One chooser is open at a time.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { backgroundExec, hasTool, type Exec } from '../setup/auto.js';

const PROMPT = 'Choose a folder of documents for Knowledge MCP to search';
/** A chooser left open does not keep a process for ever. */
const LIMIT_MS = 10 * 60_000;

export type Picked = { path: string } | { canceled: true };

/** The command that opens the chooser here, or null when this computer has none this knows. */
export async function chooserCommand(exec: Exec = backgroundExec, platform: NodeJS.Platform = process.platform): Promise<string[] | null> {
  if (platform === 'darwin') {
    // "activate" brings the chooser in front of the browser. The path comes back with a trailing slash.
    return ['osascript', '-e', 'activate', '-e', `POSIX path of (choose folder with prompt "${PROMPT}" default location (path to home folder))`];
  }
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}',
      `$d = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{Description = '${PROMPT}'; ShowNewFolderButton = $false}`,
      "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $d.SelectedPath }",
    ].join('; ');
    return ['powershell', '-NoProfile', '-STA', '-Command', script];
  }
  if (await hasTool(exec, 'zenity')) return ['zenity', '--file-selection', '--directory', `--title=${PROMPT}`, `--filename=${homedir()}/`];
  if (await hasTool(exec, 'kdialog')) return ['kdialog', '--getexistingdirectory', homedir(), '--title', PROMPT];
  return null;
}

let open: Promise<Picked> | null = null;

/**
 * Open the chooser and wait for the person. Resolves with the folder, or `canceled` when they closed it. Throws
 * when this computer has no chooser, or it could not be shown (a server with no screen, reached over SSH).
 */
export function pickFolder(): Promise<Picked> {
  if (open) return open;
  open = (async (): Promise<Picked> => {
    const command = await chooserCommand();
    if (!command) throw new Error('This computer has no folder chooser the console can open. Type the folder path instead.');
    const [cmd, ...args] = command;
    return new Promise<Picked>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
      const timer = setTimeout(() => child.kill(), LIMIT_MS);
      timer.unref?.();
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`The folder chooser could not be opened (${e.message}). Type the folder path instead.`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const path = out.trim().split(/\r?\n/).pop()?.trim() ?? '';
        if (code === 0 && path) return resolve({ path: path.length > 1 ? path.replace(/[\\/]+$/, '') : path });
        // Closing the chooser: osascript says "User canceled. (-128)", the others end with nothing.
        if (code === 0 || /-128|cancel/i.test(err) || (code === 1 && !err.trim())) return resolve({ canceled: true });
        reject(new Error(`The folder chooser could not be shown${err.trim() ? ` (${err.trim().split('\n').pop()!.slice(0, 200)})` : ''}. Type the folder path instead.`));
      });
    });
  })().finally(() => {
    open = null;
  });
  return open;
}

let known: boolean | null = null;
/** Can the console offer the chooser? Asked once: the answer does not change while the server runs. */
export async function canPickFolder(): Promise<boolean> {
  if (known === null) known = (await chooserCommand()) !== null;
  return known;
}
