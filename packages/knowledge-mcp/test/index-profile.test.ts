/**
 * How passages are made (index_profile.ts) and measured (measure.ts): the setting is read from the config and the
 * environment, a model's own prefixes are found by its name, documents cut another way are cut again, vectors are
 * never mixed between two forms of the passage, and comparing ways leaves the index as it is.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// A local embedding model that keeps what it was given: text with shared trigrams gets similar vectors.
const DIM = 32;
const seen: string[] = [];
const model = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const { input } = JSON.parse(raw) as { input: string[] };
    seen.push(...input);
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

const docs = mkdtempSync(join(tmpdir(), 'kmcp-profile-docs-'));
mkdirSync(join(docs, 'guides'));
const long = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `## ${topic} part ${i + 1}\n\n${`The ${topic} rule number ${i + 1} says what to do about ${topic} in case ${i + 1}. `.repeat(12)}`).join('\n\n');
writeFileSync(join(docs, 'guides', 'deploy.md'), `# Deploy\n\n${long('deploy', 6)}`);
writeFileSync(join(docs, 'guides', 'leave.md'), `# Leave\n\n${long('leave', 5)}`);
writeFileSync(join(docs, 'budget.md'), `# Budget\n\n${long('budget', 4)}`);
writeFileSync(join(docs, 'onboarding.md'), `# Onboarding\n\n${long('onboarding', 4)}`);
writeFileSync(join(docs, 'security.md'), `# Security\n\n${long('security', 4)}`);

for (const k of Object.keys(process.env)) if (/^(QDRANT_|OPENAI_|EMBEDDING_|GOOGLE_|KNOWLEDGE_|LLM_)/.test(k)) delete process.env[k];
const dataDir = mkdtempSync(join(tmpdir(), 'kmcp-profile-'));
Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: dataDir,
  EMBEDDING_DIM: String(DIM),
  // A model whose card asks for a prefix on questions and on passages.
  EMBEDDING_MODEL: 'nomic-embed-text',
  EMBEDDING_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
  EMBED_INDEX_RETRIES: '0',
  EMBED_QUERY_RETRIES: '0',
  MCP_CONFIG_JSON: JSON.stringify({ folders: [{ path: docs, name: 'docs' }], knowledge: { index: { cut: 'sections', maxTokens: 600, header: 'heading' } } }),
});
after(() => {
  rmSync(docs, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

const { indexProfile, knownPrefixes, cutMark, passageMark, LEGACY_CUT } = await import('../src/plugins/drive/index_profile.js');
const { scanFolders } = await import('../src/plugins/knowledge/folders.js');
const { backfillVectors } = await import('../src/plugins/drive/indexer.js');
const { DRIVE_COLLECTION, getLocalIndex, vectorForm } = await import('../src/plugins/drive/qdrant.js');
const { reembed } = await import('../src/plugins/knowledge/reembed.js');
const { searchIndex } = await import('../src/plugins/knowledge/hybrid.js');
const { compare, measure, measureView } = await import('../src/plugins/knowledge/measure.js');

test('the setting: the config, then the environment over it; values out of range are passed over', () => {
  const p = indexProfile();
  assert.deepEqual([p.cut, p.maxTokens, p.header], ['sections', 600, 'heading']);
  assert.equal(p.overlapTokens, 75); // follows the size: an eighth of it
  assert.equal(cutMark(p), 'sections:600:50:75');
  const env = { ...process.env, KNOWLEDGE_CHUNK_CUT: 'windows', KNOWLEDGE_CHUNK_TOKENS: '300', KNOWLEDGE_EMBED_HEADER: 'none' };
  assert.deepEqual(
    (({ cut, maxTokens, header }) => ({ cut, maxTokens, header }))(indexProfile(env)),
    { cut: 'windows', maxTokens: 300, header: 'none' },
  );
  const odd = indexProfile({ ...process.env, KNOWLEDGE_CHUNK_TOKENS: '20', KNOWLEDGE_CHUNK_CUT: 'pages', KNOWLEDGE_CHUNK_OVERLAP: '900' });
  assert.deepEqual([odd.maxTokens, odd.cut], [600, 'sections']);
  assert.ok(odd.overlapTokens < odd.maxTokens / 2, 'an overlap of half a passage or more is cut down');
});

test("a model's own prefixes are known by its name; one set by hand wins; none with Qdrant for passages", () => {
  assert.deepEqual(knownPrefixes('qwen3-embedding:0.6b'), { query: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:', passage: '' });
  assert.deepEqual(knownPrefixes('Qwen/Qwen3-Embedding-8B'), knownPrefixes('qwen3-embedding:8b'));
  assert.deepEqual(knownPrefixes('intfloat/multilingual-e5-large'), { query: 'query: ', passage: 'passage: ' });
  assert.equal(knownPrefixes('intfloat/multilingual-e5-large-instruct'), null); // another template: set by hand
  assert.deepEqual(knownPrefixes('nomic-embed-text:v1.5'), { query: 'search_query: ', passage: 'search_document: ' });
  assert.deepEqual(knownPrefixes('embeddinggemma:300m'), { query: 'task: search result | query: ', passage: 'title: none | text: ' });
  assert.equal(knownPrefixes('mxbai-embed-large')?.passage, '');
  for (const none of ['bge-m3', 'text-embedding-3-small', 'some-model', '']) assert.equal(knownPrefixes(none), null, none);

  const p = indexProfile();
  assert.deepEqual([p.prefixFrom, p.queryPrefix, p.passagePrefix], ['model', 'search_query: ', 'search_document: ']);
  const own = indexProfile({ ...process.env, EMBEDDING_QUERY_PREFIX: 'q: ' });
  assert.deepEqual([own.prefixFrom, own.queryPrefix, own.passagePrefix], ['settings', 'q: ', '']);
  // Qdrant keeps no note of what its vectors were made from: a passage prefix is not added by itself there.
  assert.equal(indexProfile({ ...process.env, QDRANT_URL: 'http://127.0.0.1:1' }).prefixFrom, null);
  assert.equal(indexProfile({ ...process.env, QDRANT_URL: 'http://127.0.0.1:1', EMBEDDING_MODEL: 'qwen3-embedding:0.6b' }).prefixFrom, 'model');
});

test('passages and questions get the prefixes, and the index notes what its vectors were made from', async () => {
  seen.length = 0;
  const r = await scanFolders();
  assert.equal(r?.indexed, 5);
  await backfillVectors();
  // (A one-word probe first checks the model answers and its size.)
  const passages = seen.filter((t) => t !== 'ping');
  assert.ok(passages.length > 5 && passages.every((t) => t.startsWith('search_document: ')), `every passage is embedded with the passage prefix: ${passages.find((t) => !t.startsWith('search_document: '))}`);
  assert.ok(seen.some((t) => t.startsWith('search_document: Deploy > deploy part')), 'with its headings');
  const local = (await getLocalIndex())!;
  assert.equal((await local.embeddingState(DRIVE_COLLECTION))?.form, passageMark());

  seen.length = 0;
  await searchIndex('what to do about leave', [], 3);
  assert.deepEqual(seen, ['search_query: what to do about leave']);
});

test('vectors made in another form are not mixed with new ones, and are searched the way they were made', async () => {
  const local = (await getLocalIndex())!;
  // As an index made before the form was kept: the default form, no prefix.
  await local.noteModel(DRIVE_COLLECTION, 'nomic-embed-text', 'heading|');
  const behind = await vectorForm();
  assert.deepEqual(behind, { header: 'heading', passagePrefix: '', queryPrefix: '', behind: true });
  seen.length = 0;
  await searchIndex('budget review', [], 3);
  assert.deepEqual(seen, ['budget review'], 'the question goes without the prefix, like the stored passages');

  const r = await reembed();
  assert.ok(r.ok);
  assert.equal((await vectorForm()).behind, false);
  assert.equal((await local.embeddingState(DRIVE_COLLECTION))?.form, 'heading|search_document: ');

  // Another header: the stored vectors are behind until new ones are made, and new passages follow the stored form.
  process.env.KNOWLEDGE_EMBED_HEADER = 'none';
  try {
    assert.deepEqual(await vectorForm(), { header: 'heading', passagePrefix: 'search_document: ', queryPrefix: 'search_query: ', behind: true });
  } finally {
    delete process.env.KNOWLEDGE_EMBED_HEADER;
  }
});

test('documents cut another way are cut again by the next scan, and only once', async () => {
  const local = (await getLocalIndex())!;
  assert.equal(await local.documentsCutOtherwise(DRIVE_COLLECTION, cutMark(), LEGACY_CUT), 0);
  const before = (await local.stats(DRIVE_COLLECTION)).chunks;
  process.env.KNOWLEDGE_CHUNK_TOKENS = '150';
  try {
    assert.equal(await local.documentsCutOtherwise(DRIVE_COLLECTION, cutMark(), LEGACY_CUT), 5);
    const r = await scanFolders();
    assert.deepEqual([r?.indexed, r?.unchanged], [5, 0]);
    assert.ok((await local.stats(DRIVE_COLLECTION)).chunks > before, 'smaller passages, more of them');
    assert.equal(await local.documentsCutOtherwise(DRIVE_COLLECTION, cutMark(), LEGACY_CUT), 0);
    const again = await scanFolders();
    assert.deepEqual([again?.indexed, again?.unchanged], [0, 5]);
  } finally {
    delete process.env.KNOWLEDGE_CHUNK_TOKENS;
  }
  // An index from before the cut was kept counts as cut the default way.
  assert.equal(await local.documentsCutOtherwise(DRIVE_COLLECTION, LEGACY_CUT, LEGACY_CUT), 5);
});

test('measuring asks the kept questions three ways; comparing cuts a sample each way and leaves the index alone', async () => {
  await scanFolders();
  await backfillVectors();
  writeFileSync(
    join(dataDir, 'search-measure.json'),
    JSON.stringify({
      questions: [
        { question: 'what to do about deploy', document: 'deploy.md' },
        { question: 'leave rule says', document: 'leave.md' },
        { question: 'budget case', document: 'budget.md' },
        { question: 'onboarding rule', document: 'onboarding.md' },
        { question: 'security in case', document: 'security.md' },
      ],
    }),
  );
  const m = await measure();
  assert.equal(m.questions, 5);
  assert.equal(m.cut, cutMark());
  for (const mode of ['keyword', 'meaning', 'both'] as const) assert.ok(m.modes[mode] && m.modes[mode]!.top10 >= 1, mode);
  assert.equal(measureView().measured.length, 1);

  const local = (await getLocalIndex())!;
  const stats = await local.stats(DRIVE_COLLECTION);
  const c = await compare();
  assert.equal(c.documents, 5);
  // The four ways offered, and the way in use (600 tokens is not one of them).
  assert.deepEqual(
    c.ways.map((w) => w.cut.split(':').slice(0, 2).join(':')),
    ['sections:800', 'sections:400', 'sections:250', 'windows:400', 'sections:600'],
  );
  assert.ok(c.ways.every((w) => w.passages > 0 && w.score.top10 >= 1));
  assert.deepEqual(await local.stats(DRIVE_COLLECTION), stats, 'the index is as it was');
  assert.ok(measureView().compared);
});

test('without questions and without a model to write them, measuring says what to do', async () => {
  rmSync(join(dataDir, 'search-measure.json'));
  await assert.rejects(measure(), /Connect a language model on the Models page.*search-measure\.json/);
});
