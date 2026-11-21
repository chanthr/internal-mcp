/**
 * Drive content rules without a network: Markdown chunking (CRLF files, "# comments" inside code blocks),
 * folder-scope paths (NFC vs NFD Hangul, the way down to an allowed folder) and the sync retry list cap.
 * Text anyone can send (a note, a file in a folder) is cleaned, cut and read in time that grows with its length.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const k of Object.keys(process.env)) if (/^(SUPABASE_|MCP_STORE)/.test(k)) delete process.env[k];
process.env.MCP_DATA_DIR = mkdtempSync(join(tmpdir(), 'kmcp-content-'));

const { chunkMarkdown, parseFrontmatter } = await import('../src/plugins/drive/chunker.js');
const { cleanExtractedText, stripEmbeddedImages } = await import('../src/plugins/drive/clean_text.js');
const { DEFAULT_PROFILE } = await import('../src/plugins/drive/index_profile.js');
const { isPathInScope, isScopeAncestor } = await import('../src/core/scope.js');
const { getRetryList, setRetryList } = await import('../src/plugins/drive/sync_state.js');

const filler = (word: string) => Array.from({ length: 80 }, (_, i) => `${word} ${i}`).join(' ');
/** Milliseconds `f` takes. The bounds below are generous: each case took seconds or minutes before. */
const ms = (f: () => unknown): number => {
  const at = performance.now();
  f();
  return performance.now() - at;
};
/** Korean syllables that do not repeat, with no space between them. */
const korean = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(0xac00 + ((i * 7919) % 11172))).join('');

test('chunker: CRLF files keep their frontmatter and headings', () => {
  const md = ['---', 'status: final', 'tags: [a, b]', '---', '', '# Intro', filler('alpha'), '', '## Setup', filler('beta')].join('\r\n');
  assert.deepEqual(parseFrontmatter(md).frontmatter, { status: 'final', tags: ['a', 'b'] });
  const chunks = chunkMarkdown(md);
  assert.equal(chunks[0]!.doc_status, 'final');
  assert.deepEqual(chunks.map((c) => c.heading), ['Intro', 'Intro > Setup']);
  assert.ok(chunks.every((c) => !c.content.includes('\r')));
});

test('chunker: a "# comment" inside a code block is not a heading', () => {
  const md = ['# Install', filler('gamma'), '', '```bash', '# install the tool', 'npm i -g thing', '```', '', '~~~', '# also not a heading', '~~~', filler('delta')].join('\n');
  const chunks = chunkMarkdown(md);
  assert.deepEqual([...new Set(chunks.map((c) => c.heading))], ['Install']);
  const all = chunks.map((c) => c.content).join('\n');
  assert.match(all, /```bash\n# install the tool\nnpm i -g thing\n```/);
});

test('scope: NFD Hangul from macOS matches the NFC prefix', () => {
  const nfc = '고객사/에이씨';
  const nfd = nfc.normalize('NFD');
  assert.notEqual(nfc, nfd);
  assert.equal(isPathInScope(`${nfd}/제안서`, [nfc]), true);
  assert.equal(isPathInScope(`${nfc}/제안서`, [nfd]), true);
  assert.equal(isPathInScope('고객사/다른곳', [nfc]), false);
});

test('scope: parent folders of an allowed folder stay visible, siblings do not', () => {
  const scope = ['Clients/Acme/Proposals'];
  assert.equal(isScopeAncestor('Clients', scope), true);
  assert.equal(isScopeAncestor('Clients/Acme', scope), true);
  assert.equal(isScopeAncestor('Clients/Acme/Proposals', scope), false); // that one is in scope, not a parent
  assert.equal(isScopeAncestor('Clients/Beta', scope), false);
  assert.equal(isScopeAncestor('Client', scope), false); // a name prefix is not a parent folder
  assert.equal(isScopeAncestor('Clients', null), false);
});

test('sync retry list: round-trips and keeps at most 1000 files', async () => {
  assert.deepEqual(await getRetryList(), {});
  await setRetryList({ a: 1, b: 3 });
  assert.deepEqual(await getRetryList(), { a: 1, b: 3 });
  const many = Object.fromEntries(Array.from({ length: 1005 }, (_, i) => [`f${i}`, 1]));
  await setRetryList(many);
  const kept = await getRetryList();
  assert.equal(Object.keys(kept).length, 1000);
  assert.equal('f1004' in kept, true); // the newest stay
  assert.equal('f0' in kept, false);
});

