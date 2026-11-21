/**
 * The lock that lets one process at a time scan the folders, sync Drive or fill in vectors: a lock left by a
 * holder that is gone is taken over, also when its process id now belongs to another program; a holder that runs
 * keeps its lock however long ago it last touched it (the machine slept); a lock being made is not taken for one
 * left behind; and of several processes that find the same lock left behind, or ask for a free one, only one gets it.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

process.env.MCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'kmcp-lock-'));
const { acquireLock, lockHooks, releaseLock } = await import('../src/core/lock.js');

const lockFile = (name: string) => join(process.env.MCP_DATA_DIR!, `${name}.lock`);
/** A lock as a server left it: its process id, last touched `ago` milliseconds ago. */
const leftBehind = (name: string, pid: number, ago: number) => {
  writeFileSync(lockFile(name), String(pid));
  const at = new Date(Date.now() - ago);
  utimesSync(lockFile(name), at, at);
};
const realStart = lockHooks.startedAt;

test('a lock whose process id now belongs to a program started since is taken over at once', async () => {
  // The server died a minute ago, and the system has given its id to another program of the same person since.
  const other = spawn('sleep', ['300'], { stdio: 'ignore' });
  await once(other, 'spawn');
  try {
    leftBehind('folders-scan', other.pid!, 60_000);
    assert.equal(acquireLock('folders-scan'), true);
    assert.equal(readFileSync(lockFile('folders-scan'), 'utf8'), String(process.pid));
    releaseLock('folders-scan');
    assert.equal(existsSync(lockFile('folders-scan')), false);
  } finally {
    other.kill();
  }
});

test('a holder that runs keeps its lock however long ago it last touched it, as after the machine slept', async () => {
  const holder = spawn('sleep', ['300'], { stdio: 'ignore' });
  await once(holder, 'spawn');
  // It started an hour ago, and has not touched the lock for six minutes: the machine slept in the middle of a scan
  // (or it is an older version, which does not touch its lock).
  try {
    lockHooks.startedAt = (pid) => (pid === holder.pid ? Date.now() - 3_600_000 : realStart(pid));
    leftBehind('drive-sync', holder.pid!, 6 * 60_000);
    assert.equal(acquireLock('drive-sync'), false);
    assert.equal(readFileSync(lockFile('drive-sync'), 'utf8'), String(holder.pid));
    // A holder that hangs is taken over once it has had the lock for staleMs, as before.
    leftBehind('drive-sync', holder.pid!, 61 * 60_000);
    assert.equal(acquireLock('drive-sync', 60 * 60_000), true);
    releaseLock('drive-sync');
  } finally {
    holder.kill();
    lockHooks.startedAt = realStart;
  }
});

test('where the start of a process cannot be known (Windows, ps failed), a lock nobody touched for minutes counts as left behind', async () => {
  const holder = spawn('sleep', ['300'], { stdio: 'ignore' });
  await once(holder, 'spawn');
  try {
    lockHooks.startedAt = () => null;
    leftBehind('backfill', holder.pid!, 1_000);
    assert.equal(acquireLock('backfill'), false, 'touched a moment ago: it may be held');
    leftBehind('backfill', holder.pid!, 10 * 60_000);
    assert.equal(acquireLock('backfill'), true);
    releaseLock('backfill');
  } finally {
    holder.kill();
    lockHooks.startedAt = realStart;
  }
});

test('a holder at work touches its lock; once it has had it for staleMs, the lock reads as taken then, as before', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  try {
    const since = Date.now();
    assert.equal(acquireLock('reembed', 60 * 60_000), true);
    // As if the last touch were long ago: the next beat touches it again.
    const at = new Date(Date.now() - 10 * 60_000);
    utimesSync(lockFile('reembed'), at, at);
    mock.timers.tick(30_000);
    assert.ok(Date.now() - statSync(lockFile('reembed')).mtimeMs < 5_000, 'touched');
    // An hour on, the holder has not let go (it hangs): its lock's time is set back to when it was taken, an hour
    // ago, and is taken over like any lock older than staleMs (above).
    mock.timers.tick(60 * 60_000);
    assert.ok(Math.abs(statSync(lockFile('reembed')).mtimeMs - since) < 1_000, 'set back to when it was taken');
    // Released: it is not touched, or made again, any more.
    releaseLock('reembed');
    mock.timers.tick(60_000);
    assert.equal(existsSync(lockFile('reembed')), false);
  } finally {
    mock.timers.reset();
  }
});

