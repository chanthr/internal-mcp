/**
 * Measuring search on one's own documents, and comparing ways of cutting them, before choosing one.
 *
 * Which way of cutting finds most depends on the documents, so this does not guess: it asks.
 *
 *   measure   The questions (eval.ts) are asked of the index as it is, by keywords, by meaning and with both.
 *             The result is kept with how the index was made, so the next one can be set beside it.
 *   compare   A sample of the documents is cut each way and embedded in memory, and the same questions are asked
 *             of each by meaning. The index is not touched. What it costs is the embedding of the sample, once
 *             per way.
 *
 * The questions are written once by the connected model, one per sampled document, and kept: every measurement
 * asks the same ones, or the numbers could not be compared. They can be replaced by one's own in the same file
 * (`<data>/search-measure.json`, "questions": [{ "question": "…", "document": "a part of its path" }], with
 * "documents": [ … ] for a question that more documents answer).
 *
 * Measuring can also ask the search assistant (agent_search.ts) each question: slower, and it uses the model.
 *
 * Comparing reads the documents from the folders on this machine. Documents in Drive are not part of it.
 */
import { dataFile } from '../../core/data_file.js';
import { llmConfigured, searchLlmSettings } from '../../core/llm.js';
import { chunkMarkdown } from '../drive/chunker.js';
import { embedTexts, embeddingsConfigured, EMBEDDING_MODEL } from '../drive/embeddings.js';
import { extractLocalFile } from '../drive/extract_text.js';
import { cutMark, indexProfile, type IndexProfile } from '../drive/index_profile.js';
import { embedInputForChunk } from '../drive/indexer.js';
import { DRIVE_COLLECTION, getLocalIndex } from '../drive/qdrant.js';
import type { Effort } from './agent_search.js';
import { makeQuestions, sampleDocuments, scoreOf, scoreQuestions, type AgentCost, type EvalMode, type EvalQuestion, type ModeScore } from './eval.js';
import { listLocalFiles, localFolders, type LocalFile } from './folders.js';
import { WIKI } from './wiki.js';

/** Documents a question is written from. */
const QUESTIONS = 40;
/** Documents a comparison cuts and embeds, each way. */
const SAMPLE = 200;
const FEWEST = 5;

/** The ways of cutting that are offered by name, and compared. Any other is set as numbers. */
export const WAYS: ReadonlyArray<Pick<IndexProfile, 'cut' | 'maxTokens'>> = [
  { cut: 'sections', maxTokens: 800 },
  { cut: 'sections', maxTokens: 400 },
  { cut: 'sections', maxTokens: 250 },
  { cut: 'windows', maxTokens: 400 },
];
/** The profile in force with another way of cutting: the overlap follows the size unless it is set. */
export function profileWith(way: Pick<IndexProfile, 'cut' | 'maxTokens'>, base: IndexProfile = indexProfile()): IndexProfile {
  const same = base.cut === way.cut && base.maxTokens === way.maxTokens;
  return same
    ? base
    : { ...base, cut: way.cut, maxTokens: way.maxTokens, minTokens: Math.min(50, Math.floor(way.maxTokens / 4)), overlapTokens: Math.min(100, Math.floor(way.maxTokens / 8)) };
}

export interface Measured {
  at: string;
  /** How the documents were cut (index_profile.ts cutMark) and which model made the vectors. */
  cut: string;
  model: string | null;
  documents: number;
  passages: number;
  questions: number;
  /** agent: not in measurements made before it could be measured. */
  modes: Partial<Record<EvalMode, ModeScore | null>>;
  /** What the search assistant cost, when it was measured. */
  agent?: AgentCost | null;
  /** Why meaning was not measured, when it was not. */
  note: string | null;
}
export interface Compared {
  at: string;
  model: string;
  documents: number;
  questions: number;
  ways: Array<{ cut: string; passages: number; score: ModeScore }>;
}
interface Saved {
  questions?: EvalQuestion[];
  measured?: Measured[];
  compared?: Compared | null;
}
const saved = dataFile<Saved>('search-measure.json');

export interface MeasureRun {
  running: boolean;
  what: 'measure' | 'compare';
  /** Writing the questions, asking them of the index, or embedding the sample one way. */
  phase: 'questions' | 'asking' | 'embedding';
  done: number;
  total: number;
  /** compare: the way being embedded. */
  way: string | null;
  error: string | null;
  /** measure: the search assistant is asked too, with this effort. */
  agent?: Effort | null;
}
let current: (MeasureRun & { stop: AbortController }) | null = null;

