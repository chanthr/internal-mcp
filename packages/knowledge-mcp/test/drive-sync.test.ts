/**
 * Drive plugin safety: reindex refuses to run without drive.roots or with a --root outside them, OCR is
 * skipped without Mathpix keys (no download, no error), and after a folder change the indexed paths are
 * rechecked: moved into an excluded folder, trashed or deleted → vectors removed; a failed folder lookup
 * keeps the vectors. The path test needs a real Qdrant (QDRANT_TEST_URL).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const qdrantUrl = process.env.QDRANT_TEST_URL; // read before the cleanup below, which removes QDRANT_*
for (const k of Object.keys(process.env)) if (/^(GOOGLE_|MATHPIX_|QDRANT_|OPENAI_)/.test(k)) delete process.env[k];
const collection = `kmcp_sync_${Date.now()}`;
Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: mkdtempSync(join(tmpdir(), 'kmcp-drive-')),
  MCP_CONFIG_JSON: JSON.stringify({ drive: { roots: [{ id: 'root1', name: 'Docs', source: 'biz' }], excludeFolders: ['HR'] } }),
  ...(qdrantUrl ? { QDRANT_URL: qdrantUrl, QDRANT_COLLECTION: collection } : {}),
});

const { runReindex } = await import('../src/plugins/drive/reindex.js');
const { extractText } = await import('../src/plugins/drive/extract_text.js');
const { refreshIndexedPaths } = await import('../src/plugins/drive/sync.js');
const { DriveApiError } = await import('../src/plugins/drive/client.js');
const { QdrantClient } = await import('../src/plugins/drive/qdrant.js');
const { githubToken } = await import('../src/plugins/github/token.js');

test('reindex: --root must be one of drive.roots', async () => {
  await assert.rejects(runReindex(['--root', 'someOtherFolder']), /not one of drive\.roots \(root1\)/);
});

test('OCR is skipped without Mathpix keys: no download, no error', async () => {
  const drive = { files: { get: () => assert.fail('must not download') } } as never;
  const r = await extractText(drive, 'img1', 'image/png');
  assert.equal(r.needsOcr, true);
  assert.equal(r.text, '');
});

test('GITHUB_PAT wins over GITHUB_TOKEN', () => {
  process.env.GITHUB_TOKEN = 'broad';
  process.env.GITHUB_PAT = 'scoped';
  assert.equal(githubToken(), 'scoped');
  delete process.env.GITHUB_PAT;
  assert.equal(githubToken(), 'broad');
  delete process.env.GITHUB_TOKEN;
});

test('folder change: indexed paths are rechecked', { skip: qdrantUrl ? false : 'set QDRANT_TEST_URL' }, async () => {
  const q = new QdrantClient(qdrantUrl!);
  await q.createCollection(collection, { vectors: { size: 4, distance: 'Cosine' } });
  after(() => q.deleteCollection(collection).catch(() => undefined));
  const pt = (id: number, file: string, path: string) => ({ id, vector: [1, 0, 0, 0], payload: { file_id: file, file_path: path, file_name: path.split('/').pop(), source: 'biz' } });
  await q.upsert(collection, {
    points: [pt(1, 'stay', 'Team/a.md'), pt(2, 'moved', 'Team/b.md'), pt(3, 'trashed', 'Team/c.md'), pt(4, 'gone', 'Team/d.md'), pt(5, 'flaky', 'Flaky/e.md')],
  });
  // Drive now: "Team" is unchanged, b.md sits in an excluded folder "HR", c.md is trashed, d.md is deleted,
  // and looking up the folder of e.md fails (Drive outage) — that one must be kept.
  const files: Record<string, unknown> = {
    stay: { name: 'a.md', parents: ['team'], mimeType: 'text/markdown' },
    moved: { name: 'b.md', parents: ['hr'], mimeType: 'text/markdown' },
    trashed: { name: 'c.md', parents: ['team'], trashed: true, mimeType: 'text/markdown' },
    flaky: { name: 'e.md', parents: ['broken'], mimeType: 'text/markdown' },
    team: { name: 'Team', parents: ['root1'] },
    hr: { name: 'HR', parents: ['root1'] },
  };
  const drive = {
    files: {
      get: async ({ fileId }: { fileId: string }) => {
        if (fileId === 'broken') throw new DriveApiError('[drive] 500 rate', 500);
        if (!(fileId in files)) throw new DriveApiError('[drive] 404', 404);
        return { data: files[fileId] };
      },
    },
  } as never;
  const r = await refreshIndexedPaths(drive);
  assert.deepEqual(r, { checked: 5, reindexed: 0, deleted: 3, errored: 1 });
  const left = (await q.scroll(collection, { limit: 10, with_payload: ['file_id'] })).points.map((p) => (p.payload as { file_id: string }).file_id).sort();
  assert.deepEqual(left, ['flaky', 'stay']);
});