test('a lock being made (no process id in it yet) is held for a few seconds, then counts as left behind', () => {
  // Where a lock cannot be made whole (no hard links), it exists empty for an instant before its id is written.
  writeFileSync(lockFile('making'), '');
  assert.equal(acquireLock('making'), false);
  const at = new Date(Date.now() - 60_000);
  utimesSync(lockFile('making'), at, at);
  assert.equal(acquireLock('making'), true);
  releaseLock('making');
});

test('a lock whose text is not a process id (cut short by a power cut, or garbage) is taken over once it is old', () => {
  for (const text of ['\0\0\0\0\0', 'abc', '']) {
    writeFileSync(lockFile('job'), text);
    const at = new Date(Date.now() - 3 * 3_600_000);
    utimesSync(lockFile('job'), at, at);
    assert.equal(acquireLock('job', 60_000), true, JSON.stringify(text));
    releaseLock('job');
  }
});

/** A process id that no process has. */
function deadPid(): number {
  for (let pid = 99_998; ; pid--) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
}

test('a holder that lets go at the moment its lock is taken over: no error, and this process holds it', () => {
  leftBehind('swap', deadPid(), 60_000);
  // Its holder removes it between the last look and the removal.
  const real = fs.unlinkSync;
  const vanishing = mock.method(fs, 'unlinkSync', (path: fs.PathLike) => {
    if (String(path) === lockFile('swap')) real(path);
    return real(path);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(acquireLock('swap'), true);
  } finally {
    vanishing.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(lockFile('swap'), 'utf8'), String(process.pid));
  releaseLock('swap');
  assert.equal(existsSync(lockFile('swap')), false);
});

test('a lock that another process took over since is not let go of, or touched, by its old holder', () => {
  assert.equal(acquireLock('replaced'), true);
  // Another process took it over (a new file, its own id), as when this one was taken for gone.
  writeFileSync(`${lockFile('replaced')}.new`, String(process.ppid));
  fs.renameSync(`${lockFile('replaced')}.new`, lockFile('replaced'));
  releaseLock('replaced');
  assert.equal(readFileSync(lockFile('replaced'), 'utf8'), String(process.ppid));
  rmSync(lockFile('replaced'));
});

test('a data folder on a share whose clock is behind: a lock made a moment ago, by a holder that just started, is held', async () => {
  const holder = spawn('sleep', ['300'], { stdio: 'ignore' });
  await once(holder, 'spawn');
  // The share stamps what is written there with its own clock, five seconds behind this machine's.
  const behind = () => new Date(Date.now() - 5_000);
  const realWrite = fs.writeFileSync;
  const stamping = mock.method(fs, 'writeFileSync', (path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    (realWrite as (...a: unknown[]) => void)(path, ...rest);
    if (typeof path === 'string' && path.startsWith(process.env.MCP_DATA_DIR!)) utimesSync(path, behind(), behind());
  });
  syncBuiltinESMExports();
  try {
    writeFileSync(lockFile('shared'), String(holder.pid));
    utimesSync(lockFile('shared'), behind(), behind());
    assert.equal(acquireLock('shared'), false);
  } finally {
    stamping.mock.restore();
    syncBuiltinESMExports();
    holder.kill();
    rmSync(lockFile('shared'), { force: true });
  }
});

/**
 * Racers: processes that wait for the moment they are given and then ask for the lock, round after round. Taking a
 * lock over is drawn out at random (a ps that answers after up to 60 ms, as on a busy machine, and pauses inside the
 * takeover), so that the processes overlap in every way they can. Returns how many held it after each round.
 */
async function race(racers: number, rounds: number, before: (dir: string, round: number) => void): Promise<{ holders: number[]; dir: string; stop: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-race-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const ps = spawnSync('/bin/sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(bin, 'ps'), `#!/bin/sh\nsleep 0.0$(( $$ % 7 ))\nexec ${ps} "$@"\n`);
  chmodSync(join(bin, 'ps'), 0o755);
  const lock = pathToFileURL(resolve(import.meta.dirname, '..', 'src', 'core', 'lock.ts')).href;
  const script = [
    `const { acquireLock, lockHooks } = await import(${JSON.stringify(lock)});`,
    `const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.random() * 20);`,
    `if (lockHooks) lockHooks.pause = nap;`,
    `const { createInterface } = await import('node:readline');`,
    `console.log('ready');`,
    `for await (const line of createInterface({ input: process.stdin })) {`,
    `  const go = Number(line);`,
    `  while (Date.now() < go) {}`,
    `  console.log(JSON.stringify({ got: acquireLock('race') }));`,
    `}`,
  ].join('\n');
  const children: ChildProcessWithoutNullStreams[] = Array.from({ length: racers }, () =>
    spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: resolve(import.meta.dirname, '..'),
      env: { ...process.env, MCP_DATA_DIR: dir, PATH: `${bin}:${process.env.PATH}` },
    }),
  );
  const stop = () => {
    for (const c of children) c.kill();
  };
  try {
    const answers = children.map((c) => createInterface({ input: c.stdout })[Symbol.asyncIterator]());
    const next = async (i: number) => {
      const timeout = new Promise<never>((_, fail) => setTimeout(() => fail(new Error('no answer in 20 s')), 20_000).unref());
      return String((await Promise.race([answers[i].next(), timeout])).value);
    };
    for (let i = 0; i < racers; i++) assert.equal(await next(i), 'ready');
    const holders: number[] = [];
    for (let round = 0; round < rounds; round++) {
      rmSync(join(dir, 'race.lock'), { force: true });
      before(dir, round);
      const go = Date.now() + 100;
      for (const c of children) c.stdin.write(`${go}\n`);
      const got = await Promise.all(children.map((_, i) => next(i)));
      holders.push(got.filter((a) => JSON.parse(a).got).length);
    }
    return { holders, dir, stop };
  } catch (e) {
    stop();
    throw e;
  }
}

