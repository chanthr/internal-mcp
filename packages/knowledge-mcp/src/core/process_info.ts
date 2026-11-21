/**
 * What the system says about a process, by its id: the command it runs and when it started.
 *
 * A process id is only a number, and the system hands it out again once its process is gone. After a crash or a
 * restart, the id written down for a lock or for cloudflared can belong to any other program, and a check that
 * only asks "is there a process with this id?" takes that program for the one written down. The command tells the
 * two apart by what they are, and the start time by when they began: the process that wrote something down was
 * running when it wrote it, so a process that started later is not that one.
 *
 * Linux answers from /proc, macOS and the other Unix systems from ps, and Windows from tasklist (the program's
 * name only, without a start time).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface ProcessInfo {
  /** The command line: the program and its arguments, separated by spaces. On Windows, the program's name. */
  command: string;
  /** When it started, in milliseconds since 1970, to the second. Null when the system does not say. */
  startedAt: number | null;
}

/** The process with this id, or null when there is none, or when the system could not be asked. */
export function processInfo(pid: number, platform: NodeJS.Platform = process.platform): ProcessInfo | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') return fromProc(pid);
    if (platform === 'win32') return fromTasklist(pid);
    return fromPs(pid);
  } catch {
    return null;
  }
}

// Linux counts a process's start in clock ticks since the machine booted, 100 to the second on every architecture
// Node runs on (USER_HZ), and /proc/stat says when it booted.
function fromProc(pid: number): ProcessInfo | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // The program's name is in brackets and may hold spaces and brackets of its own, so the fields are counted from
  // the last closing bracket: the state is field 3, and the start time field 22.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(fields[19]);
  const booted = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
  let command = '';
  try {
    command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    /* a process of another user may hide its command line */
  }
  // A process without a command line (a kernel thread, one that is exiting) still has its name in the brackets.
  if (!command) command = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
  return { command, startedAt: Number.isFinite(ticks) && booted > 0 ? booted * 1000 + Math.floor(ticks / 100) * 1000 : null };
}

function fromPs(pid: number): ProcessInfo | null {
  // The start time in the C locale reads "Sat Nov 21 18:15:10 2026": five words, then the command line (-ww: whole).
  const r = spawnSync('ps', ['-ww', '-o', 'lstart=', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' } });
  const m = r.status === 0 ? /^\s*(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*?)\s*$/s.exec(r.stdout ?? '') : null;
  if (!m) return null;
  const started = Date.parse(m[1]);
  return { command: m[2], startedAt: Number.isFinite(started) ? started : null };
}

function fromTasklist(pid: number): ProcessInfo | null {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const m = /^"([^"]+)","(\d+)"/m.exec(r.stdout ?? '');
  return m && Number(m[2]) === pid ? { command: m[1], startedAt: null } : null;
}