test('workbook: every tab is read, empty tabs are left out', async () => {
  const XLSX = await import('xlsx');
  const { workbookText } = await import('../src/plugins/drive/extract_text.js');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['name', 'qty'], ['apple', 3]]), 'Stock');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Empty');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['month', 'sales'], ['Jan', 10]]), 'Sales');
  const text = await workbookText(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
  assert.equal(text, '## Stock\nname,qty\napple,3\n\n## Sales\nmonth,sales\nJan,10');
});

test('sync lock: one holder at a time, released by its owner, a dead holder is replaced', async () => {
  const { acquireSyncLock, releaseSyncLock } = await import('../src/plugins/drive/sync.js');
  const { writeFileSync, existsSync } = await import('node:fs');
  const lock = join(process.env.MCP_DATA_DIR!, 'drive-sync.lock');
  assert.equal(acquireSyncLock(), true);
  assert.equal(acquireSyncLock(), false); // this process is alive and holds it
  releaseSyncLock();
  assert.equal(existsSync(lock), false);
  writeFileSync(lock, '2147483646'); // a process id that does not exist
  assert.equal(acquireSyncLock(), true);
  releaseSyncLock();
});

test('result dates: the document date wins, otherwise the modified date, with the age once it is old', async () => {
  const { dateLabel } = await import('../src/plugins/knowledge/tools/search_knowledge.js');
  const now = Date.parse('2026-11-17T00:00:00Z');
  assert.equal(dateLabel({ doc_date: '2026-11-10', modified_time: '2026-01-01T00:00:00Z' }, now), '2026-11-10');
  assert.equal(dateLabel({ doc_date: null, modified_time: '2026-10-02T05:27:14.002Z' }, now), 'modified 2026-10-02, 1mo old');
  assert.equal(dateLabel({ doc_date: null, modified_time: '2024-05-01T00:00:00Z' }, now), 'modified 2024-05-01, 2y old');
  assert.equal(dateLabel({ doc_date: null, modified_time: '' }, now), null);
});

test('cleaning: text anyone can send is cleaned in time, and ordinary text as before', () => {
  const hostile: Array<[string, string]> = [
    ['200,000 blank lines', '\n'.repeat(200_000)],
    ['200,000 spaces with no line break after them', `a${' '.repeat(200_000)}b`],
    ['"x<y " over and over', 'x<y '.repeat(50_000)],
    ['"\\section{" with no closing brace', '\\section{'.repeat(22_000)],
    ['lines of ideographic spaces', '\u3000\n'.repeat(100_000)],
  ];
  for (const [name, text] of hostile) {
    const took = ms(() => cleanExtractedText(text));
    assert.ok(took < 500, `${name}: ${Math.round(took)} ms`);
  }
  for (const [name, text] of [
    ['"![" over and over', `[i]: <data:image/png;base64,AA>\n${'!['.repeat(100_000)}`],
    ['pictures with no closing parenthesis', '![](data:image/png;base64,'.repeat(8_000)],
  ]) {
    const took = ms(() => stripEmbeddedImages(text));
    assert.ok(took < 500, `${name}: ${Math.round(took)} ms`);
  }
  // What ordinary text becomes is unchanged: LaTeX wrappers, tags, entities, page markers, trailing spaces.
  const page = ['\\section{Introduction}  ', 'Text with <b>bold</b> and <span class="x">a span</span><br/>next line &amp; more &lt;tags&gt;, 3 < 4.', '', '', '', '-- 1 of 2 --', '\\textbf{Key} point\t', '  -- 2 of 2 --  ', '한국어 문장입니다. ', 'Last line.'].join('\n');
  assert.equal(cleanExtractedText(page), 'Introduction\nText with bold and a span\nnext line & more <tags>, 3 < 4.\n\nKey point\n\n한국어 문장입니다.\nLast line.');
  const exported = 'Intro\n\n![chart][image1]\n\nText ![inline](data:image/png;base64,iVBORw0KGgo=) and ![kept](https://example.com/a.png).\n\n[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==>\n';
  assert.equal(stripEmbeddedImages(exported), 'Intro\n\nText  and ![kept](https://example.com/a.png).\n\n');
});

