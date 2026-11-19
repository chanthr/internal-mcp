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
  await local.noteModel(DRIVE_COLLECTION, 'some-older-model', 'heading|');
  assert.match((await vectorProblem())!, /made by some-older-model \(4 dimensions\), but text-embedding-3-small \(4 dimensions\) is configured.*knowledge reembed/);
  await ensureCollection(); // does not throw: the index stays usable by keywords
  assert.deepEqual(await local.embeddingState(DRIVE_COLLECTION), { dim: 4, model: 'some-older-model', form: 'heading|', vectors: 1 });
  await assert.rejects(local.adoptDimension(DRIVE_COLLECTION, 8), /holds vectors/);

  // Another size (vectors written by a version that did not record the model).
  await client.deleteCollection(DRIVE_COLLECTION);
  await client.createCollection(DRIVE_COLLECTION, { vectors: { size: 8 } });
  await client.upsert(DRIVE_COLLECTION, { points: [{ id: 1, vector: [1, 0, 0, 0, 0, 0, 0, 0], payload: { file_id: 'f', content: 'old vector' } }] });
  assert.match((await vectorProblem())!, /made by another embedding model \(8 dimensions\)/);

  // reembed's first step: drop the vectors, keep the text and the keyword index, take the new size.
  assert.equal(await local.clearVectors(DRIVE_COLLECTION, 4), 1);
  assert.deepEqual(await local.embeddingState(DRIVE_COLLECTION), { dim: 4, model: null, form: null, vectors: 0 });
  assert.equal(await vectorProblem(), null);
  assert.equal((await local.keywordSearch(DRIVE_COLLECTION, { query: 'old vector', limit: 5, with_payload: true })).length, 1);
  assert.equal((await local.missingVectors(DRIVE_COLLECTION, 10)).length, 1);
  await local.setVectors(DRIVE_COLLECTION, [{ id: 1, vector: [0, 1, 0, 0] }]);
  await local.noteModel(DRIVE_COLLECTION, 'text-embedding-3-small', 'heading|');
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

test('counts, one document and paging read the indexes, and say the same as reading everything', async () => {
  const B = 'unit_counts';
  await client.createCollection(B, { vectors: { size: 4, distance: 'Cosine' } });
  const points = [];
  for (let d = 0; d < 30; d++) {
    for (let c = 0; c < 4; c++) {
      points.push({
        id: d * 10 + c + 1,
        vector: c % 2 ? [1, d, 0, 0] : undefined, // half of the chunks wait for a vector
        payload: { file_id: `local:f${d % 2 ? 'a' : 'b'}/doc${d}.md`, chunk_index: c, modified_time: `2026-01-${String(d + 1).padStart(2, '0')}`, source: d % 2 ? 'a' : 'b', doc_tags: [`t${d % 3}`], content: `text ${d} ${c}` },
      });
    }
  }
  await client.upsert(B, { points });
  assert.deepEqual(await local.stats(B), { chunks: 120, withVectors: 60, documents: 30 });
  assert.equal((await local.embeddingState(B))!.vectors, 60);
  assert.equal((await local.missingVectors(B, 1000)).length, 60);
  assert.equal((await local.missingVectors(B, 7)).length, 7);

  // One folder's documents, and when each was indexed: one row per document.
  assert.equal(await local.countDocuments(B, 'local:fa/'), 15);
  const times = await local.documentTimes(B, 'local:fa/');
  assert.deepEqual([times.size, times.get('local:fa/doc1.md'), times.has('local:fb/doc0.md')], [15, { modified: '2026-01-02', cut: null }, false]);
  assert.equal((await local.documentTimes(B)).size, 30);
  assert.deepEqual((await local.documentChunks(B, 'local:fa/doc1.md')).map((p) => p?.chunk_index).sort(), [0, 1, 2, 3]);
  assert.deepEqual((await local.documentChunks(B, 'local:fa/nope.md')).length, 0);
  // What a filter could be asked for, counted in documents.
  assert.deepEqual(await local.fieldValues(B, 'doc_tags'), [{ value: 't0', documents: 10 }, { value: 't1', documents: 10 }, { value: 't2', documents: 10 }]);
  assert.deepEqual(await local.fieldValues(B, 'source'), [{ value: 'a', documents: 15 }, { value: 'b', documents: 15 }]);
  assert.deepEqual(await local.fieldValues(B, 'doc_tags', 1), [{ value: 't0', documents: 10 }]);

  // Paging with a few fields picked, and through one document.
  const page = await client.scroll(B, { limit: 3, with_payload: ['file_id', 'chunk_index'] });
  assert.deepEqual(page.points[0].payload, { file_id: 'local:fb/doc0.md', chunk_index: 0 });
  assert.notEqual(page.next_page_offset, null);
  const one = await client.scroll(B, { limit: 100, with_payload: true, filter: { must: [{ key: 'file_id', match: { value: 'local:fa/doc3.md' } }] } });
  assert.deepEqual([one.points.length, one.next_page_offset, one.points[0].payload?.content], [4, null, 'text 3 0']);

  // The rest get their vectors: nothing is left waiting, and the counts follow.
  await local.setVectors(B, (await local.missingVectors(B, 1000)).map((m) => ({ id: m.id, vector: [0, 0, 1, 0] })));
  assert.deepEqual(await local.stats(B), { chunks: 120, withVectors: 120, documents: 30 });
  assert.equal((await local.missingVectors(B, 10)).length, 0);
  assert.equal(await local.clearVectors(B, 4), 120);
  assert.deepEqual([(await local.stats(B)).withVectors, (await local.missingVectors(B, 1000)).length], [0, 120]);
});

