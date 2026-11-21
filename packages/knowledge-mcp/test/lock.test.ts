/**
 * The lock that lets one process at a time scan the folders, sync Drive or fill in vectors: a lock left by a
 * holder that is gone is taken over, also when its process id now belongs to another program, and a holder at work
 * keeps its lock by touching it.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'kmcp-lock-'));
const { acquireLock, releaseLock } = await import('../src/core/lock.js');

const lockFile = (name: string) => join(process.env.MCP_DATA_DIR!, `${name}.lock`);
/** A lock as a server left it: its process id, last touched `ago` milliseconds ago. */
const leftBehind = (name: string, pid: number, ago: number) => {
  writeFileSync(lockFile(name), String(pid));
  const at = new Date(Date.now() - ago);
  utimesSync(lockFile(name), at, at);
};

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

test('a lock nobody touched for minutes is taken over, whoever has its process id now', () => {
  // pid 1 started with the machine, before the lock was touched, and is not this user's: only the silence tells.
  leftBehind('drive-sync', 1, 1_000);
  assert.equal(acquireLock('drive-sync'), false, 'touched a moment ago: it may be held');
  leftBehind('drive-sync', 1, 10 * 60_000);
  assert.equal(acquireLock('drive-sync'), true);
  releaseLock('drive-sync');
});

test('a holder at work touches its lock, so that it is not taken for one left behind', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    assert.equal(acquireLock('backfill'), true);
    // As if the last touch were long ago: the next beat touches it again, and the lock is still held.
    const at = new Date(Date.now() - 10 * 60_000);
    utimesSync(lockFile('backfill'), at, at);
    mock.timers.tick(30_000);
    assert.ok(Date.now() - statSync(lockFile('backfill')).mtimeMs < 5_000, 'touched');
    assert.equal(acquireLock('backfill'), false);
    // Released: it is not touched, or made again, any more.
    releaseLock('backfill');
    mock.timers.tick(60_000);
    assert.equal(existsSync(lockFile('backfill')), false);
  } finally {
    mock.timers.reset();
  }
});
