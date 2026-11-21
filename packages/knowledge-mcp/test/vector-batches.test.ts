/**
 * Making vectors without holding a document's worth of them, and without one refused passage stopping the rest:
 * a long document is embedded and stored a round at a time (chunk 0 last, so a failure leaves it to be indexed
 * again), and a passage the endpoint refuses is set aside and found by keywords only. The embedding endpoint is a
 * local fake with fixed vectors: nothing leaves this machine.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|ANTHROPIC_|LLM_|EMBEDDING_|EMBED_|KNOWLEDGE_|KMCP_)/.test(k)) delete process.env[k];

/**
 * An embedding endpoint on this machine. It answers 400 "input is too large" for a text with TOO-LARGE in it, 400
 * for everything while `down`, and 401 on request number `failAt`. Each request notes how many passages the index
 * held when it came: storing in rounds shows as that number growing between requests.
 */
const fake = { down: false, failAt: 0, requests: [] as Array<{ size: number; stored: number }> };
let stored = async () => 0;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const input = JSON.parse(raw).input as string[];
    fake.requests.push({ size: input.length, stored: await stored() });
    res.setHeader('Content-Type', 'application/json');
    const fail = (status: number, message: string) => void res.writeHead(status).end(JSON.stringify({ error: { message } }));
    if (fake.down) return fail(400, 'model not loaded');
    if (fake.failAt && fake.requests.length === fake.failAt) return fail(401, 'key revoked');
    if (input.some((t) => t.includes('TOO-LARGE'))) return fail(400, 'input is too large to process. increase the physical batch size');
    res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: [1, t.length % 7, 0, 1] })) }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

Object.assign(process.env, {
  MCP_DATA_DIR: mkdtempSync(join(tmpdir(), 'kmcp-batches-')),
  EMBEDDING_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
  EMBEDDING_MODEL: 'fake-embed',
  EMBEDDING_DIM: '4',
  EMBED_INDEX_RETRIES: '0',
  EMBED_RETRY_STEPS_MS: '600000',
  // Small passages, so that a test document has a few hundred of them.
  KNOWLEDGE_CHUNK_TOKENS: '100',
  KNOWLEDGE_CHUNK_OVERLAP: '0',
});

const { indexText, getIndexedState, backfillVectors, vectorStatus } = await import('../src/plugins/drive/indexer.js');
const { ensureCollection, getLocalIndex, DRIVE_COLLECTION } = await import('../src/plugins/drive/qdrant.js');
await ensureCollection();
const local = (await getLocalIndex())!;
stored = async () => (await local.stats(DRIVE_COLLECTION)).chunks;

const file = (id: string) => ({ id, name: `${id}.md`, path: `docs/${id}.md`, modifiedTime: '2026-11-01T00:00:00Z', source: 'docs', mimeType: 'text/markdown' });
const section = (i: number, extra = '') => `# Section ${i}\n\n${extra}Paragraph ${i}: ${Array.from({ length: 70 }, (_, j) => `word${(i * 7 + j) % 50}`).join(' ')}.\n`;
const longText = (sections: number) => Array.from({ length: sections }, (_, i) => section(i)).join('\n');

test('a long document is embedded and stored a round at a time, with chunk 0 last', async () => {
  fake.requests = [];
  const chunks = await indexText(file('long'), longText(150));
  assert.ok(chunks > 256, `${chunks} passages`);
  assert.equal((await local.stats(DRIVE_COLLECTION)).withVectors, chunks);
  // Storing happened between embedding requests: the index grew while the document was still being embedded.
  const seen = fake.requests.map((r) => r.stored);
  assert.equal(seen[0], 0);
  assert.ok(seen.some((n) => n > 0) && Math.max(...seen) < chunks, String(seen));
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));

  // A failure half way (the key is refused on the sixth request) leaves the document to be indexed again: chunk 0,
  // which says it is done, was not written, though the rounds before the failure were.
  fake.requests = [];
  fake.failAt = 6;
  try {
    await assert.rejects(indexText(file('broken'), longText(150)), /401/);
  } finally {
    fake.failAt = 0;
  }
  assert.ok((await local.documentChunks(DRIVE_COLLECTION, 'broken')).length > 0);
  assert.equal(await getIndexedState('broken'), null);
  assert.equal(await indexText(file('broken'), longText(150)), chunks);
  assert.ok((await getIndexedState('broken'))?.content_hash);
});

test('a passage the endpoint refuses is set aside: every other passage gets its vector', async () => {
  // 201 passages without vectors yet, one of them too large for the model, first in line.
  await local.upsert(DRIVE_COLLECTION, {
    points: Array.from({ length: 201 }, (_, i) => ({
      id: 100_000 + i,
      payload: { file_id: `aaa-queue-${String(i).padStart(3, '0')}`, file_name: 'q.md', heading: `H${i}`, content: i === 0 ? 'TOO-LARGE passage' : `passage ${i}` },
    })),
  });
  const before = await local.stats(DRIVE_COLLECTION);
  assert.equal(before.chunks - before.withVectors, 201);
  assert.equal(await backfillVectors(), 200);
  const after1 = await local.stats(DRIVE_COLLECTION);
  assert.equal(after1.chunks - after1.withVectors, 1);
  assert.equal(await local.refusedVectors(DRIVE_COLLECTION), 1);
  assert.deepEqual(await local.missingVectors(DRIVE_COLLECTION, 10), []);
  assert.equal(vectorStatus().error, null);
  // Not asked for again, and still found by its words.
  fake.requests = [];
  assert.equal(await backfillVectors(), 0);
  assert.equal(fake.requests.length, 0);
  assert.equal((await local.keywordSearch(DRIVE_COLLECTION, { query: 'TOO-LARGE', limit: 1 }))[0].id, 100_000);

  // An endpoint that refuses everything (no model loaded) is not taken for refused passages: nothing is set aside.
  await local.upsert(DRIVE_COLLECTION, { points: [1, 2, 3].map((i) => ({ id: 200_000 + i, payload: { file_id: `down-${i}`, content: `waiting ${i}` } })) });
  fake.down = true;
  try {
    await assert.rejects(backfillVectors(), /embeddings 400 \(fake-embed\): .*model not loaded/);
  } finally {
    fake.down = false;
  }
  assert.equal(await local.refusedVectors(DRIVE_COLLECTION), 1);
  assert.equal(await backfillVectors(), 3);

  // A document indexed with vectors stores a refused passage for keywords instead of failing the whole document.
  const chunks = await indexText(file('mixed'), [section(1), section(2, 'TOO-LARGE '), section(3)].join('\n'));
  assert.ok(chunks >= 3);
  assert.equal((await local.documentChunks(DRIVE_COLLECTION, 'mixed')).length, chunks);
  assert.equal(await local.refusedVectors(DRIVE_COLLECTION), 2);

  // A new model gets another try at them.
  await local.clearVectors(DRIVE_COLLECTION, 4);
  assert.equal(await local.refusedVectors(DRIVE_COLLECTION), 0);
  assert.ok((await local.missingVectors(DRIVE_COLLECTION, 100_000)).some((m) => m.id === 100_000));
});
