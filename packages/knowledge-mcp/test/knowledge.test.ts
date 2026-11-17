/**
 * The knowledge plugin end to end with nothing configured but a folder: a scan indexes Markdown, text and Office
 * files, search answers by keywords with no embedding model, edits and deletions are followed, a document id cannot
 * be used to read outside the folder, and once a model is configured the stored chunks get vectors and search
 * becomes hybrid.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// A local "embedding model": text with shared character trigrams gets similar vectors.
const DIM = 32;
const model = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const { input } = JSON.parse(raw) as { input: string[] };
    const data = input.map((t, index) => {
      const v = new Array(DIM).fill(0);
      const s = t.toLowerCase();
      for (let i = 0; i < s.length - 2; i++) {
        const h = createHash('md5').update(s.slice(i, i + 3)).digest();
        v[h[0] % DIM] += h[1] & 1 ? 1 : -1;
      }
      return { index, embedding: v };
    });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data }));
  });
});
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
after(() => model.close());

const docs = mkdtempSync(join(tmpdir(), 'kmcp-docs-'));
const outside = mkdtempSync(join(tmpdir(), 'kmcp-outside-'));
mkdirSync(join(docs, 'guides'));
mkdirSync(join(docs, 'HR'));
mkdirSync(join(docs, 'node_modules', 'pkg'), { recursive: true });
writeFileSync(join(docs, 'guides', 'deploy.md'), '---\nstatus: current\ndate: 2026-10-01\n---\n# Deploy\n\nProduction deploys from the main branch after review. Rollback uses the previous image.\n');
writeFileSync(join(docs, 'guides', 'leave.md'), '# 휴가 규정\n\n연차 휴가를 쓰려면 사흘 전에 신청서를 올립니다.\n');
writeFileSync(join(docs, 'notes.txt'), 'Quarterly budget review happens in the first week of each quarter.\n');
writeFileSync(join(docs, 'HR', 'salaries.md'), '# Salaries\n\nConfidential salary table.\n');
writeFileSync(join(docs, 'node_modules', 'pkg', 'README.md'), '# pkg\n\nProduction deploys are mentioned here too.\n');
writeFileSync(join(docs, 'image.png'), 'not really a png');
writeFileSync(join(outside, 'secret.md'), '# Secret\n\nNever index this file.\n');
symlinkSync(join(outside, 'secret.md'), join(docs, 'link.md'));

for (const k of Object.keys(process.env)) if (/^(QDRANT_|OPENAI_|EMBEDDING_|GOOGLE_|KNOWLEDGE_)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: mkdtempSync(join(tmpdir(), 'kmcp-kn-')),
  EMBEDDING_DIM: String(DIM),
  EMBEDDING_MODEL: 'test-model',
  MCP_CONFIG_JSON: JSON.stringify({ folders: [{ path: docs, name: 'docs', source: 'handbook' }], drive: { excludeFolders: ['HR'] } }),
});

const { scanFolders, localFolders, resolveLocalId } = await import('../src/plugins/knowledge/folders.js');
const { handleSearchKnowledge } = await import('../src/plugins/knowledge/tools/search_knowledge.js');
const { handleReadDocument } = await import('../src/plugins/knowledge/tools/read_document.js');
const { fuse } = await import('../src/plugins/knowledge/hybrid.js');
const { knowledgePlugin } = await import('../src/plugins/knowledge/index.js');
const { getLocalIndex, DRIVE_COLLECTION } = await import('../src/plugins/drive/qdrant.js');
const { authStore } = await import('../src/core/context.js');
type Auth = Parameters<typeof authStore.run>[0];
const admin = { ok: true, role: 'admin', email: 'a@test', org_id: 'o' } as Auth;
const scoped = { ok: true, role: 'member', email: 's@test', org_id: 'o', scopes: { driveFolders: ['docs/guides'] } } as Auth;
const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n');
const search = (auth: Auth, args: Record<string, unknown>) => authStore.run(auth, async () => text(await handleSearchKnowledge({ topK: 5, ...args } as never)));
const read = (auth: Auth, args: Record<string, unknown>) => authStore.run(auth, async () => handleReadDocument({ maxChars: 50000, ...args } as never));

test('a folder is all it takes: the plugin is on with no account and no key', () => {
  assert.equal(knowledgePlugin.enabled!(), true);
  assert.deepEqual(localFolders().map((f) => [f.name, f.source]), [['docs', 'handbook']]);
});

test('scan: supported files are indexed; excluded folders, dot and build folders, links and other formats are not', async () => {
  const r = (await scanFolders())!;
  assert.deepEqual([r.files, r.indexed, r.errored], [3, 3, 0]); // deploy.md, leave.md, notes.txt
  const stats = await (await getLocalIndex())!.stats(DRIVE_COLLECTION);
  assert.equal(stats.documents, 3);
  assert.equal(stats.withVectors, 0); // no embedding model: text only
  const again = (await scanFolders())!;
  assert.deepEqual([again.indexed, again.unchanged], [0, 3]); // nothing changed, nothing reopened
});

test('search works by keywords alone, in Korean and English, and shows the document date', async () => {
  const en = await search(admin, { query: 'which branch do production deploys come from?' });
  assert.match(en, /matched by keyword\n/);
  assert.match(en, /### 1\. \[2026-10-01, \d+mo old\] deploy\.md|### 1\. \[2026-10-01\] deploy\.md/);
  assert.match(en, /Document ID:\*\* `local:docs\/guides\/deploy\.md`/);
  assert.ok(!en.includes('node_modules') && !en.includes('pkg'), 'build folders are not indexed');
  const ko = await search(admin, { query: '휴가 신청서' });
  assert.match(ko, /### 1\. .*leave\.md/);
  const none = await search(admin, { query: 'zzzz qqqq' });
  assert.match(none, /No document contains these words/);
  assert.match(await search(admin, { query: 'budget', source: 'handbook' }), /notes\.txt/);
  assert.match(await search(admin, { query: 'budget', source: 'other' }), /No results/);
  assert.ok(!(await search(admin, { query: 'salary table' })).includes('salaries'), 'an excluded folder is not searchable');
});

test('read_document: by id, and never outside the folder or the caller\'s scope', async () => {
  const ok = JSON.parse(text((await read(admin, { documentId: 'local:docs/guides/deploy.md' })) as never));
  assert.match(ok.body, /Rollback uses the previous image/);
  assert.equal(ok.meta.path, 'docs/guides/deploy.md');
  for (const id of [
    'local:docs/../secret.md',
    'local:docs/guides/../../etc/passwd',
    'local:docs/link.md', // a link that points outside the folder
    'local:docs/HR/salaries.md', // excluded folder
    'local:docs/node_modules/pkg/README.md',
    'local:docs/image.png',
    'local:other/deploy.md',
    'local:docs/missing.md',
  ]) {
    const r = await read(admin, { documentId: id });
    assert.equal((r as { isError?: boolean }).isError, true, id);
    assert.match(text(r as never), /\[not found\]/, id);
    assert.equal(await resolveLocalId(id) === null || id.includes('HR/'), true, id);
  }
  // A member limited to docs/guides sees guides, not the file one level up.
  assert.match(text((await read(scoped, { documentId: 'local:docs/guides/leave.md' })) as never), /사흘 전에/);
  assert.equal(((await read(scoped, { documentId: 'local:docs/notes.txt' })) as { isError?: boolean }).isError, true);
  assert.match(await search(scoped, { query: 'quarterly budget' }), /No results/);
  const batch = JSON.parse(text((await read(admin, { documentIds: ['local:docs/notes.txt', 'local:docs/missing.md'] })) as never));
  assert.equal(batch.count, 2);
  assert.match(batch.documents[0].body, /Quarterly budget/);
  assert.match(batch.documents[1].error, /not found/);
});

test('scan follows edits and deletions', async () => {
  writeFileSync(join(docs, 'notes.txt'), 'The offsite is planned for March in Busan.\n');
  const future = new Date(Date.now() + 5000);
  utimesSync(join(docs, 'notes.txt'), future, future);
  rmSync(join(docs, 'guides', 'leave.md'));
  const r = (await scanFolders())!;
  assert.deepEqual([r.indexed, r.removed, r.unchanged], [1, 1, 1]);
  assert.match(await search(admin, { query: 'offsite Busan' }), /notes\.txt/);
  assert.match(await search(admin, { query: 'quarterly budget' }), /No document contains these words/);
  assert.match(await search(admin, { query: '휴가' }), /No document contains these words/);
});

test('Drive code that walks the index leaves local documents alone, and a folder indexed first does not make Drive look done', async () => {
  const { hasDriveDocuments, refreshIndexedPaths } = await import('../src/plugins/drive/sync.js');
  const { pruneStaleVectors } = await import('../src/plugins/drive/reindex.js');
  const { indexText } = await import('../src/plugins/drive/indexer.js');
  const { DriveApiError } = await import('../src/plugins/drive/client.js');
  const index = (await getLocalIndex())!;
  const localDocs = (await index.stats(DRIVE_COLLECTION)).documents;
  assert.ok(localDocs >= 2);

  // Only local documents so far: Drive still has its first index to build.
  assert.equal(await hasDriveDocuments(), false);

  // Two Drive documents join the same index.
  const driveFile = (id: string) => ({ id, name: `${id}.md`, path: `Handbook/${id}.md`, modifiedTime: '2026-11-01T00:00:00.000Z', source: 'docs', mimeType: 'text/markdown', size: 10 });
  await indexText(driveFile('1AbC_dEf-gone'), '# Gone\n\nThis Drive file will be deleted.');
  await indexText(driveFile('1AbC_dEf-kept'), '# Kept\n\nThis Drive file stays.');
  assert.equal(await hasDriveDocuments(), true);
  assert.equal((await index.stats(DRIVE_COLLECTION)).documents, localDocs + 2);

  // A full Drive reindex whose listing holds one of them: the other Drive document goes, local documents stay.
  assert.equal(await pruneStaleVectors(new Set(['1AbC_dEf-kept'])), 1);
  assert.equal((await index.stats(DRIVE_COLLECTION)).documents, localDocs + 1);

  // A folder was moved in Drive, so every indexed Drive path is looked up again. Drive answers 404 for everything
  // here: the Drive document is removed, and no local id is ever sent to Drive.
  const asked: string[] = [];
  const drive = {
    files: {
      get: async ({ fileId }: { fileId: string }) => {
        asked.push(fileId);
        throw new DriveApiError('File not found', 404);
      },
    },
  };
  const r = await refreshIndexedPaths(drive as never);
  assert.deepEqual(asked, ['1AbC_dEf-kept']);
  assert.deepEqual([r.checked, r.deleted], [1, 1]);
  assert.equal((await index.stats(DRIVE_COLLECTION)).documents, localDocs);
  assert.match(await search(admin, { query: 'production deploys main branch' }), /deploy\.md/);
});

test('fuse: a chunk found by both searches outranks one found by either', () => {
  const pt = (id: number) => ({ id, score: 1, payload: { file_id: `f${id}` } });
  const hits = fuse([
    { kind: 'keyword', points: [pt(1), pt(2), pt(3)] },
    { kind: 'semantic', points: [pt(3), pt(4)] },
  ]);
  assert.equal(hits[0].payload.file_id, 'f3');
  assert.deepEqual(hits[0].matched, ['keyword', 'semantic']);
  assert.equal(hits[0].score, 1);
  assert.deepEqual(hits.map((h) => h.payload.file_id).sort(), ['f1', 'f2', 'f3', 'f4']);
});

test('adding an embedding model later: stored chunks get vectors without re-reading files, search becomes hybrid', async () => {
  process.env.EMBEDDING_BASE_URL = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
  try {
    const r = (await scanFolders())!;
    assert.equal(r.indexed, 0); // no file was reopened
    const stats = await (await getLocalIndex())!.stats(DRIVE_COLLECTION);
    assert.equal(stats.withVectors, stats.chunks);
    const out = await search(admin, { query: 'production deploys main branch' });
    assert.match(out, /matched by keyword \+ semantic\n/);
    assert.match(out, /### 1\. .*deploy\.md/);
    assert.match(out, /\(keyword \+ semantic\)/);
  } finally {
    delete process.env.EMBEDDING_BASE_URL;
  }
});

test('when the embedding endpoint is down, search still answers from keywords and says so', async () => {
  process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:9/v1'; // nothing listens here
  process.env.EMBED_QUERY_RETRIES = '0';
  try {
    const out = await search(admin, { query: 'production deploys' });
    assert.match(out, /matched by keyword\n/);
    assert.match(out, /Search by meaning is unavailable right now/);
    assert.match(out, /deploy\.md/);
  } finally {
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBED_QUERY_RETRIES;
  }
});

test('a folder removed from the config: one pass takes its documents out of the index', async () => {
  const memory = new Map<string, unknown>();
  const state = { get: async (k: string) => (memory.get(k) ?? null) as never, set: async (k: string, v: unknown) => void memory.set(k, v), delete: async (k: string) => void memory.delete(k) };
  const logs: string[] = [];
  const ctx = { config: undefined, state, log: (...a: unknown[]) => void logs.push(a.join(' ')) };
  const index = (await getLocalIndex())!;

  await knowledgePlugin.catchUp!(ctx); // a folder is configured: remembered
  assert.equal(memory.get('folders.configured'), true);
  assert.ok((await index.stats(DRIVE_COLLECTION)).documents > 0);

  // The same process cannot reload its config, so drop the folder the way localFolders() reads it.
  const { getConfig } = await import('../src/core/config.js');
  const saved = getConfig().folders.splice(0);
  try {
    assert.equal(localFolders().length, 0);
    await knowledgePlugin.catchUp!(ctx);
    assert.equal((await index.stats(DRIVE_COLLECTION)).documents, 0);
    assert.equal(memory.get('folders.configured'), false);
    assert.match(logs.join('\n'), /none configured any more, removed \d+ document/);
    assert.match(await search(admin, { query: 'production deploys' }), /The index is empty/);
  } finally {
    getConfig().folders.push(...saved);
  }
});
