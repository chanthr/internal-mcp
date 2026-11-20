/**
 * Vectors made by themselves: a file that changes is read within seconds (the folders are watched), a model on
 * this machine gets small batches and long timeouts, and vectors that could not be made are tried again soon and
 * said on the console. The embedding endpoint is a local fake: nothing leaves this machine.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|ANTHROPIC_|LLM_|EMBEDDING_|EMBED_|KNOWLEDGE_|KMCP_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'kmcp-embed-'));
const docs = join(dir, 'docs');
mkdirSync(docs);
for (let i = 0; i < 40; i++) writeFileSync(join(docs, `note-${i}.md`), `# Note ${i}\n\nPassage ${i} about deploys and rollbacks.\n`);
writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ folders: [{ path: docs, name: 'docs' }] }));

/** An embedding endpoint on this machine: four numbers per text, or a failure while `down`. */
const fake = { down: true, batches: [] as number[] };
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (fake.down) return void res.writeHead(400).end(JSON.stringify({ error: { message: 'model not loaded' } }));
    const input = JSON.parse(raw).input as string[];
    fake.batches.push(input.length);
    res.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0, 0, index % 2] })) }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: join(dir, 'data'),
  MCP_CONFIG_PATH: join(dir, 'mcp.config.json'),
  MCP_ENV_FILE: 'none',
  KNOWLEDGE_SCAN_ENABLED: 'false',
  EMBEDDING_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
  EMBEDDING_MODEL: 'fake-embed',
  EMBEDDING_DIM: '4',
  EMBED_RETRY_STEPS_MS: '40',
});

const { embeddingsLocal } = await import('../src/plugins/drive/embeddings.js');
const { vectorStatus } = await import('../src/plugins/drive/indexer.js');
const { scanFolders, localFolders } = await import('../src/plugins/knowledge/folders.js');
const { getLocalIndex, DRIVE_COLLECTION } = await import('../src/plugins/drive/qdrant.js');
const { watchFolders, worthAPass } = await import('../src/plugins/knowledge/watch.js');

const until = async (what: () => boolean | Promise<boolean>, ms = 15_000) => {
  for (let t = 0; t < ms; t += 20) {
    if (await what()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waited too long');
};

test('vectors that could not be made are said, tried again soon, and made once the model answers', async () => {
  assert.equal(embeddingsLocal(), true);
  // The model is not there yet: the text is indexed for keywords, and the failure is kept for the console.
  await scanFolders();
  const stats = await (await getLocalIndex())!.stats(DRIVE_COLLECTION);
  assert.deepEqual([stats.chunks >= 40, stats.withVectors], [true, 0]);
  // Kept for the console until a round succeeds. (When it is tried again is not asserted: under load the first
  // retry, 40 ms here, may already be running.)
  assert.match(vectorStatus().error ?? '', /embeddings 400 \(fake-embed\): .*model not loaded/);

  // The model comes up: the retry makes every vector, in batches small enough for a model on this machine.
  fake.down = false;
  await until(async () => (await (await getLocalIndex())!.stats(DRIVE_COLLECTION)).withVectors === stats.chunks);
  const done = vectorStatus();
  assert.deepEqual([done.error, done.retryAt, done.filled], [null, null, stats.chunks]);
  assert.ok(fake.batches.every((n) => n <= 32) && fake.batches.length >= 2, String(fake.batches));
});

test('a file saved in a folder is noticed within seconds; hidden and temporary files are not', async () => {
  assert.deepEqual(
    ['notes.md', '.DS_Store', 'sub/.git/HEAD', '~$report.docx', 'draft.md.swp', 'big.pdf.crdownload', null].map(worthAPass),
    [true, false, false, false, false, false, true],
  );
  let passes = 0;
  const stop = watchFolders(localFolders(), () => passes++, () => undefined, 60);
  try {
    // Watching starts a moment after it is asked for on some systems.
    await new Promise((r) => setTimeout(r, 150));
    writeFileSync(join(docs, '.hidden.md'), 'x');
    writeFileSync(join(docs, '~$open.docx'), 'x');
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(passes, 0, 'hidden and temporary files are not changes of a document');
    // Several saves in a row are one pass.
    for (let i = 0; i < 3; i++) writeFileSync(join(docs, 'new.md'), `# New\n\nSaved ${i}.\n`);
    await until(() => passes > 0);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(passes, 1);
  } finally {
    stop();
  }
});
