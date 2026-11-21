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
const { ftsPieces } = await import('../src/plugins/drive/local_vectors.js');
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


// ── The memory copies follow this process's writes ──

const { LocalVectorClient, localVectorPath } = await import('../src/plugins/drive/local_vectors.js');
const { queryTerms } = await import('../src/plugins/drive/tokens.js');
const { DatabaseSync } = await import('node:sqlite');
/** Another connection to the same file: what a fresh process reads, and a writer that is not this process. */
const freshClient = () => new LocalVectorClient(new DatabaseSync(localVectorPath()));

test('vectors written here are applied in memory: no reading again, room grows by the policy, the same answers as a fresh read', async () => {
  const L = 'unit_live';
  await client.createCollection(L, { vectors: { size: 8 } });
  let x = 11;
  const rnd = () => (x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  const vec = () => Array.from({ length: 8 }, rnd);
  // One vector on several chunks, some of them given it later: equal scores must come out in a fresh read's order.
  const twin = vec();
  const payload = (i: number) => ({ file_id: `doc${i % 50}`, source: i % 3 ? 'docs' : 'wiki', doc_tags: [`t${i % 4}`], content: `passage ${i}` });
  await client.upsert(L, { points: Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, vector: i % 100 === 0 ? twin : vec(), payload: payload(i) })) });
  await client.upsert(L, { points: Array.from({ length: 40 }, (_, i) => ({ id: 5000 + i, payload: payload(i) })) }); // text only, for now
  const q = vec();
  await client.search(L, { vector: q, limit: 5 });
  const first = local.memoryUse(L);
  assert.deepEqual([first.loads, first.allocations, first.vectors, first.capacity], [1, 1, 1000, 1064]); // 1,000 and room for 64 more

  // Twenty rounds of "write, then search": new chunks, a changed one, a removed one, a vector added to an old chunk.
  for (let round = 0; round < 20; round++) {
    const base = 2000 + round * 10;
    await client.upsert(L, { points: Array.from({ length: 10 }, (_, i) => ({ id: base + i, vector: i === 0 ? twin : vec(), payload: payload(base + i) })) });
    await client.upsert(L, { points: [{ id: round * 7 + 2, vector: vec(), payload: payload(round) }] });
    await client.delete(L, { points: [round * 7 + 5] });
    await local.setVectors(L, [{ id: 5000 + round, vector: round % 4 ? vec() : twin }]);
    await client.search(L, { vector: q, limit: 5 });
  }
  const after = local.memoryUse(L);
  assert.equal(after.loads, 1, 'never read from the file again');
  assert.equal(after.vectors, 1200);
  // 1,240 slots were needed, more than the 1,064 there were: one larger array, 1.5 times the room.
  assert.deepEqual([after.allocations, after.capacity], [2, 1596]);

  // A fresh read of the file gives the same answers, filtered or not, equal scores included.
  let fresh = freshClient();
  const wiki = { must: [{ key: 'source', match: { value: 'wiki' } }] };
  for (const query of [q, twin, vec(), vec()]) {
    assert.deepEqual(await client.search(L, { vector: query, limit: 2000 }), await fresh.search(L, { vector: query, limit: 2000 }));
    assert.deepEqual(await client.search(L, { vector: query, limit: 50, filter: wiki }), await fresh.search(L, { vector: query, limit: 50, filter: wiki }));
  }
  assert.equal(local.memoryUse(L).loads, 1);

  // A write by another process is noticed: read again, into the same array while the vectors fit.
  await fresh.upsert(L, { points: [{ id: 9999, vector: q, payload: payload(9999) }] });
  assert.equal((await client.search(L, { vector: q, limit: 1 }))[0].id, 9999);
  assert.deepEqual([local.memoryUse(L).loads, local.memoryUse(L).allocations], [2, 2]);

  // Removing most chunks squeezes the gaps out in place; still the same answers as a fresh read.
  await client.delete(L, { points: Array.from({ length: 700 }, (_, i) => i + 300) });
  await client.search(L, { vector: q, limit: 5 });
  const squeezed = local.memoryUse(L);
  assert.deepEqual([squeezed.loads, squeezed.allocations, squeezed.slots], [2, 2, squeezed.vectors]);
  fresh = freshClient();
  for (const query of [q, twin]) assert.deepEqual(await client.search(L, { vector: query, limit: 2000 }), await fresh.search(L, { vector: query, limit: 2000 }));
});

