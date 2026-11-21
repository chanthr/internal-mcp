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
 * An embedding endpoint on this machine. It answers 400 "input is too large" for a text `refuse` picks (one with
 * TOO-LARGE in it), 400 for everything while `down` or after request number `downAfter`, and 401 on request number
 * `failAt`. Each request notes how many passages the index held when it came: storing in rounds shows as that number
 * growing between requests.
 */
const fake = {
  down: false,
  failAt: 0,
  downAfter: 0,
  refuse: (t: string) => t.includes('TOO-LARGE'),
  requests: [] as Array<{ size: number; stored: number }>,
};
let stored = async () => 0;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const input = JSON.parse(raw).input as string[];
    fake.requests.push({ size: input.length, stored: await stored() });
    res.setHeader('Content-Type', 'application/json');
    const fail = (status: number, message: string) => void res.writeHead(status).end(JSON.stringify({ error: { message } }));
    if (fake.down || (fake.downAfter && fake.requests.length > fake.downAfter)) return fail(400, 'model not loaded');
    if (fake.failAt && fake.requests.length === fake.failAt) return fail(401, 'key revoked');
    if (input.some(fake.refuse)) return fail(400, 'input is too large to process. increase the physical batch size');
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

const { indexText, getIndexedState, backfillVectors, vectorStatus, embedEach, fillMissingVectors } = await import('../src/plugins/drive/indexer.js');
const { ensureCollection, getLocalIndex, DRIVE_COLLECTION } = await import('../src/plugins/drive/qdrant.js');
await ensureCollection();
const local = (await getLocalIndex())!;
stored = async () => (await local.stats(DRIVE_COLLECTION)).chunks;

const file = (id: string) => ({ id, name: `${id}.md`, path: `docs/${id}.md`, modifiedTime: '2026-11-01T00:00:00Z', source: 'docs', mimeType: 'text/markdown' });
const section = (i: number, extra = '') => `# Section ${i}\n\n${extra}Paragraph ${i}: ${Array.from({ length: 70 }, (_, j) => `word${(i * 7 + j) % 50}`).join(' ')}.\n`;
const longText = (sections: number, version = '') => Array.from({ length: sections }, (_, i) => section(i, version && `${version}${i} `)).join('\n');

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

  // A failure half way (the key is refused on the sixth request, after one round was stored) leaves the document to
  // be indexed again: chunk 0, which says it is done, was not written, and what the run did write is gone again.
  fake.requests = [];
  fake.failAt = 6;
  try {
    await assert.rejects(indexText(file('broken'), longText(150)), /401/);
  } finally {
    fake.failAt = 0;
  }
  assert.ok(fake.requests.some((r) => r.stored > 0), 'a round was stored before the failure');
  assert.equal((await local.documentChunks(DRIVE_COLLECTION, 'broken')).length, 0);
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

test('a version that fails half way leaves no passages behind, before or after the next version', async () => {
  const v1 = await indexText(file('versions'), longText(40, 'vone'));
  const stored = async () => (await local.documentChunks(DRIVE_COLLECTION, 'versions')).map((p) => String(p?.content));
  // A longer version fails after one round of passages past the end of the first was stored.
  fake.requests = [];
  fake.failAt = 6;
  try {
    await assert.rejects(indexText(file('versions'), longText(150, 'vtwo')), /401/);
  } finally {
    fake.failAt = 0;
  }
  const afterFailure = await stored();
  assert.equal(afterFailure.length, v1);
  assert.ok(afterFailure.every((t) => !t.includes('vtwo')));
  assert.equal((await getIndexedState('versions'))?.chunk_count, v1);
  // A shorter third version leaves exactly its own passages, and the failed one's words find nothing.
  const v3 = await indexText(file('versions'), longText(30, 'vthree'));
  assert.ok(v3 < v1);
  const after = await stored();
  assert.equal(after.length, v3);
  assert.ok(after.every((t) => !t.includes('vone') && !t.includes('vtwo')));
  assert.deepEqual(await local.keywordSearch(DRIVE_COLLECTION, { query: 'vtwo100', limit: 3 }), []);
});

test('an endpoint that stops answering while refused passages are looked for sets nothing aside', async () => {
  // Request counts for 128 passages: one refused is found by halving; many refused are sent one at a time.
  const count = async (refuse: (t: string) => boolean) => {
    fake.refuse = refuse;
    fake.requests = [];
    try {
      const out = await embedEach(Array.from({ length: 128 }, (_, i) => `x${i}`));
      return [fake.requests.length, out.filter((v) => !Array.isArray(v)).length];
    } finally {
      fake.refuse = (t) => t.includes('TOO-LARGE');
    }
  };
  const one = await count((t) => t === 'x0');
  const everyOther = await count((t) => /^x\d*[02468]$/.test(t));
  const every = await count((t) => t.startsWith('x'));
  assert.deepEqual([one[1], everyOther[1], every[1]], [1, 64, 128]);
  assert.ok(one[0] <= 20 && everyOther[0] <= 150 && every[0] <= 150, JSON.stringify({ one, everyOther, every })); // halving alone: 16, 256, 256

  // 128 passages wait for a vector, one too large; they come first in line (missingVectors goes by file id). The
  // endpoint answers the probe, then refuses everything.
  await local.upsert(DRIVE_COLLECTION, {
    points: Array.from({ length: 128 }, (_, i) => ({ id: 500_000 + i, payload: { file_id: `0000-${i}`, file_name: 'q.md', heading: 'h', content: i === 5 ? 'TOO-LARGE x' : `passage ${i}` } })),
  });
  const waiting = async () => (await local.missingVectors(DRIVE_COLLECTION, 10_000)).filter((m) => String(m.payload?.file_id).startsWith('0000-')).length;
  const refusedBefore = await local.refusedVectors(DRIVE_COLLECTION);
  fake.requests = [];
  fake.downAfter = 2; // 1: the batch, refused for the large passage; 2: the probe, answered; then down
  try {
    await assert.rejects(fillMissingVectors(128), /model not loaded/);
  } finally {
    fake.downAfter = 0;
  }
  assert.equal(await local.refusedVectors(DRIVE_COLLECTION), refusedBefore);
  assert.equal(await waiting(), 128);
  // Up again: only the large passage is set aside.
  assert.deepEqual(await fillMissingVectors(128), { handled: 128, made: 127 });
  assert.deepEqual([await local.refusedVectors(DRIVE_COLLECTION), await waiting()], [refusedBefore + 1, 0]);
});