test('vector search returns the best matches in order: the same as scoring every chunk and sorting', async () => {
  const V = 'unit_topk';
  await client.createCollection(V, { vectors: { size: 4, distance: 'Cosine' } });
  let x = 7;
  const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  const points = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, vector: [rnd(), rnd(), rnd(), rnd()], payload: { file_id: `f${i}`, source: i % 5 === 0 ? 'rare' : 'common', content: `c${i}` } }));
  await client.upsert(V, { points });
  const q = [0.3, -0.2, 0.9, 0.1];
  const norm = (v: number[]) => Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  const cos = (v: number[]) => v.reduce((a, b, i) => a + b * q[i], 0) / (norm(v) * norm(q));
  const expected = points.map((p) => ({ id: p.id, score: cos(p.vector), rare: p.payload.source === 'rare' })).sort((a, b) => b.score - a.score);

  const got = await client.search(V, { vector: q, limit: 25, with_payload: ['content'] });
  assert.deepEqual(got.map((h) => h.id), expected.slice(0, 25).map((e) => e.id));
  got.forEach((h, i) => assert.ok(Math.abs(h.score - expected[i].score) < 1e-5, `score ${i}`));
  assert.equal(got[0].payload?.content, `c${expected[0].id - 1}`); // the text is read for what is returned
  // With a filter: the best of the chunks that pass.
  const rare = await client.search(V, { vector: q, limit: 10, filter: { must: [{ key: 'source', match: { value: 'rare' } }] } });
  assert.deepEqual(rare.map((h) => h.id), expected.filter((e) => e.rare).slice(0, 10).map((e) => e.id));
  // More asked for than there is, a floor on the score, and nothing asked for.
  assert.equal((await client.search(V, { vector: q, limit: 10_000 })).length, 500);
  const above = await client.search(V, { vector: q, limit: 500, score_threshold: 0.5 });
  assert.equal(above.length, expected.filter((e) => e.score >= 0.5).length);
  assert.deepEqual(await client.search(V, { vector: q, limit: 0 }), []);
  // A chunk written after the vectors were read into memory is found by the next search.
  await client.upsert(V, { points: [{ id: 9001, vector: q, payload: { file_id: 'new', source: 'common', content: 'the query itself' } }] });
  assert.equal((await client.search(V, { vector: q, limit: 1, with_payload: true }))[0].payload?.content, 'the query itself');
});

test('keyword search with a filter finds a match that is far down the ranking', async () => {
  const K = 'unit_deep';
  await client.createCollection(K, { vectors: { size: 4, distance: 'Cosine' } });
  // 2,500 short chunks say "alpha" twice. One long chunk of another source says it once, so it ranks below all of them.
  const common = Array.from({ length: 2500 }, (_, i) => ({ id: i + 1, payload: { file_id: `c${i}`, source: 'common', content: 'alpha alpha in a short chunk' } }));
  for (let i = 0; i < common.length; i += 500) await client.upsert(K, { points: common.slice(i, i + 500) });
  await client.upsert(K, { points: [{ id: 9000, payload: { file_id: 'r', source: 'rare', content: `alpha once, then ${'many other words that make this chunk long '.repeat(8)}` } }] });
  const top = await local.keywordSearch(K, { query: 'alpha', limit: 5 });
  assert.ok(top.every((h) => h.payload?.source === 'common'));
  const hits = await local.keywordSearch(K, { query: 'alpha', limit: 5, filter: { must: [{ key: 'source', match: { value: 'rare' } }] } });
  assert.deepEqual(hits.map((h) => h.payload?.file_id), ['r']);
  assert.deepEqual(await local.keywordSearch(K, { query: 'alpha', limit: 5, filter: { must: [{ key: 'source', match: { value: 'nobody' } }] } }), []);
});

