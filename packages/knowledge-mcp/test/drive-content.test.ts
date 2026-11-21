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

const { chunkMarkdown, parseFrontmatter, countTables, headingOf } = await import('../src/plugins/drive/chunker.js');
const { encode } = await import('gpt-tokenizer');
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
/** Tokens of text read whole by the tokenizer: what an embedding model is given. */
const trueTokens = (text: string) => encode(text, { disallowedSpecial: new Set<string>() }).length;
/** A profile with these sizes and no overlap, so that a passage is only what was cut. */
const sized = (maxTokens: number, minTokens = Math.min(50, maxTokens / 4)) => ({ ...DEFAULT_PROFILE, maxTokens, minTokens, overlapTokens: 0 });
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
    // A passage is the piece and the overlap before it ("…" and a blank line count a few tokens more), read whole.
    // What is reported for it is never less than that.
    for (const c of chunks) {
      const t = trueTokens(c.content);
      assert.ok(t <= p.maxTokens + p.overlapTokens + 4 && c.tokens >= t, `${name}: a passage of ${t} tokens, reported ${c.tokens}`);
    }
  }
  // A piece cut by force is counted without the white space at its ends too: that white space is found once, not
  // again at every step of a search.
  const spaces = `start${' \u3000'.repeat(100_000)}end`;
  assert.ok(ms(() => chunkMarkdown(spaces, sized(100))) < 500);
});

test('chunker: ordinary text is cut where it was before', () => {
  // Prose, a sentence too long for one passage (cut by characters), Korean, a table, code, Chinese and Thai.
  const words = ['index', 'the', 'passage', 'search', 'folder', 'model', 'answer', 'question', 'time', 'server', 'note', 'document'];
  const thai = ['ระบบ', 'ค้นหา', 'เอกสาร', 'ข้อมูล', 'ผู้ใช้', 'สามารถ', 'ทำงาน', 'ภาษา'];
  let seed = 7;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const prose = (n: number) => Array.from({ length: n }, () => words[rnd(words.length)]).join(' ');
  const md = [
    '# Guide',
    `${prose(120)}. ${prose(60)}.`,
    '## A sentence with no end',
    prose(1400),
    '## 한국어',
    Array.from({ length: 20 }, (_, i) => `검색은 문서 ${i}번을 다시 읽지 않습니다. 폴더가 바뀌면 그때 읽습니다.`).join(' '),
    '## Table',
    ['| name | qty |', '|---|---|', ...Array.from({ length: 120 }, (_, i) => `| item ${i} | ${i * 7} |`)].join('\n'),
    '## Code',
    '```ts\n' + Array.from({ length: 80 }, (_, i) => `const value${i} = compute(${i}, "text ${i}");`).join('\n') + '\n```',
    '## 中文',
    Array.from({ length: 30 }, (_, i) => `搜索不会再次读取第${i}个文件，文件夹改变时才会读取。`).join(''),
    '## ไทย',
    Array.from({ length: 40 }, () => Array.from({ length: 3 + rnd(12) }, () => thai[rnd(thai.length)]).join('')).join(' '),
  ].join('\n\n');
  // Tokens and length of each passage, as the chunker of 0.3 made them (no passage of it was over the cap here).
  assert.deepEqual(
    chunkMarkdown(md, DEFAULT_PROFILE).map((c) => [c.tokens, c.content.length]),
    [[191, 1125], [902, 5397], [702, 4250], [626, 1429], [898, 1931], [287, 667], [899, 2663], [349, 1070], [615, 1080], [382, 1307]],
  );
});

