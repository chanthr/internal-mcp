/**
 * The lock that lets one process at a time scan the folders, sync Drive or fill in vectors: a lock left by a
 * holder that is gone is taken over, also when its process id now belongs to another program; a holder that runs
 * keeps its lock however long ago it last touched it (the machine slept); and of two processes that find the same
 * lock left behind, only one takes it.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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

test('a holder at work touches its lock; one that has had it for staleMs is taken over, as before', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  try {
    assert.equal(acquireLock('reembed', 60 * 60_000), true);
    // As if the last touch were long ago: the next beat touches it again.
    const at = new Date(Date.now() - 10 * 60_000);
    utimesSync(lockFile('reembed'), at, at);
    mock.timers.tick(30_000);
    assert.ok(Date.now() - statSync(lockFile('reembed')).mtimeMs < 5_000, 'touched');
    // An hour on, the holder has not let go (it hangs): its lock reads as taken an hour ago, and is taken over.
    mock.timers.tick(60 * 60_000);
    assert.equal(acquireLock('reembed', 60 * 60_000), true);
    // Released: it is not touched, or made again, any more.
    releaseLock('reembed');
    mock.timers.tick(60_000);
    assert.equal(existsSync(lockFile('reembed')), false);
  } finally {
    mock.timers.reset();
  }
});

test('two processes that find the same lock left behind at the same moment: only one of them takes it', { skip: process.platform === 'win32' ? 'the slow ps below is a shell script' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-race-'));
  // A ps that answers after up to 60 ms, as on a busy machine: looking at the holder takes a while.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const ps = spawnSync('/bin/sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(bin, 'ps'), `#!/bin/sh\nsleep 0.0$(( $$ % 7 ))\nexec ${ps} "$@"\n`);
  chmodSync(join(bin, 'ps'), 0o755);
  const lock = pathToFileURL(resolve(import.meta.dirname, '..', 'src', 'core', 'lock.ts')).href;
  // Each process waits for the moment it is given, then asks for the lock; the moment between finding the lock left
  // behind and taking it over is drawn out at random as well.
  const script = [
    `const { acquireLock, lockHooks } = await import(${JSON.stringify(lock)});`,
    `if (lockHooks) lockHooks.beforeTakeover = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.random() * 30);`,
    `const { createInterface } = await import('node:readline');`,
    `console.log('ready');`,
    `for await (const line of createInterface({ input: process.stdin })) {`,
    `  const go = Number(line);`,
    `  while (Date.now() < go) {}`,
    `  console.log(JSON.stringify({ got: acquireLock('race') }));`,
    `}`,
  ].join('\n');
  const racers: ChildProcessWithoutNullStreams[] = [0, 1].map(() =>
    spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: resolve(import.meta.dirname, '..'),
      env: { ...process.env, MCP_DATA_DIR: dir, PATH: `${bin}:${process.env.PATH}` },
    }),
  );
  const answers = racers.map((r) => createInterface({ input: r.stdout })[Symbol.asyncIterator]());
  const next = async (i: number) => {
    const timeout = new Promise<never>((_, fail) => setTimeout(() => fail(new Error('no answer in 20 s')), 20_000).unref());
    return String((await Promise.race([answers[i].next(), timeout])).value);
  };
  // The holder that is gone: its id now belongs to a program started after the lock was last touched.
  const reused = spawn('sleep', ['300'], { stdio: 'ignore' });
  try {
    await once(reused, 'spawn');
    for (const i of [0, 1]) assert.equal(await next(i), 'ready');
    let both = 0;
    for (let round = 0; round < 15; round++) {
      writeFileSync(join(dir, 'race.lock'), String(reused.pid));
      const at = new Date(Date.now() - 60_000);
      utimesSync(join(dir, 'race.lock'), at, at);
      const go = Date.now() + 150;
      for (const r of racers) r.stdin.write(`${go}\n`);
      const got = (await Promise.all([next(0), next(1)])).map((a) => JSON.parse(a).got as boolean);
      if (got[0] && got[1]) both++;
      assert.ok(got[0] || got[1], `round ${round + 1}: one of them takes it`);
    }
    assert.equal(both, 0, 'rounds in which both took the lock');
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('race.lock.')), [], 'nothing moved aside is left');
  } finally {
    reused.kill();
    for (const r of racers) r.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