test('filters keep only the fields they look at, follow the writes made here, and answer as a fresh read', async () => {
  const M = 'unit_meta';
  await client.createCollection(M, { vectors: { size: 4 } });
  await client.upsert(M, {
    points: [
      { id: 1, vector: [1, 0, 0, 0], payload: { file_id: 'a', source: 'docs', doc_customer: null, has_image: false, doc_tags: ['x', 'y'], content: 'alpha one' } },
      { id: 2, vector: [0.9, 0.1, 0, 0], payload: { file_id: 'b', source: 'wiki', has_image: true, doc_tags: ['y'], content: 'alpha two' } }, // no doc_customer at all
      { id: 3, payload: { file_id: 'c', source: 'wiki', doc_customer: 'Initech', doc_tags: [], content: 'alpha three' } },
    ],
  });
  const byNull = { must: [{ key: 'doc_customer', match: { value: null } }] };
  assert.deepEqual((await local.keywordSearch(M, { query: 'alpha', limit: 5, filter: byNull })).map((h) => h.id), [1]); // a null value, not a missing field
  assert.deepEqual((await client.search(M, { vector: [1, 0, 0, 0], limit: 5, filter: { must: [{ key: 'has_image', match: { value: false } }] } })).map((h) => h.id), [1]);
  const loads = local.memoryUse(M).metadataLoads;
  assert.equal(loads, 1);

  // Written here: a new document, a changed one, a removed one. The filters see them without reading again.
  await client.upsert(M, { points: [{ id: 4, vector: [0, 1, 0, 0], payload: { file_id: 'd', source: 'wiki', doc_tags: ['z'], content: 'alpha four' } }] });
  await client.upsert(M, { points: [{ id: 2, vector: [0.9, 0.1, 0, 0], payload: { file_id: 'b', source: 'docs', has_image: true, doc_tags: ['y', 'z'], content: 'alpha two again' } }] });
  await client.delete(M, { points: [3] });
  const wiki = { must: [{ key: 'source', match: { value: 'wiki' } }] };
  assert.deepEqual((await local.keywordSearch(M, { query: 'alpha', limit: 5, filter: wiki })).map((h) => h.id), [4]);
  assert.deepEqual(await local.fieldValues(M, 'doc_tags'), [{ value: 'y', documents: 2 }, { value: 'z', documents: 2 }, { value: 'x', documents: 1 }]);
  assert.deepEqual([local.memoryUse(M).metadataLoads, local.memoryUse(M).chunks], [loads, 3], 'not read again after a write made here');

  // A field no filter asked for before is read once, and kept from then on.
  const byName = { must: [{ key: 'file_name', match: { value: 'nope' } }] };
  assert.deepEqual(await local.keywordSearch(M, { query: 'alpha', limit: 5, filter: byName }), []);
  await local.keywordSearch(M, { query: 'alpha', limit: 5, filter: byName });
  assert.equal(local.memoryUse(M).metadataLoads, loads + 1);

  const fresh = freshClient();
  for (const filter of [byNull, wiki, byName, { must: [{ key: 'doc_tags', match: { value: 'z' } }, { key: 'has_image', match: { value: true } }] }]) {
    assert.deepEqual(await local.keywordSearch(M, { query: 'alpha', limit: 5, filter }), await fresh.keywordSearch(M, { query: 'alpha', limit: 5, filter }));
    assert.deepEqual(await client.search(M, { vector: [1, 0, 0, 0], limit: 5, filter }), await fresh.search(M, { vector: [1, 0, 0, 0], limit: 5, filter }));
  }
  for (const key of ['doc_tags', 'source', 'file_id', 'has_image']) assert.deepEqual(await local.fieldValues(M, key), await fresh.fieldValues(M, key));
});