test('chunker: no passage is over the cap, read whole as the embedding model reads it', () => {
  // Sums of parts were taken for the whole: sentences joined with a space, paragraphs with a blank line, small
  // sections added to the one before without end, and pieces of a long run read apart. Each could pass the cap. So
  // could a piece cut by force that was counted with the space before it and stored without it (" encyclopedia" is
  // one token, "encyclopedia" three). A passage is read as it is stored, with no overlap and with one.
  let seed = 11;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const hangul = () => String.fromCharCode(0xac00 + rnd(11172));
  const words = 'Kubernetes passage overlap tokenizer retrieval orchestrator encyclopedia the index взрослых помощью dazugehören sérstaklega'.split(' ');
  const atoms = [
    () => '검색은 문서를 다시 읽지 않습니다.',
    () => 'The index keeps every passage. ',
    () => '搜索不会再次读取文件，文件夹改变时才会读取。',
    () => 'ระบบค้นหาเอกสารข้อมูล ',
    () => `| item ${rnd(99)} | ${rnd(999)} |\n`,
    () => '\n\n',
    () => '\n',
    () => `## v1.${rnd(99)}.0\n- fixed item ${rnd(99)}\n\n`,
    () => 'la'.repeat(1 + rnd(400)),
    () => 'a'.repeat(1 + rnd(700)),
    () => Array.from({ length: 1 + rnd(160) }, hangul).join(''),
    () => ' '.repeat(1 + rnd(300)),
    () => '<|endoftext|>',
    () => '😀👍🏽',
    () => ` ${words[rnd(words.length)]}`,
    () => ` ${words[rnd(words.length)]}`,
    () => `, ${words[rnd(words.length)]}`,
    () => '０'.repeat(1 + rnd(400)),
    () => '![pic](https://example.com/a.png)',
    () => '```js\nconst x = 1;\n```\n',
  ];
  for (let doc = 0; doc < 60; doc++) {
    let md = '';
    while (md.length < 3000 + rnd(9000)) md += atoms[rnd(atoms.length)]();
    for (const [max, overlap] of [[100, 0], [256, 0], [800, 0], [100, 12], [256, 32]]) {
      const chunks = chunkMarkdown(md, { ...sized(max), overlapTokens: overlap });
      chunks.forEach((c, i) => {
        const t = trueTokens(c.content);
        // With an overlap, a passage is the overlap ("…", a blank line) and the passage it was cut as.
        const cap = max + (i > 0 && overlap > 0 ? overlap + 4 : 0);
        assert.ok(t <= cap, `document ${doc}, cap ${max}, overlap ${overlap}: a passage of ${t} tokens: ${JSON.stringify(c.content.slice(0, 80))}`);
        assert.ok(c.tokens >= t, `document ${doc}, cap ${max}: ${t} tokens reported as ${c.tokens}`);
      });
    }
  }
  // Sentences that never end, of words read as one token with a space before them and as more without: each piece
  // cut by force began a passage, and was stored without that space. (Russian: 32 passages of 168 over the cap.)
  for (const run of ['взрослых помощью детей школы работы людей', 'dazugehören gebeurtenissen sérstaklega und die der', 'encyclopedia, Kubernetes, orchestrator, the, index']) {
    const ws = run.split(' ');
    const md = `# T\n\n${Array.from({ length: 3000 }, () => ws[rnd(ws.length)]).join(' ')}`;
    for (const max of [256, 800]) for (const c of chunkMarkdown(md, sized(max))) assert.ok(trueTokens(c.content) <= max, `${run}: ${trueTokens(c.content)} tokens at a cap of ${max}`);
  }
  // Found by review: a run of "a" and Hangul of 1,020 bytes after 71 words, and "la" over and over.
  const ko = Array.from({ length: 140 }, hangul).join('');
  const prefix = Array.from({ length: 71 }, (_, i) => `word${i % 7 ? '' : 's'}`).join(' ');
  for (const [md, max] of [[`${prefix} ${'a'.repeat(600)}${ko} ${'x'.repeat(4000)}`, 100], ['la'.repeat(6_000), 800], ['la'.repeat(6_000), 4000]] as const) {
    for (const c of chunkMarkdown(md, sized(max))) assert.ok(trueTokens(c.content) <= max, `${trueTokens(c.content)} tokens at a cap of ${max}`);
  }
});