export interface MeasureView {
  questions: number;
  /** A model is connected, so questions can be written. */
  canWrite: boolean;
  /** The model the search assistant would be measured with, or null when there is none. */
  agentModel: string | null;
  measured: Measured[];
  compared: Compared | null;
  run: MeasureRun | null;
  /** Where the questions are kept, for someone who writes their own. */
  file: string;
}
export function measureView(): MeasureView {
  const s = saved.read();
  const run = current ? { running: current.running, what: current.what, phase: current.phase, done: current.done, total: current.total, way: current.way, error: current.error, agent: current.agent ?? null } : null;
  return { questions: s?.questions?.length ?? 0, canWrite: llmConfigured(), agentModel: searchLlmSettings()?.model ?? null, measured: s?.measured ?? [], compared: s?.compared ?? null, run, file: saved.path() };
}

type Progress = Pick<MeasureRun, 'phase' | 'done' | 'total' | 'way'>;

async function questions(fresh: boolean, signal: AbortSignal, at: Progress): Promise<EvalQuestion[]> {
  const kept = saved.read()?.questions ?? [];
  if (!fresh && kept.length >= FEWEST) return kept;
  if (!llmConfigured()) throw new Error(`There are no questions to ask yet. Connect a language model on the Models page and it writes them from your documents, or write your own in ${saved.path()}.`);
  Object.assign(at, { phase: 'questions', done: 0, total: 0 });
  // Not from the wiki: its pages are written by a model from the documents, and say the same things again.
  const docs = await sampleDocuments(QUESTIONS, [WIKI]);
  if (docs.length < FEWEST) throw new Error(`Measuring needs at least ${FEWEST} documents with text in the folders on this machine. There are ${docs.length}.`);
  at.total = docs.length;
  const made = await makeQuestions(docs, signal, (done) => (at.done = done));
  if (signal.aborted) throw new Error('Stopped.');
  if (made.length < FEWEST) throw new Error('The model wrote too few usable questions. Try again, or connect another model.');
  // New questions: what was measured with the old ones cannot be set beside what comes now.
  saved.write({ questions: made, measured: [], compared: null });
  return made;
}

/** Ask the questions of the index as it is, and keep the result. `agent`: ask the search assistant too. */
export async function measure(opts: { fresh?: boolean; agent?: Effort; signal?: AbortSignal; progress?: Progress } = {}): Promise<Measured> {
  const signal = opts.signal ?? new AbortController().signal;
  const at: Progress = opts.progress ?? { phase: 'asking', done: 0, total: 0, way: null };
  const index = await getLocalIndex();
  if (!index) throw new Error('Measuring reads the built-in index. With QDRANT_URL set there is no keyword index to set beside the vectors.');
  const asked = await questions(!!opts.fresh, signal, at);
  Object.assign(at, { phase: 'asking', done: 0, total: asked.length });
  const score = await scoreQuestions(asked, signal, (done) => (at.done = done), { agent: opts.agent });
  if (signal.aborted) throw new Error('Stopped.');
  const stats = await index.stats(DRIVE_COLLECTION);
  const made = await index.embeddingState(DRIVE_COLLECTION);
  const result: Measured = {
    at: new Date().toISOString(),
    cut: cutMark(),
    model: made && made.vectors > 0 ? made.model : null,
    documents: stats.documents,
    passages: stats.chunks,
    questions: score.questions,
    modes: score.modes,
    agent: score.agent,
    note: score.note,
  };
  const s = saved.read() ?? {};
  saved.write({ ...s, measured: [result, ...(s.measured ?? [])].slice(0, 12) });
  return result;
}

const unit = (v: number[]): Float32Array => {
  const out = Float32Array.from(v);
  let n = 0;
  for (const x of out) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
};
const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** The documents a comparison is made on: those the questions are about, then others from every folder. */
async function sampleFor(asked: EvalQuestion[]): Promise<Array<LocalFile & { text: string }>> {
  const all: LocalFile[] = [];
  for (const folder of localFolders()) {
    if (folder.name === WIKI) continue;
    try {
      all.push(...(await listLocalFiles(folder)).files);
    } catch {
      /* not readable now */
    }
  }
  const wanted = (f: LocalFile) => asked.some((q) => f.id === q.document || f.id.includes(q.document) || f.path.includes(q.document));
  const first = all.filter(wanted);
  const rest = all.filter((f) => !wanted(f));
  const step = Math.max(1, Math.floor(rest.length / Math.max(1, SAMPLE - first.length)));
  const picked = [...first, ...rest.filter((_, i) => i % step === 0)].slice(0, Math.max(SAMPLE, first.length));
  const out: Array<LocalFile & { text: string }> = [];
  for (const f of picked) {
    try {
      const { text, needsOcr } = await extractLocalFile(f.abs, f.mimeType);
      if (!needsOcr && text.trim()) out.push({ ...f, text });
    } catch {
      /* a file that will not open is left out */
    }
  }
  return out;
}