test('a long question in a large index is searched by 16 of its words, the rarer ones, and still finds its passage', async () => {
  const W = 'unit_words';
  await client.createCollection(W, { vectors: { size: 4 } });
  // 5,200 passages share a boilerplate sentence; each also has a word of its own.
  const common = '회사 규정 안내 문서입니다 연차 휴가 신청 절차와 승인 기준을 설명합니다';
  for (let i = 0; i < 5200; i += 650) {
    await client.upsert(W, { points: Array.from({ length: 650 }, (_, j) => ({ id: i + j + 1, payload: { file_id: `f${i + j}`, content: `${common} code${i + j}` } })) });
  }
  await client.upsert(W, { points: [{ id: 9000, payload: { file_id: 'target', content: `${common} 두루미 서식지 보호 quokka zebra 관찰 기록` } }] });

  const question = `${common} 그리고 두루미 서식지 보호 quokka zebra 관찰 기록에 대해 ${Array.from({ length: 40 }, (_, i) => `code${i * 97}`).join(' ')}`;
  const terms = local.keywordTerms(W, question);
  assert.ok(queryTerms(question).length > 50);
  // At most 16 of the words the index holds. The four it holds nowhere are kept: looking for them costs nothing.
  const absent = ['그리', '리고', '록에', '대해'];
  assert.ok(absent.every((t) => terms.includes(t)) && terms.filter((t) => !absent.includes(t)).length <= 16, String(terms));
  assert.ok(!terms.some((t) => tokenize(common).includes(t)), `words in every passage are dropped: ${terms}`);
  assert.ok(['두루', '루미', 'quokka', 'zebra'].every((t) => terms.includes(t)), String(terms));
  assert.equal((await local.keywordSearch(W, { query: question, limit: 5 }))[0].id, 9000);

  // A question of 16 words or fewer keeps them all, common ones included.
  for (const q of ['두루미 quokka', '회사 quokka', '회사 규정']) assert.deepEqual(local.keywordTerms(W, q), queryTerms(q));
  assert.deepEqual((await local.keywordSearch(W, { query: '두루미 quokka', limit: 5 })).map((h) => h.id), [9000]);
  // A word that a new document brings is found at once, whatever was counted before.
  await client.upsert(W, { points: [{ id: 9001, payload: { file_id: 'new', content: `${common} wombat` } }] });
  assert.equal((await local.keywordSearch(W, { query: '회사 wombat', limit: 5 }))[0].id, 9001);
  // A small index keeps every word.
  assert.deepEqual(local.keywordTerms('unit_meta', '회사 alpha quokka'), queryTerms('회사 alpha quokka'));
});

test('a keyword index out of step is rebuilt from the chunks, one chunk at a time', async () => {
  const R = 'unit_rebuild';
  await client.createCollection(R, { vectors: { size: 4 } });
  await client.upsert(R, { points: [{ id: 1, payload: { file_id: 'a', content: 'rebuild me please' } }, { id: 2, payload: { file_id: 'b', content: 'another passage' } }] });
  const db = new DatabaseSync(localVectorPath());
  db.exec(`DROP TABLE fts_${R}`);
  // Reading every chunk at once (.all()) held the whole index's text in memory: refused here.
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (/SELECT rowid AS rid, payload FROM/.test(sql)) statement.all = () => assert.fail(`read every chunk at once: ${sql}`);
    return statement;
  }) as typeof db.prepare;
  const rebuilt = new LocalVectorClient(db);
  assert.deepEqual((await rebuilt.keywordSearch(R, { query: 'rebuild', limit: 5 })).map((h) => h.id), [1]);
  await rebuilt.delete(R, { filter: { must: [{ key: 'content', match: { value: 'another passage' } }] } }); // a filter other than file_id walks the chunks too
  assert.deepEqual((await rebuilt.stats(R)).chunks, 1);
});