test('three processes that find the same lock left behind at the same moment: only one of them takes it', { skip: process.platform === 'win32' ? 'the slow ps is a shell script' : false }, async () => {
  // The holder that is gone: its id now belongs to a program started after the lock was last touched.
  const reused = spawn('sleep', ['300'], { stdio: 'ignore' });
  await once(reused, 'spawn');
  let run: Awaited<ReturnType<typeof race>> | undefined;
  try {
    run = await race(3, 20, (dir) => {
      writeFileSync(join(dir, 'race.lock'), String(reused.pid));
      const at = new Date(Date.now() - 60_000);
      utimesSync(join(dir, 'race.lock'), at, at);
    });
    assert.deepEqual(run.holders.filter((n) => n !== 1), [], `holders in each round: ${run.holders.join(' ')}`);
    assert.deepEqual(readdirSync(run.dir).filter((f) => f.startsWith('race.lock.')), [], 'no draft or turn is left behind');
  } finally {
    reused.kill();
    run?.stop();
    if (run) rmSync(run.dir, { recursive: true, force: true });
  }
});

test('four processes asking for a lock nobody holds, at the same moment: one of them gets it', { skip: process.platform === 'win32' ? 'the slow ps is a shell script' : false }, async () => {
  const run = await race(4, 20, () => undefined);
  try {
    assert.deepEqual(run.holders.filter((n) => n !== 1), [], `holders in each round: ${run.holders.join(' ')}`);
  } finally {
    run.stop();
    rmSync(run.dir, { recursive: true, force: true });
  }
});