test('chunker: one long word is cut in time, and every piece is within the cap', () => {
  const p = DEFAULT_PROFILE;
  for (const [name, text] of [
    ['8,000 Korean characters without a space', korean(8_000)],
    ['100 KB of "a"', 'a'.repeat(100_000)],
    ['100 KB of "|"', '|'.repeat(100_000)],
    ['200 KB of spaces between two words', `start${' '.repeat(200_000)}end`],
  ] as const) {
    let chunks: ReturnType<typeof chunkMarkdown> = [];
    const took = ms(() => (chunks = chunkMarkdown(text, p)));
    assert.ok(took < 500, `${name}: ${Math.round(took)} ms`);
    assert.ok(chunks.length > 0, name);
    // A passage is the piece and the overlap before it ("…" and a blank line count a few tokens more).
    for (const c of chunks) assert.ok(c.tokens <= p.maxTokens + p.overlapTokens + 4, `${name}: a passage of ${c.tokens} tokens`);
  }
});

test('chunker: ordinary text is cut where it was before', () => {
  // Prose, a sentence too long for one passage (cut by characters), Korean, a table, code and Chinese.
  const words = ['index', 'the', 'passage', 'search', 'folder', 'model', 'answer', 'question', 'time', 'server', 'note', 'document'];
  let seed = 7;
  const prose = (n: number) => Array.from({ length: n }, () => words[(seed = (seed * 1103515245 + 12345) % 2147483648) % words.length]).join(' ');
  const md = [
    '# Guide',
    `${prose(120)}. ${prose(60)}.`,
    '## A sentence with no end',
    prose(1400),
    '## 한국어',
    Array.from({ length: 40 }, (_, i) => `검색은 문서 ${i}번을 다시 읽지 않습니다. 폴더가 바뀌면 그때 읽습니다.`).join(' '),
    '## Table',
    ['| name | qty |', '|---|---|', ...Array.from({ length: 120 }, (_, i) => `| item ${i} | ${i * 7} |`)].join('\n'),
    '## Code',
    '```ts\n' + Array.from({ length: 80 }, (_, i) => `const value${i} = compute(${i}, "text ${i}");`).join('\n') + '\n```',
    '## 中文',
    Array.from({ length: 30 }, (_, i) => `搜索不会再次读取第${i}个文件，文件夹改变时才会读取。`).join(''),
  ].join('\n\n');
  // Tokens and length of each passage, as the chunker made them before it counted in parts.
  assert.deepEqual(
    chunkMarkdown(md, DEFAULT_PROFILE).map((c) => [c.tokens, c.content.length]),
    [[191, 1125], [902, 5397], [706, 4258], [934, 1899], [309, 487], [898, 1931], [287, 667], [899, 2663], [349, 1070], [615, 1080]],
  );
  const small = chunkMarkdown(md, { ...DEFAULT_PROFILE, maxTokens: 100, minTokens: 25, overlapTokens: 12 });
  assert.equal(small.length, 55);
  assert.deepEqual(small.slice(0, 4).map((c) => [c.tokens, c.content.length]), [[2, 7], [104, 606], [103, 594], [114, 658]]);
  assert.deepEqual(small.slice(-3).map((c) => [c.tokens, c.content.length]), [[114, 175], [113, 175], [124, 191]]);
});

test('chunker: table rows are counted in time in a passage of thousands of blank lines', () => {
  // Every blank line was read on to the end of the run (\s crossed lines): 40 such passages took close to two seconds.
  const p = { ...DEFAULT_PROFILE, maxTokens: 4000 };
  const md = Array.from({ length: 40 }, (_, i) => `# Part ${i}\n\nx\n${' \n'.repeat(7_000)}y\n\n| a | b |\n|---|---|\n| 1 | 2 |`).join('\n\n');
  let chunks: ReturnType<typeof chunkMarkdown> = [];
  const took = ms(() => (chunks = chunkMarkdown(md, p)));
  assert.ok(took < 500, `${Math.round(took)} ms`);
  assert.deepEqual(chunks.map((c) => c.table_count), Array(40).fill(1));
});

