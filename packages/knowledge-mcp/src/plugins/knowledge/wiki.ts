/**
 * A wiki the server writes from the person's documents, with the model connected on the Agent page.
 *
 * Search finds passages again for every question. A wiki keeps what was understood: one page per document that
 * says what is in it, and one page per topic that gathers what all the documents say about it, linked to each
 * other. It is plain Markdown with [[links]] in a folder beside the settings, so it is searched and linked like
 * any other folder here, and opens in Obsidian as it is.
 *
 *   wiki/
 *     AGENTS.md    the rules of this wiki, for the model and for the person to change
 *     index.md     every page with one line
 *     log.md       what was read and when
 *     sources/     one page per document: what it says, and the topics it feeds
 *     topics/      one page per topic: what the documents say about it, with where each fact comes from
 *
 * The documents themselves are never changed. The model is asked for what a document says as data (a summary,
 * points, topics with facts); the pages are written from that data by this file, so every page has the same shape
 * and every fact keeps its source. What the model returned is kept in the data directory: pages can be written
 * again without asking the model again, and a document is read again only when it has changed.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { dataFile } from '../../core/data_file.js';
import { ask, LlmError } from '../../core/llm.js';
import { extractLocalFile } from '../drive/extract_text.js';
import { listLocalFiles, localFolders, type LocalFile } from './folders.js';

export const WIKI = 'wiki';
export const wikiDir = (dir: string): string => join(resolve(dir), WIKI);
export const wikiExists = (dir: string): boolean => existsSync(join(wikiDir(dir), 'AGENTS.md'));

// ── What is kept between runs ──

interface Fact {
  text: string;
  /** The document it comes from (its ID). */
  source: string;
}
interface TopicState {
  title: string;
  kind: 'concept' | 'entity';
  definition: string;
  facts: Fact[];
  /** Paragraphs the model wrote from the facts, and the facts they were written from (to know when they are stale). */
  summary?: string;
  summaryOf?: string;
}
interface SourceState {
  modified: string;
  title: string;
  /** The name of its page, without ".md". */
  page: string;
  summary: string;
  points: string[];
  /** Keys of the topics it feeds. */
  topics: string[];
  /** The document was longer than what is read of one document. */
  partial?: boolean;
}
export interface WikiState {
  version: 1;
  sources: Record<string, SourceState>;
  topics: Record<string, TopicState>;
}
const stateFile = dataFile<WikiState>('wiki-state.json');
export const readWikiState = (): WikiState => stateFile.read() ?? { version: 1, sources: {}, topics: {} };

// ── Names ──

const nfc = (s: string): string => s.normalize('NFC');
/** A title as a file name: what a file system or a [[link]] cannot hold is taken out. */
export function pageName(title: string): string {
  const name = nfc(title)
    .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 100)
    .trim();
  return name || 'Untitled';
}
/** Two titles that differ only in case, spacing or a dash are one topic ("Client SDK", "client-sdk"). */
export const topicKey = (title: string): string => pageName(title).toLowerCase().replace(/[-_\s]+/g, ' ').trim();
/** A document's page is named after where the document is: unique, and stable when its title changes. */
const sourcePage = (path: string): string => pageName(path.replace(/\.[A-Za-z0-9]{1,5}$/, '').split('/').join(' - '));

// ── The rules, as first written. The person changes the file; the model is given the file. ──

const RULES = `# The rules of this wiki

This wiki is written by a language model from the documents in the folders of this server. You can change
these rules: the model is given this file every time it reads a document.

## What the wiki is for

A person, or an assistant, should be able to learn what the documents say about a topic from one page, and
find the documents behind every statement.

## Language

Write in the language the document is written in.

## What to take from a document

- A title, as the document gives it.
- One sentence that says what the document is.
- Its key points: what a reader has to know, each a full sentence that can be understood alone.
- The topics it is about: things a person would look up. A concept (a method, a rule, a term) or an
  entity (a product, a system, a team, a place, a person in their role).
- For each topic, what this document says about it: facts, each a full sentence that can be understood
  alone, with the numbers and dates the document gives.

## What to leave out

- Anything the document does not say. Do not explain a topic from general knowledge.
- Opinions about the document.
- Topics the document only mentions in passing.

## Topics

- Use the name people use for it, short, singular.
- When a topic is already in the wiki under another wording, use the wiki's wording.
- A document usually feeds between one and eight topics.
`;

