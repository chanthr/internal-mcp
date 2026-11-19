/**
 * Reading scanned documents: the OCR settings, a vision model behind an OpenAI-style endpoint reading each page,
 * the run that reads the waiting files of a folder, what was read being kept, and the console's routes. The model
 * and Ollama are local fakes, so nothing leaves this machine.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(GOOGLE_|DRIVE_|QDRANT_|OPENAI_|LLM_|EMBEDDING_|KNOWLEDGE_|KMCP_|OCR_|MATHPIX_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), 'kmcp-ocr-'));
const docs = join(dir, 'docs');
mkdirSync(docs);
writeFileSync(join(dir, 'mcp.config.json'), JSON.stringify({ folders: [{ path: docs, name: 'docs' }] }));
writeFileSync(join(dir, '.env'), '');
Object.assign(process.env, {
  MCP_STORE: 'sqlite',
  MCP_DATA_DIR: join(dir, 'data'),
  MCP_CONFIG_PATH: join(dir, 'mcp.config.json'),
  MCP_ENV_FILE: join(dir, '.env'),
  KMCP_SUPERVISE: 'false',
  KNOWLEDGE_CONSOLE: 'on',
  KNOWLEDGE_SCAN_ENABLED: 'false',
  PORT: '0',
});

// A vision model: it "reads" a page by answering with what the test says the page holds, and keeps what it was sent.
const seen: Array<{ model: string; prompt: string; image: string }> = [];
let reads: (n: number) => string = () => '';
const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
const model = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const body = JSON.parse(await read(req));
  const parts = body.messages[0].content;
  seen.push({ model: body.model, prompt: parts.find((p: any) => p.type === 'text').text, image: parts.find((p: any) => p.type === 'image_url').image_url.url.slice(0, 22) });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: reads(seen.length) } }] }));
});
// Ollama's own API: the models it has, and fetching one.
const ollama = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'glm-ocr:q8_0' }] }));
  if (req.url === '/api/pull') {
    const { model: wanted } = JSON.parse(await read(req));
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
    res.write(`${JSON.stringify({ status: 'downloading', total: 1000, completed: 400 })}\n`);
    res.end(`${JSON.stringify(wanted === 'missing:model' ? { error: 'pull model manifest: file does not exist' } : { status: 'success' })}\n`);
    return;
  }
  res.writeHead(404).end();
});
for (const s of [model, ollama]) await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
const modelBase = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
const ollamaBase = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}/v1`;

const { ocrSettings, ocrPrompt, checkOcr, checkPdf, ocrIsLocal, keptOcr } = await import('../src/plugins/drive/ocr.js');
const { scanFolders } = await import('../src/plugins/knowledge/folders.js');
const { startOcrRun, ocrRun, ocrWaiting } = await import('../src/plugins/knowledge/ocr_run.js');
const { DRIVE_COLLECTION, getLocalIndex } = await import('../src/plugins/drive/qdrant.js');
const { mimeForFileName } = await import('../src/plugins/drive/extract_text.js');
const { consoleToken } = await import('../src/admin/auth.js');
const { runHttp } = await import('../src/server/http.js');
const { Registry } = await import('../src/plugin/registry.js');
const { builtinPlugins } = await import('../src/plugins/index.js');

const server = await runHttp(new Registry(builtinPlugins));
const token = consoleToken();
after(async () => {
  model.close();
  ollama.close();
  await server.close();
});
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://localhost:${server.port}/console/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};
const useModel = (m = 'glm-ocr:q8_0') => Object.assign(process.env, { OCR_PROVIDER: 'model', OCR_BASE_URL: modelBase, OCR_MODEL: m });
const noOcr = () => {
  for (const k of ['OCR_PROVIDER', 'OCR_BASE_URL', 'OCR_MODEL', 'OCR_API_KEY', 'OCR_AUTO', 'MATHPIX_APP_ID', 'MATHPIX_APP_KEY']) delete process.env[k];
};
const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
};

test('the settings: a model with its own prompt, Mathpix as before, nothing when half set', () => {
  assert.equal(ocrSettings({}), null);
  assert.equal(ocrSettings({ OCR_PROVIDER: 'model', OCR_MODEL: 'x' }), null, 'no address');
  assert.deepEqual(ocrSettings({ OCR_PROVIDER: 'model', OCR_BASE_URL: 'http://localhost:11434/v1/', OCR_MODEL: 'glm-ocr:q8_0' }), { kind: 'model', baseUrl: 'http://localhost:11434/v1', apiKey: undefined, model: 'glm-ocr:q8_0', prompt: 'Text Recognition:' });
  assert.equal(ocrPrompt('deepseek-ocr:3b'), 'Free OCR.');
  assert.match(ocrPrompt('qwen3-vl:8b-instruct'), /^Transcribe all the text/);
  // Only the Mathpix keys, as before this setting existed.
  assert.equal(ocrSettings({ MATHPIX_APP_ID: 'a', MATHPIX_APP_KEY: 'b' })?.kind, 'mathpix');
  assert.equal(ocrIsLocal(ocrSettings({ OCR_PROVIDER: 'model', OCR_BASE_URL: 'https://router.huggingface.co/v1', OCR_MODEL: 'Qwen/Qwen3-VL-8B-Instruct' })), false);
});

test('the check draws a page with a number on it, and the model has to read the number back', async () => {
  const s = ocrSettings({ OCR_PROVIDER: 'model', OCR_BASE_URL: modelBase, OCR_MODEL: 'glm-ocr:q8_0' })!;
  seen.length = 0;
  let asked = '';
  reads = () => asked;
  // The model is sent a PNG of the page: the test reads the number back from the PDF it drew.
  const original = checkPdf;
  assert.ok(original('Knowledge MCP check 1234').toString('latin1').includes('(Knowledge MCP check 1234) Tj'));
  reads = () => 'nothing useful';
  await assert.rejects(checkOcr(s), /did not read the test page \(it wrote: "nothing useful"\)/);
  assert.equal(seen[0].image, 'data:image/png;base64,');
  assert.equal(seen[0].prompt, 'Text Recognition:');
  // A model that reads it: the number is in the request's page, so the fake answers every four-digit number it might be.
  reads = () => Array.from({ length: 9000 }, (_, i) => String(1000 + i)).join(' ');
  assert.ok((await checkOcr(s)).seconds >= 0);
});

test('a folder scan leaves a scan for the OCR run, which reads it page by page and keeps what it read', async () => {
  noOcr();
  // Too little text per page to count as text: a scan, as far as the index is concerned.
  writeFileSync(join(docs, 'contract.pdf'), checkPdf('Signed copy'));
  writeFileSync(join(docs, 'notes.md'), '# Notes\n\nPlain text is read as it is.\n');
  writeFileSync(join(docs, 'whiteboard.png'), 'not really a png');
  let r = await scanFolders();
  assert.deepEqual([r?.indexed, r?.skipped], [1, 1], 'the image is not even listed without OCR');
  assert.equal(mimeForFileName('whiteboard.png'), null);
  assert.equal(ocrWaiting(), 1);

  useModel();
  assert.equal(mimeForFileName('whiteboard.png'), 'image/png');
  r = await scanFolders();
  assert.equal(ocrWaiting(), 2, 'with OCR set, the image waits too');

  seen.length = 0;
  reads = () => 'Lease agreement between the parties, signed in March.';
  startOcrRun();
  await until(() => !ocrRun()?.running);
  const run = ocrRun()!;
  assert.deepEqual([run.read, run.failed.length, run.total], [2, 0, 2]);
  assert.equal(seen.length, 2);
  assert.equal(ocrWaiting(), 0);
  const hits = await (await getLocalIndex())!.keywordSearch(DRIVE_COLLECTION, { query: 'lease agreement', limit: 5, with_payload: true });
  assert.deepEqual(hits.map((h) => h.payload?.file_name).sort(), ['contract.pdf', 'whiteboard.png']);
  assert.ok(keptOcr(join(docs, 'contract.pdf'), '') === null, 'kept under the file as it was, not any stamp');

  // The next scan, and a scan after the cut changed, use what was kept: the model is not asked again.
  process.env.KNOWLEDGE_CHUNK_TOKENS = '300';
  try {
    await scanFolders();
  } finally {
    delete process.env.KNOWLEDGE_CHUNK_TOKENS;
  }
  assert.equal(seen.length, 2);
  assert.equal((await (await getLocalIndex())!.keywordSearch(DRIVE_COLLECTION, { query: 'lease agreement', limit: 5, with_payload: true })).length, 2);
});

test('a model that is down stops the run after three failures, and says why', async () => {
  for (const name of ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']) writeFileSync(join(docs, name), checkPdf(`Copy ${name}`));
  Object.assign(process.env, { OCR_PROVIDER: 'model', OCR_BASE_URL: 'http://127.0.0.1:9/v1', OCR_MODEL: 'glm-ocr:q8_0' });
  try {
    await scanFolders();
    startOcrRun();
    await until(() => !ocrRun()?.running);
    const run = ocrRun()!;
    assert.equal(run.failed.length, 3);
    assert.match(run.failed[0].why, /could not be reached/);
    assert.equal(run.stopped, 'Stopped after three files failed in a row.');
    assert.equal(ocrWaiting(), 4, 'what failed still waits');
  } finally {
    useModel();
  }
});

test('the console: set up after the check, Ollama models fetched with progress, reading started and stopped', async () => {
  noOcr();
  // Saved only after the model read the test page.
  reads = () => 'nothing';
  const bad = await api('POST', '/services/ocr', { provider: 'model', baseUrl: modelBase, model: 'glm-ocr:q8_0' });
  assert.ok(bad.status >= 400);
  assert.match(bad.json.error, /did not read the test page/);
  assert.doesNotMatch(readFileSync(join(dir, '.env'), 'utf8').toString(), /OCR_PROVIDER/);
  reads = () => Array.from({ length: 9000 }, (_, i) => String(1000 + i)).join(' ');
  const good = await api('POST', '/services/ocr', { provider: 'model', baseUrl: modelBase, model: 'glm-ocr:q8_0', apiKey: 'hf_test_token_123' });
  assert.equal(good.status, 200);
  assert.match(good.json.found, /glm-ocr:q8_0 read the test page/);
  const env = readFileSync(join(dir, '.env'), 'utf8');
  assert.match(env, /OCR_PROVIDER=model/);
  assert.match(env, /OCR_API_KEY=hf_test_token_123/);
  // Mathpix keys are saved as given (a test would be billed).
  assert.equal((await api('POST', '/services/ocr', { provider: 'mathpix', appId: 'app', appKey: 'short' })).status, 400);

  // Ollama: what it has, and fetching another, with progress; a model it does not know says so.
  const status = await api('GET', '/ocr');
  assert.equal(status.status, 200);
  assert.equal(typeof status.json.waiting, 'number');
  const pulled = async () => {
    let r = await api('GET', '/ocr');
    for (let i = 0; i < 100 && r.json.pull?.running; i++) r = await api('GET', '/ocr');
    return r;
  };
  await api('POST', '/ocr/pull', { model: 'qwen3-vl:8b-instruct', baseUrl: ollamaBase });
  const pull = await pulled();
  assert.deepEqual([pull.json.pull.model, pull.json.pull.running, pull.json.pull.status, pull.json.pull.error], ['qwen3-vl:8b-instruct', false, 'success', null]);
  await api('POST', '/ocr/pull', { model: 'missing:model', baseUrl: ollamaBase });
  assert.match((await pulled()).json.pull.error, /does not exist/);
  assert.match((await api('POST', '/ocr/pull', { model: 'x', baseUrl: 'https://example.com/v1' })).json.error ?? '', /on this computer/);
  assert.equal((await api('POST', '/ocr/pull', { model: 'bad name; rm -rf', baseUrl: ollamaBase })).status, 400);

  // Reading from the page: refused without an OCR in this process, then started and stopped.
  assert.match((await api('POST', '/ocr/run', {})).json.error, /No OCR is set/);
  useModel();
  writeFileSync(join(docs, 'e.pdf'), checkPdf('Copy e'));
  await scanFolders();
  const started = await api('POST', '/ocr/run', { limit: 1 });
  assert.deepEqual([started.status, started.json.total], [200, 1]);
  await api('POST', '/ocr/stop');
  await until(() => !ocrRun()?.running);
  assert.equal(ocrRun()?.running, false);
});
