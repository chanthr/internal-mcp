/**
 * Built-in vector store (used when QDRANT_URL is not set): same behaviour the Drive plugin relies on from Qdrant.
 * Cosine ranking, `must` filters including array fields, paging, delete by file and by id, 63-bit ids, a size
 * check, and what happens when the embedding model is added or changed after the index was built.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(QDRANT_|OPENAI_|EMBEDDING_)/.test(k)) delete process.env[k];
Object.assign(process.env, { MCP_DATA_DIR: mkdtempSync(join(tmpdir(), 'kmcp-vec-')), EMBEDDING_DIM: '4' });

const { getQdrantClient, getLocalIndex: localIndex, vectorProblem, vectorStoreKind, ensureCollection, DRIVE_COLLECTION } = await import('../src/plugins/drive/qdrant.js');
const { makeChunkId } = await import('../src/plugins/drive/indexer.js');
const { getLocalIndex } = await import('../src/plugins/drive/qdrant.js');
const { tokenize, ftsQuery } = await import('../src/plugins/drive/tokens.js');
const client = await getQdrantClient();
const local = (await localIndex())!;
const C = 'unit_test';

test('built-in store is used without QDRANT_URL', async () => {
  assert.equal(vectorStoreKind(), 'built-in');
  await client.createCollection(C, { vectors: { size: 4, distance: 'Cosine' } });
  assert.ok((await client.getCollections()).collections.some((c) => c.name === C));
  assert.equal((await client.getCollection(C)).config?.params?.vectors?.size, 4);
});

const big = makeChunkId('file-a', 0); // a 63-bit id, beyond Number.MAX_SAFE_INTEGER
test('upsert, then search ranks by cosine similarity regardless of vector length', async () => {
  await client.upsert(C, {
    points: [
      { id: big, vector: [10, 0, 0, 0], payload: { file_id: 'a', chunk_index: 0, source: 'docs', doc_tags: ['alpha', 'beta'], content: 'first' } },
      { id: 2, vector: [0.9, 0.1, 0, 0], payload: { file_id: 'a', chunk_index: 1, source: 'docs', doc_tags: ['beta'], content: 'second' } },
      { id: 3, vector: [0, 0, 1, 0], payload: { file_id: 'b', chunk_index: 0, source: 'sales', doc_tags: [], content: 'other' } },
    ],
  });
  const hits = await client.search(C, { vector: [1, 0, 0, 0], limit: 3, with_payload: true });
  assert.deepEqual(hits.map((h) => h.payload?.content), ['first', 'second', 'other']);
  assert.ok(Math.abs(hits[0].score - 1) < 1e-6 && hits[2].score === 0);
  assert.equal(hits[0].id, big);
});

test('filters: exact value, and any element of an array field', async () => {
  const bySource = await client.search(C, { vector: [1, 0, 0, 0], limit: 5, with_payload: true, filter: { must: [{ key: 'source', match: { value: 'sales' } }] } });
  assert.deepEqual(bySource.map((h) => h.payload?.content), ['other']);
  const byTag = await client.search(C, { vector: [1, 0, 0, 0], limit: 5, with_payload: true, filter: { must: [{ key: 'doc_tags', match: { value: 'alpha' } }] } });
  assert.deepEqual(byTag.map((h) => h.payload?.content), ['first']);
  await assert.rejects(client.search(C, { vector: [1, 0, 0, 0], limit: 1, filter: { should: [{}] } }), /only "must"/);
});

test('scroll pages through everything, retrieve finds a 63-bit id, payload fields can be picked', async () => {
  const seen: unknown[] = [];
  let offset: string | number | null | undefined;
  do {
    const page = await client.scroll(C, { limit: 2, offset: offset ?? undefined, with_payload: ['file_id'] });
    seen.push(...page.points.map((p) => p.payload));
    offset = page.next_page_offset;
  } while (offset !== null && offset !== undefined);
  assert.deepEqual(seen, [{ file_id: 'a' }, { file_id: 'a' }, { file_id: 'b' }]);
  const got = await client.retrieve(C, { ids: [big, 999], with_payload: true });
  assert.equal(got.length, 1);
  assert.equal(got[0].payload?.content, 'first');
});

test('delete by file and by id, and a vector of the wrong size is refused', async () => {
  await client.delete(C, { filter: { must: [{ key: 'file_id', match: { value: 'a' } }] } });
  assert.deepEqual((await client.scroll(C, { limit: 10 })).points.map((p) => p.id), [3]);
  await client.delete(C, { points: [3] });
  assert.equal((await client.scroll(C, { limit: 10 })).points.length, 0);
  await assert.rejects(client.upsert(C, { points: [{ id: 1, vector: [1, 2], payload: {} }] }), /does not match collection/);
  await client.deleteCollection(C);
  assert.ok(!(await client.getCollections()).collections.some((c) => c.name === C));
});

test('ensureCollection: a keyword-only index takes the size of the model added later', async () => {
  await ensureCollection();
  assert.equal((await client.getCollection(DRIVE_COLLECTION)).config?.params?.vectors?.size, 4);
  // An index created while another size was the default (no model then), holding text only.
  await client.deleteCollection(DRIVE_COLLECTION);
  await client.createCollection(DRIVE_COLLECTION, { vectors: { size: 8 } });
  await client.upsert(DRIVE_COLLECTION, { points: [{ id: 1, payload: { file_id: 'f', content: 'text only' } }] });
  assert.equal(await vectorProblem(), null);
  await ensureCollection();
  assert.equal((await client.getCollection(DRIVE_COLLECTION)).config?.params?.vectors?.size, 4);
  assert.equal((await local.stats(DRIVE_COLLECTION)).chunks, 1); // nothing was dropped
});

test('vectors of another model are never mixed: indexing and search fall back to keywords until reembed', async () => {
  // Same size, another model.
  await local.setVectors(DRIVE_COLLECTION, [{ id: 1, vector: [1, 0, 0, 0] }]);
  await local.noteModel(DRIVE_COLLECTION, 'some-older-model');
  assert.match((await vectorProblem())!, /made by some-older-model \(4 dimensions\), but text-embedding-3-small \(4 dimensions\) is configured.*knowledge reembed/);
  await ensureCollection(); // does not throw: the index stays usable by keywords
  assert.deepEqual(await local.embeddingState(DRIVE_COLLECTION), { dim: 4, model: 'some-older-model', vectors: 1 });
  await assert.rejects(local.adoptDimension(DRIVE_COLLECTION, 8), /holds vectors/);

  // Another size (vectors written by a version that did not record the model).
  await client.deleteCollection(DRIVE_COLLECTION);
  await client.createCollection(DRIVE_COLLECTION, { vectors: { size: 8 } });
  await client.upsert(DRIVE_COLLECTION, { points: [{ id: 1, vector: [1, 0, 0, 0, 0, 0, 0, 0], payload: { file_id: 'f', content: 'old vector' } }] });
  assert.match((await vectorProblem())!, /made by another embedding model \(8 dimensions\)/);

  // reembed's first step: drop the vectors, keep the text and the keyword index, take the new size.
  assert.equal(await local.clearVectors(DRIVE_COLLECTION, 4), 1);
  assert.deepEqual(await local.embeddingState(DRIVE_COLLECTION), { dim: 4, model: null, vectors: 0 });
  assert.equal(await vectorProblem(), null);
  assert.equal((await local.keywordSearch(DRIVE_COLLECTION, { query: 'old vector', limit: 5, with_payload: true })).length, 1);
  assert.equal((await local.missingVectors(DRIVE_COLLECTION, 10)).length, 1);
  await local.setVectors(DRIVE_COLLECTION, [{ id: 1, vector: [0, 1, 0, 0] }]);
  await local.noteModel(DRIVE_COLLECTION, 'text-embedding-3-small');
  assert.equal(await vectorProblem(), null);
  await client.deleteCollection(DRIVE_COLLECTION);
});

// ── Keyword index and chunks without vectors ──
const K = 'kw_test';

test('tokens: words for Latin text, character pairs for CJK, split at a script boundary', () => {
  assert.deepEqual(tokenize('API키 휴가를 신청! deploy_log v2'), ['api', '키', '휴가', '가를', '신청', 'deploy_log', 'v2']);
  assert.deepEqual(tokenize('東京都'), ['東京', '京都']);
  assert.equal(ftsQuery('How do we rotate the API keys?'), '"rotate" OR "api" OR "keys"');
  assert.equal(ftsQuery('the of'), '"the" OR "of"'); // only stopwords: keep them rather than search for nothing
  assert.equal(ftsQuery('?!'), null);
  assert.equal(ftsQuery('say "hi" OR NEAR'), '"say" OR "hi" OR "near"'); // quoted words, never FTS5 syntax ("or" is dropped as a stopword)
});

test('keyword search works with no vectors at all, in Korean and English, with filters', async () => {
  const index = (await getLocalIndex())!;
  await index.createCollection(K, { vectors: { size: 4 } });
  await index.upsert(K, {
    points: [
      { id: 1, payload: { file_id: 'a', file_name: 'leave.md', heading: '휴가', content: '연차 휴가를 신청하는 방법과 기한', source: 'docs' } },
      { id: 2, payload: { file_id: 'b', file_name: 'deploy.md', heading: 'Deploy', content: 'Production deploys from the main branch after review.', source: 'wiki' } },
      { id: 3, payload: { file_id: 'c', file_name: 'keys.md', heading: 'Keys', content: 'Rotate API keys every ninety days. 키 교체 주기는 90일.', source: 'wiki' } },
    ],
  });
  assert.deepEqual(await index.stats(K), { chunks: 3, withVectors: 0, documents: 3 });
  assert.deepEqual((await index.keywordSearch(K, { query: '휴가', limit: 5 })).map((h) => h.id), [1]); // "휴가" finds "휴가를"
  assert.deepEqual((await index.keywordSearch(K, { query: 'which branch is deployed to production?', limit: 5 })).map((h) => h.id), [2]);
  assert.equal((await index.keywordSearch(K, { query: 'keys.md', limit: 5 }))[0].id, 3); // the file name is searchable ("md" matches every file, so 3 only has to come first)
  assert.deepEqual((await index.keywordSearch(K, { query: 'api keys deploy', limit: 5, filter: { must: [{ key: 'source', match: { value: 'wiki' } }] } })).map((h) => h.id).sort(), [2, 3]);
  assert.deepEqual(await index.keywordSearch(K, { query: 'nothing matches this zzz', limit: 5 }), []);
  assert.deepEqual(await index.search(K, { vector: [1, 0, 0, 0], limit: 5 }), []); // no vectors yet
});

test('keyword index follows edits and deletes; vectors can be added later', async () => {
  const index = (await getLocalIndex())!;
  await index.upsert(K, { points: [{ id: 1, payload: { file_id: 'a', file_name: 'leave.md', heading: '휴가', content: '완전히 다른 내용: 예산 계획', source: 'docs' } }] });
  assert.deepEqual(await index.keywordSearch(K, { query: '연차', limit: 5 }), []);
  assert.deepEqual((await index.keywordSearch(K, { query: '예산', limit: 5 })).map((h) => h.id), [1]);
  await index.delete(K, { filter: { must: [{ key: 'file_id', match: { value: 'b' } }] } });
  assert.deepEqual(await index.keywordSearch(K, { query: 'production', limit: 5 }), []);

  assert.deepEqual((await index.missingVectors(K, 10)).map((m) => m.id).sort(), [1, 3]); // in storage order: the rewritten chunk comes last
  await index.setVectors(K, [{ id: 3, vector: [0, 2, 0, 0] }]);
  assert.deepEqual((await index.missingVectors(K, 10)).map((m) => m.id), [1]);
  assert.deepEqual((await index.search(K, { vector: [0, 1, 0, 0], limit: 5 })).map((h) => h.id), [3]);
  assert.deepEqual((await index.keywordSearch(K, { query: 'rotate', limit: 5 })).map((h) => h.id), [3]); // text search unaffected
  assert.deepEqual(await index.stats(K), { chunks: 2, withVectors: 1, documents: 2 });
  await index.deleteCollection(K);
});
