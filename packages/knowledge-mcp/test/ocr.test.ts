/**
 * Reading scanned documents: the OCR settings, a vision model behind an OpenAI-style endpoint reading each page,
 * the run that reads the waiting files of a folder, what was read being kept, and the console's routes. The model
 * and Ollama are local fakes, so nothing leaves this machine.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
const seen: Array<{ model: string; prompt: string; image: string; maxTokens: number }> = [];
let reads: (n: number) => string = () => '';
/** The status the model answers its n-th request with (counted from the start of the file), and the image it was sent. */
let status: (n: number, image: Buffer) => number = () => 200;
const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
const model = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const body = JSON.parse(await read(req));
  const parts = body.messages[0].content;
  const url: string = parts.find((p: any) => p.type === 'image_url').image_url.url;
  seen.push({ model: body.model, prompt: parts.find((p: any) => p.type === 'text').text, image: url.slice(0, 22), maxTokens: body.max_tokens });
  const code = status(seen.length, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  if (code !== 200) return void res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'the page could not be read' } }));
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
const { startAutoOcrRun, startOcrRun, ocrRun, ocrWaiting } = await import('../src/plugins/knowledge/ocr_run.js');
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

/** A scan of two pages, each with a line on it, drawn as checkPdf draws one. */
function twoPages(first: string, second: string): Buffer {
  const text = (line: string) => {
    const stream = `BT /F1 36 Tf 60 400 Td (${line}) Tj ET`;
    return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  };
  const page = (contents: number) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 7 0 R >> >> >>`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', page(5), page(6), text(first), text(second), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${out}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1');
}
/** Folder passes, each followed by the run that starts by itself: how many runs started. */
async function autoPasses(n: number): Promise<number> {
  let started = 0;
  for (let pass = 0; pass < n; pass++) {
    if (startAutoOcrRun()) started++;
    await until(() => !ocrRun()?.running);
  }
  return started;
}

test('a scan the model cannot read is tried again by itself only a few times while it is unchanged; the console still tries it', async () => {
  useModel();
  process.env.OCR_AUTO = 'true';
  writeFileSync(join(docs, 'torn.pdf'), twoPages('Torn copy', 'Torn page two'));
  await scanFolders();
  assert.equal(ocrWaiting(), 1);
  // The model reads the first page of each try and cannot read the second: the file's fault, not the model's.
  const before = seen.length;
  status = (n) => ((n - before) % 2 === 0 ? 400 : 200);
  try {
    // After every folder pass (every ten minutes, and after every change) a run would start by itself.
    assert.equal(await autoPasses(6), 3);
    assert.equal(seen.length - before, 6, 'two pages a try');
    assert.equal(ocrWaiting(), 1, 'it still waits');
    // A run started from the console tries it all the same.
    startOcrRun();
    await until(() => !ocrRun()?.running);
    assert.deepEqual([ocrRun()!.failed.length, seen.length - before], [1, 8]);
    // Another OCR may read it: with another model it is tried again by itself.
    process.env.OCR_MODEL = 'deepseek-ocr:3b';
    assert.equal(await autoPasses(1), 1);
    useModel();
    // Changed, it is tried again by itself, and now the model reads it.
    status = () => 200;
    reads = () => 'A torn copy, read at last.';
    const later = new Date(Date.now() + 5000);
    utimesSync(join(docs, 'torn.pdf'), later, later);
    await scanFolders();
    assert.ok(startAutoOcrRun());
    await until(() => !ocrRun()?.running);
    assert.deepEqual([ocrRun()!.read, ocrWaiting()], [1, 0]);
  } finally {
    status = () => 200;
    delete process.env.OCR_AUTO;
  }
});

test('an OCR that is not running, or broken for a moment, gives up on no file: once it answers, the waiting files are read', async () => {
  useModel();
  process.env.OCR_AUTO = 'true';
  for (const name of ['p.pdf', 'q.pdf']) writeFileSync(join(docs, name), checkPdf(`Copy ${name}`));
  try {
    // The OCR on this computer is not running: nothing answers on its port.
    process.env.OCR_BASE_URL = 'http://127.0.0.1:9/v1';
    await scanFolders();
    assert.equal(ocrWaiting(), 2);
    assert.equal(await autoPasses(4), 4);
    // Then it runs, and fails for a moment (it is still loading the model).
    useModel();
    status = () => 503;
    assert.equal(await autoPasses(4), 4);
    // It answers: the next run reads both.
    status = () => 200;
    reads = () => 'A copy, readable again.';
    assert.ok(startAutoOcrRun());
    await until(() => !ocrRun()?.running);
    assert.deepEqual([ocrRun()!.read, ocrWaiting()], [2, 0]);
  } finally {
    status = () => 200;
    delete process.env.OCR_AUTO;
    useModel();
  }
});

test('scans the model refuses do not hold up the ones behind them, and are left alone after a few passes', async () => {
  useModel();
  process.env.OCR_AUTO = 'true';
  // Three images first in the list that the model refuses (the file's fault), and one it reads behind them.
  for (const name of ['a1', 'a2', 'a3']) writeFileSync(join(docs, `${name}.png`), `BAD-${name}`);
  writeFileSync(join(docs, 'z-good.png'), 'GOOD-z');
  const before = seen.length;
  status = (_n, image) => (image.toString().startsWith('BAD') ? 400 : 200);
  reads = () => 'Receipt for coffee and cake.';
  try {
    await scanFolders();
    assert.equal(ocrWaiting(), 4);
    // The first run stops after three failures in a row; the next takes the one it can read first.
    assert.equal(await autoPasses(1), 1);
    assert.equal(ocrWaiting(), 4);
    assert.equal(await autoPasses(1), 1);
    assert.equal(ocrWaiting(), 3, 'the good one was read');
    // Three tries each, then they are left alone.
    assert.equal(await autoPasses(4), 1);
    assert.equal(seen.length - before, 10, 'three tries of three files, and the good one');
    assert.equal(seen.at(-1)!.maxTokens, 4096, 'one page is asked for with a bound');
  } finally {
    status = () => 200;
    delete process.env.OCR_AUTO;
    for (const name of ['a1', 'a2', 'a3']) rmSync(join(docs, `${name}.png`));
    await scanFolders();
  }
});

test('a file the model fails on while it reads other scans keeps its count, and is left alone after three passes', async () => {
  useModel();
  process.env.OCR_AUTO = 'true';
  writeFileSync(join(docs, 'torn.pdf'), twoPages('Torn copy', 'Torn page two'));
  // Its second page is refused: what is sent is a page drawn from the PDF (a PNG), so the PDF's pages are counted.
  let pages = 0;
  status = (_n, image) => (image[0] === 0x89 && ++pages % 2 === 0 ? 400 : 200);
  reads = () => 'Receipt for coffee and cake.';
  try {
    let started = 0;
    for (let pass = 1; pass <= 6; pass++) {
      writeFileSync(join(docs, `new-${pass}.png`), `GOOD-${pass}`); // a new scan arrives before each pass
      await scanFolders();
      started += await autoPasses(1);
    }
    assert.equal(started, 6, 'every pass reads the new scan');
    assert.equal(pages, 6, 'the torn scan was tried three times, two pages each');
    assert.equal(ocrWaiting(), 1, 'only the torn scan waits');
  } finally {
    status = () => 200;
    delete process.env.OCR_AUTO;
    for (let pass = 1; pass <= 6; pass++) rmSync(join(docs, `new-${pass}.png`), { force: true });
    rmSync(join(docs, 'torn.pdf'));
    await scanFolders();
  }
});

test('a scan that the model on this computer fails on with a server error, while it reads its test page, is left alone after three passes', async () => {
  useModel();
  process.env.OCR_AUTO = 'true';
  // An image this model cannot decode: it answers 500 for it, and reads anything else (its test page too).
  writeFileSync(join(docs, 'broken.png'), 'BAD-broken');
  status = (_n, image) => (image.toString().startsWith('BAD') ? 500 : 200);
  reads = () => Array.from({ length: 9000 }, (_, i) => String(1000 + i)).join(' ');
  try {
    await scanFolders();
    assert.equal(ocrWaiting(), 1);
    assert.equal(await autoPasses(5), 3);
    assert.equal(ocrWaiting(), 1, 'it still waits for a run from the console');
  } finally {
    status = () => 200;
    delete process.env.OCR_AUTO;
    rmSync(join(docs, 'broken.png'));
    await scanFolders();
  }
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