test('chunker: paragraphs and rows with no word end between them are joined in time', () => {
  // A passage built up one paragraph at a time read again, for each paragraph, all of it after its last word end;
  // between paragraphs of "/" or rows of "|" and "-" after spaces there is none. 66,000 paragraphs of "/" took nine
  // seconds at 4,000 tokens a passage, two at 800.
  for (const [name, md] of [
    ['paragraphs of "/"', `# T\n\n${'/\n\n'.repeat(66_000)}`],
    ['paragraphs of "/="', `# T\n\n${'/=\n\n'.repeat(50_000)}`],
    ['table rows of "|-" after spaces', `# T\n\n| a | b |\n|---|---|\n${'  |-|-|-|\n'.repeat(20_000)}`],
  ] as const) {
    let chunks: ReturnType<typeof chunkMarkdown> = [];
    const took = ms(() => (chunks = chunkMarkdown(md, sized(4000))));
    assert.ok(took < 500, `${name}: ${Math.round(took)} ms`);
    // Read whole, a passage of these is one word to the tokenizer, slow to read: the first two are read.
    for (const c of chunks.slice(0, 2)) {
      const t = trueTokens(c.content);
      assert.ok(t <= 4000 && c.tokens >= t, `${name}: a passage of ${t} tokens, reported ${c.tokens}`);
    }
  }
});

test('chunker: words not seen before do not slow the documents after them', () => {
  // The tokenizer kept the last 100,000 words it was given in a Map that grew slow once full: after a megabyte of
  // words not seen before, each document of 200,000 characters took one to two seconds.
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let n = 26 ** 4;
  const word = () => {
    let s = '';
    for (let i = n++; s === '' || i > 0; i = Math.floor(i / 26)) s += letters[i % 26];
    return s;
  };
  const words = (size: number) => {
    const parts: string[] = [];
    for (let length = 0, p = 1; length < size; p++) {
      parts.push(p % 20 === 0 ? `## Part ${p}` : `${Array.from({ length: 50 }, word).join(' ')}.`);
      length += parts[parts.length - 1].length + 2;
    }
    return parts.join('\n\n');
  };
  encode(words(1_000_000));
  const took = ms(() => chunkMarkdown(words(200_000), DEFAULT_PROFILE));
  assert.ok(took < 500, `${Math.round(took)} ms`);
});

test('chunker: a long run of one digit is not counted short', () => {
  // Digits are read in groups of three from where a run of them begins. Pieces of a run of one digit cut by force were
  // counted as if they read as the run does: "０" over and over was 11 tokens over the cap at 800, 53 at 4,000.
  for (const digit of ['０', '0', '१', '০', '۰']) {
    for (const max of [800, 4000]) {
      for (const c of chunkMarkdown(digit.repeat(20_000), sized(max))) {
        const t = trueTokens(c.content);
        assert.ok(t <= max && c.tokens >= t, `${digit} at a cap of ${max}: a passage of ${t} tokens, reported ${c.tokens}`);
      }
    }
  }
});

test('chunker: small sections are not joined past the cap', () => {
  // 4,000 short release notes in a row were one passage of 62,000 tokens.
  const md = Array.from({ length: 4000 }, (_, i) => `## v1.${i}.0\n- fixed item ${i}`).join('\n\n');
  const chunks = chunkMarkdown(md, sized(800));
  assert.ok(chunks.length > 50);
  assert.ok(Math.max(...chunks.map((c) => trueTokens(c.content))) <= 800);
});

test('chunker: a heading followed by many spaces is read in time', () => {
  // The heading pattern tried every split of the spaces after "#": 200,000 spaces took 15 seconds.
  const took = ms(() => chunkMarkdown(cleanExtractedText(`Notes\n#${' '.repeat(200_000)}x y\nend`)));
  assert.ok(took < 500, `${Math.round(took)} ms`);
  // What a heading is has not changed.
  assert.deepEqual(['# Title', '###### Six', '####### Seven', '#Tight', '#   ', '# a\u2028b', '##\tTabbed  '].map(headingOf), [
    { level: 1, text: 'Title' },
    { level: 6, text: 'Six' },
    null,
    null,
    { level: 1, text: '' },
    null,
    { level: 2, text: 'Tabbed' },
  ]);
});