test('cutting a long question never loses what the whole question finds: filters, short results, identifiers', async () => {
  const T = 'unit_trim';
  await client.createCollection(T, { vectors: { size: 4 } });
  const points = [];
  for (let i = 0; i < 6000; i++) {
    let content = `guide filler${i % 700}`; // "guide" in every passage
    if (i % 4 === 0) content += ' 휴가 규정'; // a quarter of them
    if (i === 3000 || i === 3001) content += ' 출산 장려'; // rare, and only outside "hr"
    if (i < 16) content += ` uniq${i}`; // one passage each
    if (i % 10 < 3) content += ' app'; // "app" and "url" in 30% each; "app_url" itself in three passages
    if (i % 10 >= 5 && i % 10 < 8) content += ' url';
    if (i >= 10 && i < 13) content += ' app_url';
    if (i >= 3 && i < 6) content += ' café menu';
    points.push({ id: i + 1, payload: { file_id: `f${i % 50}`, source: i < 200 ? 'hr' : 'eng', content } });
  }
  for (let i = 0; i < points.length; i += 1000) await client.upsert(T, { points: points.slice(i, i + 1000) });
  const uniq = Array.from({ length: 16 }, (_, i) => `uniq${i}`).join(' ');

  // 16 words or fewer: every word, as always.
  for (const q of ['출산 휴가 규정', 'app_url guide', 'café guide', 'search_knowledge 휴가']) assert.deepEqual(local.keywordTerms(T, q), queryTerms(q));
  // Longer: the commonest single words go, down to 16 the index holds. The identifier stays, though its pieces are
  // common: FTS5 looks for it as "app" next to "url", which only three passages have.
  const long = `app_url guide 휴가 ${uniq}`;
  const terms = local.keywordTerms(T, long);
  assert.deepEqual(terms, ['app_url', ...Array.from({ length: 15 }, (_, i) => `uniq${i}`)]);
  assert.deepEqual(new Set((await local.keywordSearch(T, { query: long, limit: 5 })).slice(0, 3).map((h) => h.id)), new Set([11, 12, 13]));
  // A word the index does not hold is kept, and does not count among the 16.
  assert.ok(local.keywordTerms(T, `nowhere ${long}`).includes('nowhere'));
  // The words kept find 16 passages of the 30 asked for: the whole question fills the rest.
  assert.deepEqual(local.keywordTerms(T, `guide ${uniq}`), uniq.split(' '));
  const filled = (await local.keywordSearch(T, { query: `guide ${uniq}`, limit: 30 })).map((h) => h.id);
  assert.deepEqual([filled.length, new Set(filled.slice(0, 16))], [30, new Set(Array.from({ length: 16 }, (_, i) => i + 1))]);
  // A filtered search looks for every word: the rare one may not be among the passages the filter lets through.
  const hr = await local.keywordSearch(T, { query: `출산 ${uniq} 휴가 규정`, limit: 5, filter: { must: [{ key: 'source', match: { value: 'hr' } }] } });
  assert.equal(hr.length, 5);
  assert.ok(hr.every((h) => h.payload?.source === 'hr'), JSON.stringify(hr.map((h) => h.id)));
});

test('a word is split and unaccented as the keyword index does it, so it is counted as itself', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(tokens, content='', contentless_delete=1); CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance')");
  // Every Latin letter with marks (Latin-1, Latin Extended A and B, Latin Extended Additional: Vietnamese), and words.
  const words: string[] = [];
  for (const [from, to] of [[0xc0, 0x24f], [0x1e00, 0x1eff]]) for (let cp = from; cp <= to; cp++) words.push(...tokenize(String.fromCodePoint(cp)));
  words.push(...tokenize('cổ phần người Việt đường search_knowledge file_id café naïve résumé 휴가 東京'));
  const unique = [...new Set(words)];
  const ins = db.prepare('INSERT INTO t (rowid, tokens) VALUES (?, ?)');
  unique.forEach((w, i) => ins.run(i + 1, w));
  const held = new Map<number, string[]>();
  for (const r of db.prepare('SELECT term, doc FROM v ORDER BY doc, offset').all() as Array<{ term: string; doc: number }>) held.set(r.doc, [...(held.get(r.doc) ?? []), r.term]);
  const any = new Set([...held.values()].flat());
  // A piece that is not what the index holds for the word must not be a word it holds for other text: that miscounted
  // a letter with two marks as the plain letter ("cổ" as the common "co").
  const miscounted = unique.filter((w, i) => ftsPieces(w).some((p) => !(held.get(i + 1) ?? []).includes(p) && any.has(p)));
  assert.deepEqual(miscounted, []);
  assert.deepEqual(['cổ', 'café', 'search_knowledge', '휴가'].map(ftsPieces), [['cổ'], ['cafe'], ['search', 'knowledge'], ['휴가']]);
});