/**
 * What the model must return for a document, whatever the rules say.
 *
 * Lines with a label, not JSON. A small model asked for a long JSON object gets a quote or a comma wrong often
 * enough to lose the document (three of five, with a local 8-billion-parameter model). A line with a label has
 * nothing to escape and nothing to close.
 */
const READ_PROTOCOL = `You read one document and return what it says, as lines for a wiki. Follow the rules of the wiki given below.

Answer with lines that each begin with one of these labels, and with nothing else:

TITLE: the document's title
SUMMARY: one sentence saying what the document is
POINT: a key point (at most 8 such lines)
TOPIC: the name of a topic the document is about (at most 8)
KIND: concept or entity (the line after its TOPIC)
DEFINITION: one sentence saying what the topic is, as far as this document says
FACT: one thing this document says about that topic (at most 6 such lines, after its TOPIC)

Every value stays on its own line. The labels stay as they are; every value is written in the language of the document, not in the language of these instructions. Only what the document says. If it says nothing usable, answer with the TITLE line alone.`;

const SUMMARY_PROTOCOL = `You write the opening of one wiki page from facts taken from several documents. Follow the rules of the wiki given below.

Write one to three short paragraphs of plain prose that bring the facts together: what the topic is, and what the documents say about it. Use only the facts given. Where two facts disagree, say that they do. Write in the language most of the facts are written in. No heading, no list, no links.`;

const Read = z.object({
  title: z.string().max(300).catch(''),
  summary: z.string().max(2000).catch(''),
  points: z.array(z.string().max(2000)).max(40).catch([]),
  topics: z
    .array(z.object({ title: z.string().min(1).max(200), kind: z.enum(['concept', 'entity']).catch('concept'), definition: z.string().max(2000).catch(''), facts: z.array(z.string().max(2000)).max(40).catch([]) }))
    .max(40)
    .catch([]),
});
type Read = z.infer<typeof Read>;

/** An answer without the reasoning some models write out before it (<think>…</think>). */
export const withoutThinking = (text: string): string => text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/^[\s\S]*<\/think(?:ing)?>/i, '');

const LABEL = /^(TITLE|SUMMARY|POINT|TOPIC|KIND|DEFINITION|FACT)\s*[:：]\s*(.*)$/i;

/**
 * What a document says, from the model's labelled lines. Bullets and bold around a label are taken off, lines
 * without a label are passed over, and a model that answered in JSON after all is read as JSON.
 */