test('chunker: pictures that never close are looked for in time in a passage of many small sections', () => {
  // Small sections join the one before them; in the passage that makes, every "![" was read on to its end looking
  // for "]" (200,000 characters: over a second).
  const md = '# h\n\n![\n\n'.repeat(20_000);
  let chunks: ReturnType<typeof chunkMarkdown> = [];
  const took = ms(() => (chunks = chunkMarkdown(md, DEFAULT_PROFILE)));
  assert.ok(took < 500, `${Math.round(took)} ms`);
  assert.equal(chunks.length, 1);
  // A picture that does close still has its address moved out of the text.
  const [c] = chunkMarkdown('# Report\n\nSee ![the chart](https://example.com/chart.png) for the numbers.', DEFAULT_PROFILE);
  assert.deepEqual([c.content, c.image_urls], ['# Report\n\nSee the chart for the numbers.', ['https://example.com/chart.png']]);
});

test('chunker: a document that holds a special token string is cut as text', () => {
  const chunks = chunkMarkdown('# Notes\n\nA model ends its answer with <|endoftext|> and a chat turn with <|im_end|>.');
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].content, /<\|endoftext\|> and a chat turn with <\|im_end\|>/);
  assert.ok(chunks[0].tokens > 10);
});

test('extraction: pictures embedded in a Markdown or text file are dropped before it is cut', async () => {
  const { extractLocalFile } = await import('../src/plugins/drive/extract_text.js');
  const dir = mkdtempSync(join(tmpdir(), 'kmcp-picture-'));
  const picture = 'iVBORw0KGgoAAAANSUhEUgAA'.repeat(70_000); // 1.6 MB of base64
  const md = join(dir, 'report.md');
  writeFileSync(md, `# Report\n\nSales went up.\n\n![chart](data:image/png;base64,${picture})\n\nCosts went down.\n`);
  const txt = join(dir, 'export.txt');
  writeFileSync(txt, `Summary\n\n![][image1]\n\n[image1]: <data:image/png;base64,${picture}>\n`);
  // Read and cut: 7.5 seconds and 374 passages of letters before.
  const at = performance.now();
  const { text } = await extractLocalFile(md, 'text/markdown');
  const chunks = chunkMarkdown(text);
  assert.ok(performance.now() - at < 500, `${Math.round(performance.now() - at)} ms`);
  assert.equal(text, '# Report\n\nSales went up.\n\nCosts went down.');
  assert.equal(chunks.length, 1);
  assert.equal((await extractLocalFile(txt, 'text/plain')).text, 'Summary');
});

test('workbook: the size a sheet says it has is not believed, and a sheet that spans too much is not read', async () => {
  const XLSX = await import('xlsx');
  const { workbookText } = await import('../src/plugins/drive/extract_text.js');
  /** A workbook of one cell whose sheet says it spans `ref`, with a real cell at `far` when given. */
  const workbook = (ref: string, far?: string): Buffer => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['only']]), 'S');
    const zip = XLSX.CFB.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
    const sheet = zip.FileIndex[zip.FullPaths.findIndex((p: string) => p.endsWith('xl/worksheets/sheet1.xml'))];
    let xml = Buffer.from(sheet.content).toString('utf8').replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="${ref}"/>`);
    if (far) xml = xml.replace('</sheetData>', `<row r="${far.replace(/^[A-Z]+/, '')}"><c r="${far}" t="inlineStr"><is><t>far</t></is></c></row></sheetData>`);
    sheet.content = Buffer.from(xml);
    return Buffer.from(XLSX.CFB.write(zip, { fileType: 'zip', type: 'buffer', compression: true }));
  };
  const timed = async (buf: Buffer) => {
    const at = performance.now();
    const text = await workbookText(buf);
    return { text, took: performance.now() - at };
  };
  // Said to be 200,000 rows by 100 columns: 20 million commas and four seconds before. A million rows by 16,384
  // columns would have run for an hour.
  for (const ref of ['A1:CV200000', 'A1:XFD1048576']) {
    const { text, took } = await timed(workbook(ref));
    assert.equal(text, '## S\nonly', ref);
    assert.ok(took < 500, `${ref}: ${Math.round(took)} ms`);
  }
  // A real cell at the far edge: the sheet is not read, and the text says why.
  const far = await timed(workbook('A1:XFD90000', 'XFD90000'));
  assert.ok(far.took < 500, `${Math.round(far.took)} ms`);
  assert.equal(far.text, '## S\n(Not read: its cells span A1:XFD90000, more than 2,000,000 cells.)');
  // Empty rows inside what a sheet spans are left out.
  assert.equal(await workbookText(workbook('A1:C3', 'C3')), '## S\nonly,,\n,,far');
});