test('words counted as common are counted again after a write by another process or a rewrite here', async () => {
  const V = 'unit_vocab';
  await client.createCollection(V, { vectors: { size: 4 } });
  // "apple" in the first `cut` passages and "pear" in the rest: both common, and remembered as such.
  const passages = (cut: number) => Array.from({ length: 6000 }, (_, i) => ({ id: i + 1, payload: { file_id: `f${i % 50}`, content: `${i < cut ? 'apple' : 'pear'} w${i % 900} rare${i}` } }));
  const write = async (to: { upsert: typeof client.upsert }, cut: number) => {
    const points = passages(cut);
    for (let i = 0; i < points.length; i += 1000) await to.upsert(V, { points: points.slice(i, i + 1000) });
  };
  await write(client, 1300);
  // 17 words the index holds: the commonest goes.
  const question = `apple pear ${Array.from({ length: 15 }, (_, i) => `rare${i}`).join(' ')}`;
  const without = (word: string) => queryTerms(question).filter((t) => t !== word);
  assert.deepEqual(local.keywordTerms(V, question), without('pear')); // pear in 4,700, apple in 1,300

  // Another process turns it round (apple in 5,900, pear in 100) at the same size: this process counts again.
  const other = freshClient();
  await write(other, 5900);
  assert.deepEqual(local.keywordTerms(V, question), without('apple'));
  assert.deepEqual(local.keywordTerms(V, question), other.keywordTerms(V, question));
  // This process turns it back by rewriting the passages: counted again too.
  await write(client, 1300);
  assert.deepEqual(local.keywordTerms(V, question), without('pear'));
  assert.deepEqual(local.keywordTerms(V, question), freshClient().keywordTerms(V, question));
});

test('vectors another process fills in are read again into room that grows by half, not by a sixteenth', async () => {
  const X = 'unit_fill';
  await client.createCollection(X, { vectors: { size: 8 } });
  for (let i = 0; i < 3000; i += 1000) {
    await client.upsert(X, { points: Array.from({ length: 1000 }, (_, j) => ({ id: i + j + 1, payload: { file_id: `f${(i + j) % 40}`, content: `p ${i + j}` } })) });
  }
  const q = [1, 2, 3, 4, 5, 6, 7, 8];
  await client.search(X, { vector: q, limit: 3 });
  // Another process makes vectors 128 at a time (a backfill, `knowledge reembed`); this one searches after each batch.
  const other = freshClient();
  let rounds = 0;
  for (;;) {
    const missing = await other.missingVectors(X, 128);
    if (missing.length === 0) break;
    await other.setVectors(X, missing.map((m) => ({ id: m.id, vector: [m.id % 7, 1, m.id % 3, 0, 1, 0, m.id % 5, 1] })));
    await client.search(X, { vector: q, limit: 3 });
    rounds++;
  }
  const use = local.memoryUse(X);
  assert.deepEqual([rounds, use.loads, use.vectors], [24, 25, 3000]);
  // 64, then 192, 320, 480, 720, 1,080, 1,620, 2,430 and 3,645: nine arrays. Room for a sixteenth more made 24.
  assert.ok(use.allocations <= 9, JSON.stringify(use));
  assert.deepEqual(await client.search(X, { vector: q, limit: 3000 }), await freshClient().search(X, { vector: q, limit: 3000 }));
});