test('chunker: front matter is read in time, and as before', () => {
  // The YAML parser compared every key with every other one: 40,000 keys took 5 seconds.
  const many = `---\n${Array.from({ length: 40_000 }, (_, i) => `k${i}: v`).join('\n')}\n---\nbody text`;
  let parsed: ReturnType<typeof parseFrontmatter> = { frontmatter: {}, body: '' };
  const took = ms(() => (parsed = parseFrontmatter(many)));
  assert.ok(took < 500, `${Math.round(took)} ms`);
  // Too long for a header: not read for metadata, and still cut off from the body.
  assert.deepEqual(parsed, { frontmatter: {}, body: 'body text' });
  const some = `---\n${Array.from({ length: 5_000 }, (_, i) => `k${i}: v${i}`).join('\n')}\n---\nbody`;
  assert.ok(ms(() => (parsed = parseFrontmatter(some))) < 500);
  assert.equal(parsed.frontmatter.k4999, 'v4999');
  // A key given twice still leaves the metadata empty, as the parser has it.
  assert.deepEqual(parseFrontmatter('---\ntitle: A\ntitle: B\n---\nbody').frontmatter, {});
  assert.deepEqual(parseFrontmatter('---\ntags: [a, b]\nmeta:\n  x: 1\n---\nbody').frontmatter, { tags: ['a', 'b'], meta: { x: 1 } });
});

test('chunker: tables are counted line by line, in time, as before', () => {
  // Every blank line was read on to the end of the run (\s crossed lines): 40,000 lines took two to nine seconds.
  for (const blank of ['\u3000\n', ' \r\n', ' \n']) {
    const took = ms(() => countTables(`| a | b |\n|---|---|\n${blank.repeat(40_000)}x`));
    assert.ok(took < 500, `${JSON.stringify(blank)}: ${Math.round(took)} ms`);
  }
  // A table with an empty row next to its separator is one table, as before.
  assert.equal(countTables('| a | b |\n| | |\n|---|---|\n| 1 | 2 |'), 1);
  assert.equal(countTables('| a | b |\n|---|---|\n| 1 | 2 |\n\ntext\n\n| c |\n|:-:|\n| 3 |'), 2);
});