/**
 * The passages of the sample cut one way, as they would be embedded. One document at a time, with what else waits let
 * in between: cutting 200 documents in one go held the server for 0.7 to 2.3 seconds a way, five ways in a row.
 */
export async function samplePassages(docs: ReadonlyArray<{ name: string; text: string }>, way: IndexProfile, signal?: AbortSignal): Promise<Array<{ doc: number; input: string }>> {
  const passages: Array<{ doc: number; input: string }> = [];
  for (const [d, doc] of docs.entries()) {
    await new Promise((resolve) => setImmediate(resolve));
    if (signal?.aborted) throw new Error('Stopped.');
    for (const c of chunkMarkdown(doc.text, way)) passages.push({ doc: d, input: embedInputForChunk(c, doc.name, way) });
  }
  return passages;
}

/**
 * Cut a sample of the documents each way, embed it, and ask the questions of each by meaning. Nothing is stored
 * but the result: the index stays as it is.
 */
export async function compare(opts: { fresh?: boolean; signal?: AbortSignal; progress?: Progress } = {}): Promise<Compared> {
  const signal = opts.signal ?? new AbortController().signal;
  const at: Progress = opts.progress ?? { phase: 'embedding', done: 0, total: 0, way: null };
  if (!embeddingsConfigured()) throw new Error('Comparing ways of cutting needs an embedding model. Set one up under "Search by meaning" first.');
  const all = await questions(!!opts.fresh, signal, at);
  const docs = await sampleFor(all);
  const answers = (q: EvalQuestion, d: LocalFile) => d.id === q.document || d.id.includes(q.document) || d.path.includes(q.document);
  const asked = all.filter((q) => docs.some((d) => answers(q, d)));
  if (asked.length < FEWEST) throw new Error('The documents the questions are about are not in the folders on this machine any more. Measure again with new questions.');

  const base = indexProfile();
  const ways = [...WAYS.map((w) => profileWith(w, base)), ...(WAYS.some((w) => w.cut === base.cut && w.maxTokens === base.maxTokens) ? [] : [base])];
  // The form the settings ask for, which is what a new index would be made in.
  const asks = (await embedTexts(asked.map((q) => `${base.queryPrefix}${q.question}`))).map(unit);
  const result: Compared = { at: new Date().toISOString(), model: EMBEDDING_MODEL, documents: docs.length, questions: asked.length, ways: [] };

  for (const way of ways) {
    const passages = await samplePassages(docs, way, signal);
    Object.assign(at, { phase: 'embedding', way: cutMark(way), done: 0, total: passages.length });
    const vectors: Float32Array[] = [];
    for (let i = 0; i < passages.length; i += 64) {
      if (signal.aborted) throw new Error('Stopped.');
      vectors.push(...(await embedTexts(passages.slice(i, i + 64).map((p) => p.input))).map(unit));
      at.done = vectors.length;
    }
    const ranks = asked.map((q, qi) => {
      // A document comes where its best passage comes.
      const best = new Map<number, number>();
      for (const [i, v] of vectors.entries()) {
        const s = dot(asks[qi], v);
        if (s > (best.get(passages[i].doc) ?? -Infinity)) best.set(passages[i].doc, s);
      }
      const order = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      return order.findIndex(([d]) => answers(q, docs[d])) + 1;
    });
    result.ways.push({ cut: cutMark(way), passages: passages.length, score: scoreOf(ranks) });
  }
  // When it was finished: a comparison takes minutes.
  result.at = new Date().toISOString();
  saved.write({ ...(saved.read() ?? {}), compared: result });
  return result;
}

/** From the console: start one, and let the page read how far it is. */
export function startMeasure(what: 'measure' | 'compare', fresh = false, agent: Effort | null = null): MeasureRun {
  if (current?.running) return current;
  const run: NonNullable<typeof current> = { running: true, what, phase: 'asking', done: 0, total: 0, way: null, error: null, agent: what === 'measure' ? agent : null, stop: new AbortController() };
  current = run;
  void (what === 'measure' ? measure({ fresh, agent: agent ?? undefined, signal: run.stop.signal, progress: run }) : compare({ fresh, signal: run.stop.signal, progress: run }))
    .catch((e) => {
      run.error = run.stop.signal.aborted ? null : e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      run.running = false;
    });
  return run;
}
export function stopMeasure(): void {
  current?.stop.abort();
}