test('a file from before the vector_error column works read-only and while another process writes', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'kmcp-oldfile-')), 'vectors.db');
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE vec_collections (name TEXT PRIMARY KEY, dim INTEGER NOT NULL, model TEXT, passage_form TEXT);
    INSERT INTO vec_collections VALUES ('old', 4, NULL, NULL);
    CREATE TABLE vec_old (id TEXT PRIMARY KEY, file_id TEXT, payload TEXT, vector BLOB);
    CREATE INDEX vec_old_file ON vec_old (file_id);
    CREATE INDEX vec_old_novec ON vec_old (file_id) WHERE vector IS NULL;
    CREATE VIRTUAL TABLE fts_old USING fts5(tokens, content='', contentless_delete=1);`);
  const row = raw.prepare('INSERT INTO vec_old (rowid, id, file_id, payload, vector) VALUES (?, ?, ?, ?, ?)');
  row.run(1, '1', 'a', JSON.stringify({ file_id: 'a', content: 'hello world' }), new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer));
  row.run(2, '2', 'b', JSON.stringify({ file_id: 'b', content: 'second passage' }), null);
  raw.exec("INSERT INTO fts_old (rowid, tokens) VALUES (1, 'hello world'), (2, 'second passage'); PRAGMA wal_checkpoint(TRUNCATE)");
  raw.close();

  // Read-only: the column cannot be added, and everything works as it did without it.
  const ro = new LocalVectorClient(new DatabaseSync(path, { readOnly: true }));
  assert.deepEqual((await ro.keywordSearch('old', { query: 'hello', limit: 3 })).map((h) => h.id), [1]);
  assert.deepEqual((await ro.search('old', { vector: [1, 0, 0, 0], limit: 3 })).map((h) => h.id), [1]);
  assert.deepEqual((await ro.missingVectors('old', 5)).map((m) => m.id), [2]);
  assert.deepEqual([await ro.refusedVectors('old'), await ro.refuseVectors('old', [{ id: 2, reason: 'too long' }])], [0, false]);

  // Another process holds a write while this one is first used: it does not wait, and the column comes later.
  const holder = new DatabaseSync(path);
  holder.exec('BEGIN IMMEDIATE');
  const rw = new LocalVectorClient(new DatabaseSync(path));
  try {
    assert.deepEqual((await rw.keywordSearch('old', { query: 'hello', limit: 3 })).map((h) => h.id), [1]);
    assert.deepEqual((await rw.missingVectors('old', 5)).map((m) => m.id), [2]);
  } finally {
    holder.exec('COMMIT');
    holder.close();
  }
  assert.equal(await rw.refuseVectors('old', [{ id: 2, reason: 'too long' }]), true);
  assert.deepEqual([await rw.refusedVectors('old'), (await rw.missingVectors('old', 5)).length], [1, 0]);

  // A refusal is kept with when it was made, and tried again a day later.
  const check = new DatabaseSync(path);
  assert.match(String((check.prepare("SELECT vector_error FROM vec_old WHERE id = '2'").get() as { vector_error: string }).vector_error), /^\d{4}-\d\d-\d\dT[\d:.]+Z too long$/);
  check.exec("UPDATE vec_old SET vector_error = '2000-01-01T00:00:00.000Z too long' WHERE id = '2'");
  assert.deepEqual((await rw.missingVectors('old', 5)).map((m) => m.id), [2]);
  // A mark written before marks carried a time is old enough: tried again.
  check.exec("UPDATE vec_old SET vector_error = 'embeddings 400 (model): input is too large' WHERE id = '2'");
  assert.deepEqual((await rw.missingVectors('old', 5)).map((m) => m.id), [2]);

  // An older version drops the collection and makes it again, without the column: it is added again on the next call.
  check.exec(`DROP TABLE vec_old; DROP TABLE fts_old;
    CREATE TABLE vec_old (id TEXT PRIMARY KEY, file_id TEXT, payload TEXT, vector BLOB);
    CREATE INDEX vec_old_file ON vec_old (file_id);
    CREATE INDEX vec_old_novec ON vec_old (file_id) WHERE vector IS NULL;
    CREATE VIRTUAL TABLE fts_old USING fts5(tokens, content='', contentless_delete=1);`);
  check.prepare('INSERT INTO vec_old (rowid, id, file_id, payload, vector) VALUES (1, ?, ?, ?, NULL)').run('7', 'c', JSON.stringify({ file_id: 'c', content: 'made again' }));
  check.close();
  assert.deepEqual((await rw.missingVectors('old', 5)).map((m) => m.id), [7]);
  await rw.setVectors('old', [{ id: 7, vector: [0, 1, 0, 0] }]);
  assert.deepEqual([await rw.refusedVectors('old'), (await rw.search('old', { vector: [0, 1, 0, 0], limit: 1 }))[0].id], [0, 7]);
});
