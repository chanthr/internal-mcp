/**
 * Drive content rules without a network: Markdown chunking (CRLF files, "# comments" inside code blocks),
 * folder-scope paths (NFC vs NFD Hangul, the way down to an allowed folder) and the sync retry list cap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(SUPABASE_|MCP_STORE)/.test(k)) delete process.env[k];
process.env.MCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'kmcp-content-'));

const { chunkMarkdown, parseFrontmatter } = await import('../src/plugins/drive/chunker.js');
const { isPathInScope, isScopeAncestor } = await import('../src/core/scope.js');
const { getRetryList, setRetryList } = await import('../src/plugins/drive/sync_state.js');

const filler = (word: string) => Array.from({ length: 80 }, (_, i) => `${word} ${i}`).join(' ');

test('chunker: CRLF files keep their frontmatter and headings', () => {
  const md = ['---', 'status: final', 'tags: [a, b]', '---', '', '# Intro', filler('alpha'), '', '## Setup', filler('beta')].join('\r\n');
  assert.deepEqual(parseFrontmatter(md).frontmatter, { status: 'final', tags: ['a', 'b'] });
  const chunks = chunkMarkdown(md);
  assert.equal(chunks[0]!.doc_status, 'final');
  assert.deepEqual(chunks.map((c) => c.heading), ['Intro', 'Intro > Setup']);
  assert.ok(chunks.every((c) => !c.content.includes('\r')));
});

test('chunker: a "# comment" inside a code block is not a heading', () => {
  const md = ['# Install', filler('gamma'), '', '```bash', '# install the tool', 'npm i -g thing', '```', '', '~~~', '# also not a heading', '~~~', filler('delta')].join('\n');
  const chunks = chunkMarkdown(md);
  assert.deepEqual([...new Set(chunks.map((c) => c.heading))], ['Install']);
  const all = chunks.map((c) => c.content).join('\n');
  assert.match(all, /```bash\n# install the tool\nnpm i -g thing\n```/);
});

test('scope: NFD Hangul from macOS matches the NFC prefix', () => {
  const nfc = '고객사/에이씨';
  const nfd = nfc.normalize('NFD');
  assert.notEqual(nfc, nfd);
  assert.equal(isPathInScope(`${nfd}/제안서`, [nfc]), true);
  assert.equal(isPathInScope(`${nfc}/제안서`, [nfd]), true);
  assert.equal(isPathInScope('고객사/다른곳', [nfc]), false);
});

test('scope: parent folders of an allowed folder stay visible, siblings do not', () => {
  const scope = ['Clients/Acme/Proposals'];
  assert.equal(isScopeAncestor('Clients', scope), true);
  assert.equal(isScopeAncestor('Clients/Acme', scope), true);
  assert.equal(isScopeAncestor('Clients/Acme/Proposals', scope), false); // that one is in scope, not a parent
  assert.equal(isScopeAncestor('Clients/Beta', scope), false);
  assert.equal(isScopeAncestor('Client', scope), false); // a name prefix is not a parent folder
  assert.equal(isScopeAncestor('Clients', null), false);
});

test('sync retry list: round-trips and keeps at most 1000 files', async () => {
  assert.deepEqual(await getRetryList(), {});
  await setRetryList({ a: 1, b: 3 });
  assert.deepEqual(await getRetryList(), { a: 1, b: 3 });
  const many = Object.fromEntries(Array.from({ length: 1005 }, (_, i) => [`f${i}`, 1]));
  await setRetryList(many);
  const kept = await getRetryList();
  assert.equal(Object.keys(kept).length, 1000);
  assert.equal('f1004' in kept, true); // the newest stay
  assert.equal('f0' in kept, false);
});
