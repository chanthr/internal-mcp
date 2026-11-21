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
 * name only, without a start time). When the system cannot be asked (ps failed, or took too long on a busy
 * machine), the answer is null: "not known", which is not the same as "no such process".
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ProcessInfo {
  /** The command line: the program and its arguments, separated by spaces. On Windows, the program's name. */
  command: string;
  /** When it started, in milliseconds since 1970, to the second, by the clock as it is now. Null when not known. */
  startedAt: number | null;
  /**
   * The start as a mark that stays the same for as long as the process runs, whatever is done to the clock (a time
   * server correcting it, a virtual machine restored): to be compared with another mark only. Null when not known.
   */
  mark: string | null;
}

/** The process with this id, or null when there is none, or when the system could not be asked. */
export function processInfo(pid: number, platform: NodeJS.Platform = process.platform, proc = '/proc'): ProcessInfo | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') return fromProc(pid, proc);
    if (platform === 'win32') return fromTasklist(pid);
    return fromPs(pid);
  } catch {
    return null;
  }
}

// Linux counts a process's start in clock ticks since the machine booted, 100 to the second on every architecture
// Node runs on (USER_HZ). That count never moves; the boot time in /proc/stat does, as the kernel works it out from
// the clock each time it is read. So the mark is the count, with the id of this boot, and only the time to compare
// with a file's time is worked out from the boot time.
function fromProc(pid: number, proc: string): ProcessInfo | null {
  let stat: string;
  try {
    stat = readFileSync(join(proc, String(pid), 'stat'), 'utf8');
  } catch {
    return null;
  }
  // The program's name is in brackets and may hold spaces and brackets of its own, so the fields are counted from
  // the last closing bracket: the state is field 3, and the start time field 22.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = /^\d+$/.test(fields[19] ?? '') ? Number(fields[19]) : NaN;
  const booted = Number(/^btime (\d+)$/m.exec(readFileSync(join(proc, 'stat'), 'utf8'))?.[1]);
  let boot = '';
  try {
    boot = readFileSync(join(proc, 'sys', 'kernel', 'random', 'boot_id'), 'utf8').trim();
  } catch {
    /* without the id of the boot, a count from another boot could be taken for this one: no mark */
  }
  let command = '';
  try {
    command = readFileSync(join(proc, String(pid), 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    /* a process of another user may hide its command line */
  }
  // A process without a command line (a kernel thread, one that is exiting) still has its name in the brackets.
  if (!command) command = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
  const known = Number.isFinite(ticks);
  return {
    command,
    startedAt: known && booted > 0 ? booted * 1000 + Math.floor(ticks / 100) * 1000 : null,
    mark: known && boot ? `${boot}:${ticks}` : null,
  };
}

// macOS keeps the time a process started as it was then: the clock changing later does not move it, so it serves as
// the mark as well. It is asked for in UTC, so that the hour repeated when summer time ends cannot be read twice.
function fromPs(pid: number): ProcessInfo | null {
  // The start time in the C locale reads "Sat Nov 21 18:15:10 2026": five words, then the command line (-ww: whole).
  const r = spawnSync('ps', ['-ww', '-o', 'lstart=', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  const m = r.status === 0 ? /^\s*(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*?)\s*$/s.exec(r.stdout ?? '') : null;
  if (!m) return null;
  const started = Date.parse(`${m[1]} GMT`);
  return { command: m[2], startedAt: Number.isFinite(started) ? started : null, mark: Number.isFinite(started) ? String(started) : null };
}

function fromTasklist(pid: number): ProcessInfo | null {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const m = /^"([^"]+)","(\d+)"/m.exec(r.stdout ?? '');
  return m && Number(m[2]) === pid ? { command: m[1], startedAt: null, mark: null } : null;
}
