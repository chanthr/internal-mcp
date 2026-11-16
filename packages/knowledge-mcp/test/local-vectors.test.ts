/**
 * Built-in vector store (used when QDRANT_URL is not set): same behaviour the Drive plugin relies on from Qdrant.
 * Cosine ranking, `must` filters including array fields, paging, delete by file and by id, 63-bit ids, a size
 * check, and the collection-size guard of ensureCollection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(QDRANT_|OPENAI_|EMBEDDING_)/.test(k)) delete process.env[k];
Object.assign(process.env, { MCP_DATA_DIR: mkdtempSync(join(tmpdir(), 'kmcp-vec-')), EMBEDDING_DIM: '4' });

const { getQdrantClient, vectorStoreKind, ensureCollection, DRIVE_COLLECTION } = await import('../src/plugins/drive/qdrant.js');
const { makeChunkId } = await import('../src/plugins/drive/indexer.js');
const client = await getQdrantClient();
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

test('ensureCollection creates the collection, and stops when the model size changed', async () => {
  await ensureCollection();
  assert.equal((await client.getCollection(DRIVE_COLLECTION)).config?.params?.vectors?.size, 4);
  await client.deleteCollection(DRIVE_COLLECTION);
  await client.createCollection(DRIVE_COLLECTION, { vectors: { size: 8 } });
  await assert.rejects(ensureCollection(), /holds 8-dimension vectors but EMBEDDING_DIM is 4/);
});