export function readAnswer(answer: string): Read {
  const text = withoutThinking(answer);
  const out: Read = { title: '', summary: '', points: [], topics: [] };
  let topic: Read['topics'][number] | null = null;
  let labelled = 0;
  for (const raw of text.split('\n')) {
    const m = LABEL.exec(raw.replace(/^[\s>*#-]+/, '').replace(/\*\*/g, '').trim());
    if (!m) continue;
    const value = m[2].trim().slice(0, 2000);
    labelled++;
    if (!value) continue;
    switch (m[1].toUpperCase()) {
      case 'TITLE':
        out.title ||= value.slice(0, 300);
        break;
      case 'SUMMARY':
        out.summary ||= value;
        break;
      case 'POINT':
        out.points.push(value);
        break;
      case 'TOPIC':
        topic = { title: value.slice(0, 200), kind: 'concept', definition: '', facts: [] };
        out.topics.push(topic);
        break;
      case 'KIND':
        if (topic) topic.kind = /entit/i.test(value) ? 'entity' : 'concept';
        break;
      case 'DEFINITION':
        if (topic) topic.definition ||= value;
        break;
      case 'FACT':
        if (topic) topic.facts.push(value);
        break;
    }
  }
  if (labelled > 0) return out;
  const from = text.indexOf('{');
  const to = text.lastIndexOf('}');
  if (from >= 0 && to > from) return Read.parse(JSON.parse(text.slice(from, to + 1)));
  throw new Error('no labelled line in the answer');
}

// ── Pages ──

const today = (): string => new Date().toISOString().slice(0, 10);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const yaml = (s: string): string => JSON.stringify(s);
/** What the person wrote under "## Notes" on a page stays theirs when the page is written again. */
function notesOf(path: string): string {
  if (!existsSync(path)) return '';
  const text = readFileSync(path, 'utf8');
  const at = text.search(/^## Notes[ \t]*$/m);
  return at < 0 ? '' : text.slice(at).trimEnd();
}
function writePage(path: string, body: string): void {
  const notes = notesOf(path);
  const text = `${body.trimEnd()}\n${notes ? `\n${notes}\n` : ''}`;
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return;
  writeFileSync(path, text);
}

function sourceText(id: string, s: SourceState, state: WikiState): string {
  const path = id.replace(/^local:/, '');
  const topics = s.topics.map((k) => state.topics[k]).filter(Boolean);
  return [
    '---',
    'type: source',
    `document: ${yaml(id)}`,
    `modified: ${yaml(s.modified)}`,
    `updated: ${today()}`,
    '---',
    `# ${s.title}`,
    '',
    ...(s.summary ? [`> ${oneLine(s.summary)}`, ''] : []),
    `The document: [${path}](${encodeURI(path)})${s.partial ? '. Only its first part was read: it is longer than what is read of one document.' : ''}`,
    '',
    ...(s.points.length ? ['## Key points', ...s.points.map((p) => `- ${oneLine(p)}`), ''] : []),
    ...(topics.length ? ['## Topics', ...topics.map((t) => `- [[${pageName(t.title)}]]`), ''] : []),
  ].join('\n');
}

function topicText(key: string, t: TopicState, state: WikiState): string {
  const sources = [...new Set(t.facts.map((f) => f.source))];
  // Topics that share a document with this one: the links that make it a wiki, made without asking the model.
  const related = new Map<string, number>();
  for (const id of sources) for (const other of state.sources[id]?.topics ?? []) if (other !== key && state.topics[other]) related.set(other, (related.get(other) ?? 0) + 1);
  const near = [...related].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12);
  return [
    '---',
    'type: topic',
    `kind: ${t.kind}`,
    `documents: ${sources.length}`,
    `updated: ${today()}`,
    '---',
    `# ${t.title}`,
    '',
    ...(t.definition ? [`> ${oneLine(t.definition)}`, ''] : []),
    ...(t.summary ? [t.summary.trim(), ''] : []),
    '## What the documents say',
    ...t.facts.map((f) => {
      const s = state.sources[f.source];
      return `- ${oneLine(f.text)}${s ? ` ([[${s.page}|${s.title.replace(/[[\]|]/g, ' ')}]])` : ''}`;
    }),
    '',
    ...(near.length ? ['## Related', ...near.map(([k]) => `- [[${pageName(state.topics[k].title)}]]`), ''] : []),
  ].join('\n');
}

function indexText(state: WikiState): string {
  const topics = Object.values(state.topics).sort((a, b) => a.title.localeCompare(b.title));
  const sources = Object.values(state.sources).sort((a, b) => a.title.localeCompare(b.title));
  return [
    '# Index',
    '',
    `${topics.length} topic${topics.length === 1 ? '' : 's'} from ${sources.length} document${sources.length === 1 ? '' : 's'}. Written ${today()}.`,
    '',
    '## Topics',
    ...topics.map((t) => `- [[${pageName(t.title)}]]${t.definition ? `: ${oneLine(t.definition)}` : ''}`),
    '',
    '## Documents',
    ...sources.map((s) => `- [[${s.page}|${s.title.replace(/[[\]|]/g, ' ')}]]${s.summary ? `: ${oneLine(s.summary)}` : ''}`),
    '',
  ].join('\n');
}

/** Make the folder and its first files. Nothing that is there is written over. */
export function createWiki(dir: string): string {
  const root = wikiDir(dir);
  mkdirSync(join(root, 'sources'), { recursive: true });
  mkdirSync(join(root, 'topics'), { recursive: true });
  const first = (name: string, text: string) => void (existsSync(join(root, name)) || writeFileSync(join(root, name), text));
  first('AGENTS.md', RULES);
  first('index.md', indexText(readWikiState()));
  first('log.md', '# Log\n\nWhat was read into this wiki, newest last.\n');
  return root;
}

/** Write every page from what is kept, and take away the pages of what is gone. */
export function writeWiki(dir: string, state: WikiState, touched?: { sources: Set<string>; topics: Set<string> }): void {
  const root = wikiDir(dir);
  for (const [id, s] of Object.entries(state.sources)) if (!touched || touched.sources.has(id)) writePage(join(root, 'sources', `${s.page}.md`), sourceText(id, s, state));
  for (const [key, t] of Object.entries(state.topics)) if (!touched || touched.topics.has(key)) writePage(join(root, 'topics', `${pageName(t.title)}.md`), topicText(key, t, state));
  writeFileSync(join(root, 'index.md'), indexText(state));
}

// ── Reading ──

/** How much of one document is read: this many parts of this many characters. Smaller for a model with a small window. */
export interface WikiLimits {
  partChars: number;
  maxParts: number;
}
export const wikiLimits = (): WikiLimits => ({
  partChars: Math.max(1500, Number(process.env.WIKI_PART_CHARS) || 24_000),
  maxParts: Math.max(1, Number(process.env.WIKI_MAX_PARTS) || 6),
});

/** A long text in parts, cut at a paragraph where there is one. */
export function partsOf(text: string, limits: WikiLimits): { parts: string[]; partial: boolean } {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > 0 && parts.length < limits.maxParts) {
    if (rest.length <= limits.partChars) {
      parts.push(rest);
      rest = '';
      break;
    }
    const window = rest.slice(0, limits.partChars);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    const at = cut > limits.partChars * 0.5 ? cut : limits.partChars;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  return { parts, partial: rest.length > 0 };
}

export interface Usage {
  input: number;
  output: number;
  calls: number;
}

async function askForRead(system: string, prompt: string, usage: Usage, signal: AbortSignal): Promise<Read> {
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const a = await ask({ system, prompt: attempt === 0 ? prompt : `${prompt}\n\nYour last answer had none of the labelled lines. Answer with the labelled lines only, starting with TITLE:`, signal });
    usage.input += a.usage.input;
    usage.output += a.usage.output;
    usage.calls++;
    try {
      return readAnswer(a.text);
    } catch (e) {
      last = e instanceof Error ? e.message.slice(0, 120) : 'not readable';
    }
  }
  throw new LlmError(`The model did not answer in the shape asked for (${last}).`);
}

/** What one document says, asked of the model part by part and put together. */
async function readDocument(path: string, text: string, rules: string, known: string[], limits: WikiLimits, usage: Usage, signal: AbortSignal): Promise<{ read: Read; partial: boolean }> {
  const { parts, partial } = partsOf(text, limits);
  const system = `${READ_PROTOCOL}\n\nThe rules of the wiki:\n\n${rules}`;
  const merged: Read = { title: '', summary: '', points: [], topics: [] };
  const byKey = new Map<string, Read['topics'][number]>();
  for (const [n, part] of parts.entries()) {
    const titles = [...new Set([...known, ...merged.topics.map((t) => t.title)])].slice(0, 400);
    const prompt = [
      titles.length ? `Topics already in the wiki (use the same wording when the document is about the same thing):\n${titles.map((t) => `- ${t}`).join('\n')}\n` : '',
      `Document: ${path}${parts.length > 1 ? ` (part ${n + 1} of ${parts.length})` : ''}`,
      '---',
      part,
      '---',
    ].join('\n');
    const r = await askForRead(system, prompt, usage, signal);
    merged.title ||= r.title;
    merged.summary ||= r.summary;
    merged.points.push(...r.points);
    for (const t of r.topics) {
      const had = byKey.get(topicKey(t.title));
      if (had) {
        had.definition ||= t.definition;
        had.facts.push(...t.facts);
      } else {
        const copy = { ...t, facts: [...t.facts] };
        byKey.set(topicKey(t.title), copy);
        merged.topics.push(copy);
      }
    }
  }
  const unique = (list: string[], max: number) => [...new Set(list.map(oneLine).filter(Boolean))].slice(0, max);
  merged.points = unique(merged.points, 12);
  merged.topics = merged.topics.slice(0, 12).map((t) => ({ ...t, facts: unique(t.facts, 10) })).filter((t) => t.facts.length > 0);
  return { read: merged, partial };
}

/** Take a document's old contribution out of the topics (before it is read again, or because it is gone). */
function forget(state: WikiState, id: string, touched: Set<string>): void {
  for (const key of state.sources[id]?.topics ?? []) {
    const t = state.topics[key];
    if (!t) continue;
    t.facts = t.facts.filter((f) => f.source !== id);
    touched.add(key);
  }
}

const factsMark = (t: TopicState): string => t.facts.map((f) => `${f.source}\n${f.text}`).join('\n\n');

// ── The documents the wiki is written from ──

export interface WikiDoc extends LocalFile {
  folder: string;
}
/** Every document in the folders of this server, except the wiki's own. */
export async function wikiDocuments(dir: string): Promise<WikiDoc[]> {
  const own = wikiDir(dir);
  const out: WikiDoc[] = [];
  for (const folder of localFolders()) {
    if (resolve(folder.path) === own) continue;
    try {
      for (const file of (await listLocalFiles(folder)).files) out.push({ ...file, folder: folder.name });
    } catch {
      /* a folder that cannot be read now is read another time */
    }
  }
  return out;
}

/** Which documents are new or changed since they were read, and which that were read are gone. */
export function wikiWaiting(docs: WikiDoc[], state: WikiState): { toRead: WikiDoc[]; gone: string[] } {
  const here = new Set(docs.map((d) => d.id));
  return { toRead: docs.filter((d) => state.sources[d.id]?.modified !== d.modifiedTime), gone: Object.keys(state.sources).filter((id) => !here.has(id)) };
}

// ── A run ──

export interface WikiRun {
  running: boolean;
  /** Documents read in this run, of the documents it set out to read. */
  done: number;
  total: number;
  /** What it is on: a document being read, then a topic whose page is being written. */
  phase: 'reading' | 'writing';
  current: string | null;
  /** Topic pages whose opening was written in this run. */
  written: number;
  failed: Array<{ document: string; why: string }>;
  usage: Usage;
  /** Why it stopped before the end: stopped by the person, or something every further call would hit as well. */
  stopped: string | null;
  finishedAt: string | null;
}
let run: (WikiRun & { abort: AbortController }) | null = null;
export const wikiRun = (): WikiRun | null => {
  if (!run) return null;
  const { abort: _abort, ...view } = run;
  return view;
};
export function stopWikiRun(): void {
  if (run?.running) {
    run.stopped = 'Stopped. What was read so far is kept.';
    run.abort.abort();
  }
}

/**
 * Read up to `limit` documents that are new or changed, write their pages, and write the opening of the topic
 * pages that changed. Runs on after the caller has its answer: `wikiRun()` says how far it is. `afterWrite` is
 * called when pages were written (the folder is then read into the index again).
 */
export function startWikiRun(dir: string, opts: { limit: number; summaries?: number; afterWrite?: () => void }): WikiRun {
  if (run?.running) return wikiRun()!;
  const abort = new AbortController();
  const mine: WikiRun & { abort: AbortController } = { running: true, done: 0, total: 0, phase: 'reading', current: null, written: 0, failed: [], usage: { input: 0, output: 0, calls: 0 }, stopped: null, finishedAt: null, abort };
  run = mine;
  const root = wikiDir(dir);
  const work = async () => {
    const state = readWikiState();
    const rules = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    const limits = wikiLimits();
    const { toRead, gone } = wikiWaiting(await wikiDocuments(dir), state);
    const touched = { sources: new Set<string>(), topics: new Set<string>() };
    const log: string[] = [];
    for (const id of gone) {
      forget(state, id, touched.topics);
      rmSync(join(root, 'sources', `${state.sources[id].page}.md`), { force: true });
      log.push(`## [${today()}] gone | ${id.replace(/^local:/, '')}`);
      delete state.sources[id];
    }
    const batch = toRead.slice(0, opts.limit);
    mine.total = batch.length;
    for (const doc of batch) {
      if (abort.signal.aborted) break;
      mine.current = doc.path;
      try {
        const { text, needsOcr } = await extractLocalFile(doc.abs, doc.mimeType);
        if (needsOcr || !text.trim()) throw new LlmError('There is no text in it to read.');
        const known = Object.values(state.topics).map((t) => t.title);
        const { read, partial } = await readDocument(doc.path, text, rules, known, limits, mine.usage, abort.signal);
        forget(state, doc.id, touched.topics);
        const keys: string[] = [];
        for (const t of read.topics) {
          const key = topicKey(t.title);
          const had = state.topics[key];
          if (had) {
            had.definition ||= t.definition;
            had.facts.push(...t.facts.map((text) => ({ text, source: doc.id })));
          } else state.topics[key] = { title: nfc(t.title).trim(), kind: t.kind, definition: t.definition, facts: t.facts.map((text) => ({ text, source: doc.id })) };
          keys.push(key);
          touched.topics.add(key);
        }
        state.sources[doc.id] = { modified: doc.modifiedTime, title: oneLine(read.title) || doc.name, page: sourcePage(doc.path), summary: read.summary, points: read.points, topics: [...new Set(keys)], ...(partial ? { partial: true } : {}) };
        touched.sources.add(doc.id);
        log.push(`## [${today()}] read | ${doc.path} → ${keys.length} topic${keys.length === 1 ? '' : 's'}`);
      } catch (e) {
        if (abort.signal.aborted) break;
        const why = e instanceof Error ? e.message : String(e);
        mine.failed.push({ document: doc.path, why });
        // The key, the model, the credit: the next document would fail the same way. Stop and say why.
        if (e instanceof LlmError && !e.retry && !/no text in it|shape asked for|declined/.test(why)) {
          mine.stopped = why;
          break;
        }
      }
      mine.done++;
      // Kept after every document: a run that is stopped, or a server that restarts, loses nothing that was read.
      stateFile.write(state);
    }
    mine.current = null;
    // A topic nothing speaks of any more goes, with its page.
    for (const [key, t] of Object.entries(state.topics)) {
      if (t.facts.length > 0) continue;
      rmSync(join(root, 'topics', `${pageName(t.title)}.md`), { force: true });
      delete state.topics[key];
      touched.topics.delete(key);
    }
    // The opening of the topic pages that changed and that several facts speak of: where reading turns into a wiki.
    const stale = [...touched.topics].map((key) => [key, state.topics[key]] as const).filter(([, t]) => t && t.facts.length >= 3 && t.summaryOf !== factsMark(t));
    mine.phase = 'writing';
    for (const [key, t] of stale.slice(0, opts.summaries ?? 30)) {
      if (abort.signal.aborted || mine.stopped) break;
      mine.current = t.title;
      try {
        const facts = t.facts.map((f) => `- ${oneLine(f.text)} (from: ${state.sources[f.source]?.title ?? f.source})`).join('\n');
        const a = await ask({ system: `${SUMMARY_PROTOCOL}\n\nThe rules of the wiki:\n\n${rules}`, prompt: `Topic: ${t.title}\n\nFacts:\n${facts}`, signal: abort.signal });
        mine.usage.input += a.usage.input;
        mine.usage.output += a.usage.output;
        mine.usage.calls++;
        const written = withoutThinking(a.text).trim();
        if (written) {
          t.summary = written;
          t.summaryOf = factsMark(t);
          mine.written++;
        }
      } catch (e) {
        if (abort.signal.aborted) break;
        mine.failed.push({ document: `topic: ${t.title}`, why: e instanceof Error ? e.message : String(e) });
        if (e instanceof LlmError && !e.retry && !/declined/.test(e.message)) break;
      }
      void key;
    }
    // A summary written from facts that have since changed is not shown as if it still held.
    for (const key of touched.topics) {
      const t = state.topics[key];
      if (t?.summary && t.summaryOf !== factsMark(t)) delete t.summary;
    }
    mine.current = null;
    stateFile.write(state);
    // Related topics are read from the documents they share, so the neighbours of what changed are written too.
    for (const id of touched.sources) for (const key of state.sources[id]?.topics ?? []) touched.topics.add(key);
    writeWiki(dir, state, touched);
    if (log.length) writeFileSync(join(root, 'log.md'), `${readFileSync(join(root, 'log.md'), 'utf8').trimEnd()}\n\n${log.join('\n')}\n`);
    if (touched.sources.size || touched.topics.size || gone.length) opts.afterWrite?.();
  };
  void work()
    .catch((e) => {
      mine.stopped ??= e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      mine.running = false;
      mine.current = null;
      mine.finishedAt = new Date().toISOString();
    });
  return wikiRun()!;
}

/** What the page shows: is there a wiki, how much is in it, how much waits to be read. */
export async function wikiStatus(dir: string): Promise<{ exists: boolean; path: string; documents: number; topics: number; waiting: number; gone: number; run: WikiRun | null }> {
  const state = readWikiState();
  const exists = wikiExists(dir);
  const { toRead, gone } = exists ? wikiWaiting(await wikiDocuments(dir), state) : { toRead: [], gone: [] };
  return { exists, path: wikiDir(dir), documents: Object.keys(state.sources).length, topics: Object.keys(state.topics).length, waiting: toRead.length, gone: gone.length, run: wikiRun() };
}
