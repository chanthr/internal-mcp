/**
 * What the system says about a process: its command, when it started, and a mark of that start that a clock
 * change does not move (so that the tunnel's cloudflared is not taken for another program after the clock is set).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { processInfo } = await import('../src/core/process_info.js');

test('Linux: the mark of a start stays when the clock is set; the time to compare with a file moves with it', () => {
  const proc = mkdtempSync(join(tmpdir(), 'kmcp-proc-'));
  // /proc as Linux has it: the start in clock ticks since boot, the boot time (worked out from the clock), the boot's id.
  const machine = (booted: number, ticks: number, boot: string | null) => {
    mkdirSync(join(proc, '4242'), { recursive: true });
    writeFileSync(join(proc, '4242', 'stat'), `4242 (cloud) flared) S 1 4242 4242 0 -1 4194560 100 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 1000 2 0\n`);
    writeFileSync(join(proc, '4242', 'cmdline'), 'cloudflared\0tunnel\0run\0');
    writeFileSync(join(proc, 'stat'), `cpu  1 2 3 4\nbtime ${booted}\nprocesses 99\n`);
    rmSync(join(proc, 'sys'), { recursive: true, force: true });
    if (boot) {
      mkdirSync(join(proc, 'sys', 'kernel', 'random'), { recursive: true });
      writeFileSync(join(proc, 'sys', 'kernel', 'random', 'boot_id'), `${boot}\n`);
    }
    return processInfo(4242, 'linux', proc)!;
  };
  const before = machine(1_700_000_000, 123_456, 'boot-a');
  assert.deepEqual(before, { command: 'cloudflared tunnel run', startedAt: 1_700_000_000_000 + 1_234_000, mark: 'boot-a:123456' });
  // The clock was set an hour forward (a time server, a restored virtual machine): the kernel now says the machine
  // booted an hour later. The same process keeps its mark.
  const after = machine(1_700_003_600, 123_456, 'boot-a');
  assert.equal(after.mark, before.mark);
  assert.equal(after.startedAt! - before.startedAt!, 3_600_000);
  // Another start, or the same count in another boot, is another process.
  assert.notEqual(machine(1_700_000_000, 123_457, 'boot-a').mark, before.mark);
  assert.notEqual(machine(1_700_000_000, 123_456, 'boot-b').mark, before.mark);
  // Without the boot's id there is no mark: a count alone could come from another boot.
  assert.equal(machine(1_700_000_000, 123_456, null).mark, null);
  assert.equal(processInfo(4243, 'linux', proc), null, 'no such process');
});

test('a running process: its command, its start, the same mark each time; nothing once it is gone', async () => {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  await once(child, 'spawn');
  try {
    const first = processInfo(child.pid!);
    assert.ok(first, 'the system answered');
    assert.match(first.command, /sleep 300$/);
    if (process.platform !== 'win32') {
      assert.ok(Math.abs(first.startedAt! - Date.now()) < 5_000, String(first.startedAt));
      assert.ok(first.mark);
      assert.equal(processInfo(child.pid!)?.mark, first.mark);
    }
  } finally {
    child.kill();
    await once(child, 'exit');
  }
  assert.equal(processInfo(child.pid!), null);
});
