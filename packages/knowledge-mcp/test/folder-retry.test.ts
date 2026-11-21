/**
 * A large new document in a local folder whose first index fails half way is read again by the next pass. Its chunk
 * 0, written last, is what says it was indexed whole; the chunks written before the failure must not make it look
 * unchanged. No embedding model: keyword search only, nothing leaves this machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|ANTHROPIC_|LLM_|EMBEDDING_|EMBED_|KNOWLEDGE_|KMCP_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'kmcp-folder-retry-'));
const docs = join(dir, 'docs');
mkdirSync(docs);
// About 300 passages: more than one round of 128, so the round with chunk 0 is not the first written.
const section = (i: number) => `# Section ${i}\n\nuniq${i}word ${Array.from({ length: 60 }, (_, j) => `filler${(i + j) % 40}`).join(' ')}.\n`;
writeFileSync(join(docs, 'big.md'), Array.from({ length: 300 }, (_, i) => section(i)).join('\n'));
writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ folders: [{ path: docs, name: 'docs' }] }));
Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: join(dir, 'data'),
  MCP_CONFIG_PATH: join(dir, 'mcp.config.json'),
  MCP_ENV_FILE: 'none',
  KNOWLEDGE_SCAN_ENABLED: 'false',
  KNOWLEDGE_CHUNK_TOKENS: '100',
  KNOWLEDGE_CHUNK_OVERLAP: '0',
});

const { scanFolders } = await import('../src/plugins/knowledge/folders.js');
const { getLocalIndex, DRIVE_COLLECTION } = await import('../src/plugins/drive/qdrant.js');
const { LocalVectorClient } = await import('../src/plugins/drive/local_vectors.js');

test('a document whose first index failed after some rounds is read again by the next pass', async () => {
  // One failed write of the round with chunk 0, as a full disk or another process's long lock would make it.
  let failOnce = true;
  const upsert = LocalVectorClient.prototype.upsert;
  LocalVectorClient.prototype.upsert = async function (this: InstanceType<typeof LocalVectorClient>, name, body) {
    if (failOnce && body.points.some((p) => (p.payload as { chunk_index?: number } | undefined)?.chunk_index === 0)) {
      failOnce = false;
      throw new Error('database is full (injected)');
    }
    return upsert.call(this, name, body);
  };
  try {
    const local = (await getLocalIndex())!;
    const chunks = async () => (await local.documentChunks(DRIVE_COLLECTION, 'local:docs/big.md')).map((p) => p?.chunk_index as number);
    const found = async (word: string) => (await local.keywordSearch(DRIVE_COLLECTION, { query: word, limit: 1 })).length;

    const first = await scanFolders(() => undefined);
    assert.deepEqual([first?.indexed, first?.errored], [0, 1]);
    const partial = await chunks();
    assert.ok(partial.length > 0 && !partial.includes(0), 'rounds before the failure were stored, chunk 0 was not');

    // The next pass reads it again: it is not taken for unchanged, though its other chunks carry its modified time.
    const second = await scanFolders(() => undefined);
    assert.deepEqual([second?.indexed, second?.unchanged, second?.errored], [1, 0, 0]);
    const whole = await chunks();
    assert.ok(whole.includes(0) && whole.length > partial.length);
    assert.deepEqual([await found('uniq5word'), await found('uniq200word')], [1, 1]);
    // Indexed whole, it is unchanged from then on.
    const third = await scanFolders(() => undefined);
    assert.deepEqual([third?.indexed, third?.unchanged], [0, 1]);
  } finally {
    LocalVectorClient.prototype.upsert = upsert;
  }
});
