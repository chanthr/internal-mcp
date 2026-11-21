/**
 * Writing mcp.config.json, .env and the data files whole (core/data_file.ts), and the files that cannot be swapped
 * in and are written in place as before: in a folder that may not be written, mounted on their own, behind a link
 * to a file not made yet, and with more than one name.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { writeFileAtomic } = await import('../src/core/data_file.js');
const root = mkdtempSync(join(tmpdir(), 'kmcp-write-'));
const folder = (name: string) => {
  const dir = join(root, name);
  mkdirSync(dir);
  return dir;
};

test('a file that may be written, in a folder that may not: written in place, as before', { skip: process.getuid?.() === 0 ? 'root writes anywhere' : false }, () => {
  const dir = folder('read-only');
  writeFileSync(join(dir, 'mcp.config.json'), '{}\n', { mode: 0o600 });
  chmodSync(dir, 0o555);
  try {
    writeFileAtomic(join(dir, 'mcp.config.json'), '{"folders":[]}\n');
    assert.equal(readFileSync(join(dir, 'mcp.config.json'), 'utf8'), '{"folders":[]}\n');
    assert.equal(statSync(join(dir, 'mcp.config.json')).mode & 0o777, 0o600);
  } finally {
    chmodSync(dir, 0o755);
  }
});

test('a file mounted on its own (a container): the rename is refused, and it is written in place', () => {
  const dir = folder('mounted');
  writeFileSync(join(dir, '.env'), 'A=1\nB=2\nC=3\n', { mode: 0o600 });
  // What renaming over a single file mounted into a container answers.
  const refused = mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
  });
  syncBuiltinESMExports();
  try {
    writeFileAtomic(join(dir, '.env'), 'A=1\n', { mode: 0o600 });
  } finally {
    refused.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(refused.mock.callCount(), 1);
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'A=1\n', 'the rest of the longer text before is cut off');
  assert.deepEqual(readdirSync(dir), ['.env'], 'no temporary file is left behind');
});

test('a link to a file that does not exist yet is written through, and stays a link', () => {
  const dir = folder('dangling');
  mkdirSync(join(dir, 'kept'));
  symlinkSync(join('kept', '.env'), join(dir, '.env'));
  writeFileAtomic(join(dir, '.env'), 'A=1\n', { mode: 0o600 });
  assert.equal(lstatSync(join(dir, '.env')).isSymbolicLink(), true);
  assert.equal(readFileSync(join(dir, 'kept', '.env'), 'utf8'), 'A=1\n');
  assert.equal(statSync(join(dir, 'kept', '.env')).mode & 0o777, 0o600);
});

test('a file with two names (a hard link): both names read the new text', () => {
  const dir = folder('hard');
  writeFileSync(join(dir, 'a.json'), '{"old":true}\n');
  linkSync(join(dir, 'a.json'), join(dir, 'b.json'));
  writeFileAtomic(join(dir, 'a.json'), '{"new":true}\n');
  assert.equal(readFileSync(join(dir, 'b.json'), 'utf8'), '{"new":true}\n');
  assert.equal(statSync(join(dir, 'a.json')).nlink, 2);
});

test('an ordinary file is swapped in whole: its permissions are kept, and no temporary file is left', () => {
  const dir = folder('plain');
  writeFileSync(join(dir, 'mcp.config.json'), '{}\n');
  chmodSync(join(dir, 'mcp.config.json'), 0o640);
  const before = statSync(join(dir, 'mcp.config.json')).ino;
  writeFileAtomic(join(dir, 'mcp.config.json'), '{"x":1}\n');
  assert.equal(readFileSync(join(dir, 'mcp.config.json'), 'utf8'), '{"x":1}\n');
  assert.equal(statSync(join(dir, 'mcp.config.json')).mode & 0o777, 0o640);
  assert.notEqual(statSync(join(dir, 'mcp.config.json')).ino, before, 'a new file took its place');
  assert.deepEqual(readdirSync(dir), ['mcp.config.json']);
});
