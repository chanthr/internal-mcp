/**
 * Qdrant REST client against a real Qdrant server. Runs when QDRANT_TEST_URL is set (CI starts a qdrant
 * service container); skipped otherwise. Covers every call the Drive plugin makes.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { QdrantClient, QdrantError } from '../src/plugins/drive/qdrant.js';

const url = process.env.QDRANT_TEST_URL;
const skip = url ? false : 'set QDRANT_TEST_URL to run against a real Qdrant';
const name = `kmcp_test_${Date.now()}`;
const client = url ? new QdrantClient(url) : (null as unknown as QdrantClient);

after(async () => {
  if (url) await client.deleteCollection(name).catch(() => undefined);
});

test('collection lifecycle, payload index, upsert, retrieve, search, scroll, delete', { skip }, async () => {
  assert.equal(await client.createCollection(name, { vectors: { size: 4, distance: 'Cosine' } }), true);
  assert.ok((await client.getCollections()).collections.some((c) => c.name === name));
  await client.createPayloadIndex(name, { field_name: 'file_id', field_schema: 'keyword' });

  await client.upsert(name, {
    points: [
      { id: 1, vector: [1, 0, 0, 0], payload: { file_id: 'a', chunk_index: 0, content: '첫 청크' } },
      { id: 2, vector: [0.9, 0.1, 0, 0], payload: { file_id: 'a', chunk_index: 1, content: '둘째 청크' } },
      { id: 3, vector: [0, 0, 1, 0], payload: { file_id: 'b', chunk_index: 0, content: '다른 파일' } },
    ],
  });

  const got = await client.retrieve(name, { ids: [2], with_payload: true, with_vector: false });
  assert.equal(got[0]!.payload!.content, '둘째 청크');

  const hits = await client.search(name, { vector: [1, 0, 0, 0], limit: 2, with_payload: true, filter: { must: [{ key: 'file_id', match: { value: 'a' } }] } });
  assert.deepEqual(hits.map((h) => h.id), [1, 2]);
  assert.ok(hits[0]!.score > hits[1]!.score);

  const page1 = await client.scroll(name, { limit: 2, with_payload: ['file_id'], with_vector: false });
  assert.equal(page1.points.length, 2);
  assert.notEqual(page1.next_page_offset ?? null, null);
  const page2 = await client.scroll(name, { limit: 2, offset: page1.next_page_offset!, with_payload: ['file_id'] });
  assert.equal(page2.points.length, 1);

  await client.delete(name, { points: [2] });
  await client.delete(name, { filter: { must: [{ key: 'file_id', match: { value: 'b' } }] } });
  const rest = await client.scroll(name, { limit: 10 });
  assert.deepEqual(rest.points.map((p) => p.id), [1]);
});

test('errors carry the status and Qdrant message', { skip }, async () => {
  await assert.rejects(client.search('kmcp_missing_collection', { vector: [1, 0, 0, 0], limit: 1 }), (e: unknown) => {
    assert.ok(e instanceof QdrantError);
    assert.equal(e.status, 404);
    assert.match(e.message, /kmcp_missing_collection/);
    return true;
  });
});

test('network failure is a QdrantError with status 0', async () => {
  const dead = new QdrantClient('http://127.0.0.1:9');
  await assert.rejects(dead.getCollections(), (e: unknown) => e instanceof QdrantError && e.status === 0);
});