test('chunker: pictures that never close are looked for in time in a passage of many small sections', () => {
  // Small sections join the one before them; in the passage that makes, every "![" was read on to its end looking
  // for "]" (200,000 characters: over a second).
  const md = '# h\n\n![\n\n'.repeat(20_000);
  let chunks: ReturnType<typeof chunkMarkdown> = [];
  const took = ms(() => (chunks = chunkMarkdown(md, DEFAULT_PROFILE)));
  assert.ok(took < 500, `${Math.round(took)} ms`);
  assert.ok(chunks.length > 1 && chunks.every((c) => trueTokens(c.content) <= DEFAULT_PROFILE.maxTokens + DEFAULT_PROFILE.overlapTokens + 4));
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

test('extraction: in a file someone wrote, pictures in code and small pictures are kept', async () => {
  // Examples of how to embed a picture, inline or in a code block, were deleted and left an empty fence or ``.
  const doc =
    'How to embed a picture without a file:\n\n```md\n![dot](data:image/png;base64,iVBORw0KGgo=)\n```\n\n' +
    'Inline: `![dot](data:image/gif;base64,R0lGOD==)` works in most viewers.\n\nReference style:\n\n' +
    '```md\n![logo][l]\n\n[l]: data:image/png;base64,iVBORw0KGgo=\n```\n\nA small one: ![dot](data:image/png;base64,iVBORw0KGgo=).\n';
  assert.equal(stripEmbeddedImages(doc, { written: true }), doc);
  // A picture of real size outside code goes, with its definition and its reference.
  const big = 'iVBORw0KGgo'.repeat(200);
  const pictures = `Intro\n\n![chart](data:image/png;base64,${big})\n\n\`![chart](data:image/png;base64,${big})\`\n\n![ref][big]\n\n[big]: <data:image/png;base64,${big}>\n`;
  assert.equal(stripEmbeddedImages(pictures, { written: true }), `Intro\n\n\`![chart](data:image/png;base64,${big})\`\n\n`);
  // From a Google Doc, every picture of data goes, as before.
  assert.equal(stripEmbeddedImages('Text ![dot](data:image/png;base64,iVBORw0KGgo=) here.'), 'Text  here.');
  // Code as CommonMark reads it (found by review): inline code between runs of two backticks, inline code over the
  // lines of a paragraph, and a block indented by four spaces. A backtick in the text of a picture does not make
  // the picture code.
  const pic = `![chart](data:image/png;base64,${big})`;
  for (const example of [`Use \`\` ${pic} \`\` to embed.`, `Use \`the form\n${pic}\` to embed.`, `Example:\n\n    ${pic}\n\nEnd.`, `- item\n  \`\`\`md\n  ${pic}\n  \`\`\`\n`]) {
    assert.equal(stripEmbeddedImages(example, { written: true }), example);
  }
  assert.equal(stripEmbeddedImages(`See ![a \`b](data:image/png;base64,${big}) and \`x\``, { written: true }), 'See  and `x`');
  assert.equal(stripEmbeddedImages(`Use \`one\n\nand\` ${pic}`, { written: true }), 'Use `one\n\nand` '); // not across a blank line
  assert.equal(stripEmbeddedImages(`Text\n    ${pic}`, { written: true }), 'Text\n    '); // indented, but within a paragraph
  // In time, with backticks that never close and runs of every length.
  for (const text of ['` `` ``` ````'.repeat(20_000) + pic, `${'a `b\n'.repeat(50_000)}${pic}`, `${'    x\n'.repeat(40_000)}${pic}`]) {
    const took = ms(() => stripEmbeddedImages(text, { written: true }));
    assert.ok(took < 500, `${Math.round(took)} ms`);
  }
});

test('workbook: what a sheet says of its size is not believed past what is read, and a workbook is read within a budget', async () => {
  const XLSX = await import('xlsx');
  const { workbookText } = await import('../src/plugins/drive/extract_text.js');
  /**
   * A workbook of `tabs` tabs of one cell, each saying it spans `ref`, with real cells added where `rows` says. The
   * sheet XML is written by hand: SheetJS would walk the whole range to write it.
   */
  const workbook = (ref: string, rows: Record<number, string[]> = {}, tabs = 1): Buffer => {
    const wb = XLSX.utils.book_new();
    for (let t = 0; t < tabs; t++) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['only']]), tabs === 1 ? 'S' : `S${t}`);
    const zip = XLSX.CFB.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
    zip.FullPaths.forEach((p: string, i: number) => {
      if (!/xl\/worksheets\/sheet\d+\.xml$/.test(p)) return;
      const cells = Object.entries(rows).map(([r, cols]) => `<row r="${r}">${cols.map((c) => `<c r="${c}${r}" t="inlineStr"><is><t>far</t></is></c>`).join('')}</row>`).join('');
      const xml = Buffer.from(zip.FileIndex[i].content).toString('utf8').replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="${ref}"/>`).replace('</sheetData>', `${cells}</sheetData>`);
      zip.FileIndex[i].content = Buffer.from(xml);
    });
    return Buffer.from(XLSX.CFB.write(zip, { fileType: 'zip', type: 'buffer', compression: true }));
  };
  const timed = async (buf: Buffer) => {
    const at = performance.now();
    const text = await workbookText(buf);
    return { text, took: performance.now() - at };
  };
  // Said to be 200,000 rows by 100 columns: 20 million commas and four seconds before. A million rows by 16,384
  // columns would have run for an hour. What is past the rows that are read is not looked at, and the text says so.
  for (const ref of ['A1:CV200000', 'A1:XFD1048576']) {
    const { text, took } = await timed(workbook(ref));
    assert.equal(text, '## S\nonly\n(Only rows up to 100,000 are read.)', ref);
    assert.ok(took < 500, `${ref}: ${Math.round(took)} ms`);
  }
  // Rows past the one after the last read were dropped without a word when that row was empty (found by review).
  assert.equal(await workbookText(workbook('A1:A100002', { 100002: ['A'] })), '## S\nonly\n(Only rows up to 100,000 are read.)');
  assert.equal(await workbookText(workbook('A1:A150000', { 5000: ['A'], 150000: ['A'] })), '## S\nonly\nfar\n(Only rows up to 100,000 are read.)');
  // A real cell at the far edge: read, and only the rows that hold a cell are visited.
  const far = await timed(workbook('A1:XFD90000', { 90000: ['XFD'] }));
  assert.ok(far.took < 500, `${Math.round(far.took)} ms`);
  assert.ok(far.text.startsWith('## S\nonly,,,') && far.text.endsWith(',far') && far.text.length < 40_000, far.text.slice(0, 40));
  // Rows past what the budget allows are not written, and the text says so: 200 rows 16,384 cells wide.
  const wide = await timed(workbook('A1:XFD200', Object.fromEntries(Array.from({ length: 199 }, (_, i) => [i + 2, ['A', 'XFD']]))));
  assert.ok(wide.took < 500, `${Math.round(wide.took)} ms`);
  assert.match(wide.text, /\n\(Only rows up to 122 are read\.\)$/);
  // Many tabs whose two cells are far apart: each said 2,000,000 cells and was walked whole (1,000 tabs: 12 seconds).
  const many = await timed(workbook('A1:T100000', { 100000: ['T'] }, 300));
  assert.ok(many.took < 1500, `${Math.round(many.took)} ms`);
  assert.equal(many.text.split('## S').length - 1, 300);
  // A tab that begins further in is written from where it says it begins, as before; empty rows are left out.
  assert.equal(await workbookText(workbook('A1:C3', { 3: ['C'] })), '## S\nonly,,\n,,far');
  const offset = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(offset, { '!ref': 'C3:D4', C3: { t: 's', v: 'offset' }, D4: { t: 'n', v: 1 } } as import('xlsx').WorkSheet, 'Three');
  assert.equal(await workbookText(XLSX.write(offset, { type: 'buffer', bookType: 'xlsx' }) as Buffer), '## Three\noffset,\n,1');
  // A tab of exactly the rows that are read says nothing of more; one row more, and it does.
  assert.ok(!(await workbookText(workbook('A1:A100000', { 100000: ['A'] }))).includes('Only rows'));
  assert.match(await workbookText(workbook('A1:A100001', { 100001: ['A'] })), /\n\(Only rows up to 100,000 are read\.\)$/);
  // Cells can share one text of 32,767 characters: 3,000 of them in a workbook of 44 KB were 98 MB of text. The text
  // written stops at 10 million characters, and says so.
  const long = 'Lorem ipsum dolor sit amet '.repeat(1214).slice(0, 32_767);
  const shared = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(shared, XLSX.utils.aoa_to_sheet(Array.from({ length: 3000 }, () => [long])), 'S');
  const sharedText = await timed(XLSX.write(shared, { type: 'buffer', bookType: 'xlsx', bookSST: true, compression: true }) as Buffer);
  assert.ok(sharedText.text.length <= 10_000_100, `${sharedText.text.length} characters`);
  assert.match(sharedText.text, /\n\(Only rows up to 305 are read\.\)$/);
  assert.ok(sharedText.took < 500, `${Math.round(sharedText.took)} ms`);
});
