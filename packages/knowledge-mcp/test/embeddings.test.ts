/**
 * Embeddings against a custom OpenAI-compatible endpoint: the base URL, model and vector size come from env,
 * no key is required, `dimensions` is only sent for OpenAI text-embedding-3 models, and a vector of the wrong
 * size is an error that names EMBEDDING_DIM.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const seen: Array<{ url?: string; auth?: string; body: { model: string; input: string[]; dimensions?: number } }> = [];
let size = 4;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw);
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    // out of order on purpose: the client must sort by index
    const data = body.input.map((_: string, i: number) => ({ index: i, embedding: Array(size).fill(i + 1) })).reverse();
    res.end(JSON.stringify({ data }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

for (const k of ['OPENAI_API_KEY', 'EMBEDDING_API_KEY']) delete process.env[k];
Object.assign(process.env, {
  EMBEDDING_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`,
  EMBEDDING_MODEL: 'local-model',
  EMBEDDING_DIM: '4',
  EMBED_QUERY_RETRIES: '0',
  EMBED_INDEX_RETRIES: '0',
});
const { embedTexts, embedQuery, embeddingsConfigured, EMBEDDING_DIM, EMBEDDING_MODEL } = await import('../src/plugins/drive/embeddings.js');

test('embeddings: custom endpoint, model and size from env, no key needed', async () => {
  assert.equal(embeddingsConfigured(), true);
  assert.equal(EMBEDDING_DIM, 4);
  assert.equal(EMBEDDING_MODEL, 'local-model');
  const vecs = await embedTexts(['a', 'b', 'c']);
  assert.deepEqual(vecs, [[1, 1, 1, 1], [2, 2, 2, 2], [3, 3, 3, 3]]);
  const call = seen.at(-1)!;
  assert.equal(call.url, '/v1/embeddings');
  assert.equal(call.auth, undefined);
  assert.equal(call.body.model, 'local-model');
  assert.equal('dimensions' in call.body, false);
});

test('embeddings: a key is sent as a bearer token when set', async () => {
  process.env.EMBEDDING_API_KEY = 'test-key';
  try {
    await embedQuery('q');
    assert.equal(seen.at(-1)!.auth, 'Bearer test-key');
  } finally {
    delete process.env.EMBEDDING_API_KEY;
  }
});

test('embeddings: a vector of another size is an error that names EMBEDDING_DIM', async () => {
  size = 8;
  try {
    await assert.rejects(embedQuery('q'), /size 8 but EMBEDDING_DIM is 4/);
  } finally {
    size = 4;
  }
});

test('embeddings: the deadline covers an answer that stalls after its headers, and cancels the request before a retry', { timeout: 30_000 }, async () => {
  // Headers at once, then nothing: undici alone would wait five minutes for the body.
  let open = 0;
  let mostOpen = 0;
  let requests = 0;
  const stalling = createServer((req, res) => {
    requests++;
    mostOpen = Math.max(mostOpen, ++open);
    req.on('close', () => open--);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"data":[');
  });
  await new Promise<void>((r) => stalling.listen(0, '127.0.0.1', r));
  const saved = { ...process.env };
  Object.assign(process.env, {
    EMBEDDING_BASE_URL: `http://127.0.0.1:${(stalling.address() as AddressInfo).port}/v1`,
    EMBED_QUERY_TIMEOUT_MS: '300',
    EMBED_QUERY_RETRIES: '1',
  });
  try {
    const started = Date.now();
    await assert.rejects(embedQuery('q'), /504 deadline \(timeout 300ms\)/);
    assert.ok(Date.now() - started < 10_000, `${Date.now() - started} ms`);
    // Two tries, never both open: the first was cancelled, not left running beside the retry.
    assert.deepEqual([requests, mostOpen], [2, 1]);
  } finally {
    for (const k of ['EMBEDDING_BASE_URL', 'EMBED_QUERY_TIMEOUT_MS', 'EMBED_QUERY_RETRIES']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    stalling.closeAllConnections();
    stalling.close();
  }
});
