/**
 * How well does search find the right document, on these documents?
 *
 * How passages are cut and embedded changes what search finds, and which way is best depends on the documents.
 * So it is measured rather than assumed: a set of questions, each with the document that answers it, is asked of
 * the index, and what counts is where that document comes out. The questions can be written by hand, or made from
 * the documents by the connected model (a question a person would ask, in other words than the document's).
 *
 * Three ways of searching are scored side by side, since they fail on different questions: keywords, meaning
 * (vectors), and both merged as the search tool does. A fourth on request: the search assistant (agent_search.ts),
 * which searches several times with the connected model. It costs a few model calls per question, so it is asked
 * for, not run by default.
 *
 * A question may have several right documents (a question with several parts, or "which documents say X"). Then
 * what counts is how many of them come and how high: recall (the share among the first ten) and NDCG (the same,
 * weighed by place). With one right document NDCG is 1 for the first place, 0.63 for the second, 0.5 for the third.
 */
import { authStore, getAuthMaybe } from '../../core/context.js';
import { getConfig } from '../../core/config.js';
import { ask, searchLlmSettings } from '../../core/llm.js';
import { embedQuery, embeddingsConfigured } from '../drive/embeddings.js';
import { extractLocalFile } from '../drive/extract_text.js';
import { DRIVE_COLLECTION, getLocalIndex, vectorForm, vectorProblem, type ScoredPoint } from '../drive/qdrant.js';
import { listLocalFiles, localFolders, type LocalFile } from './folders.js';
import { agentSearch, type Effort } from './agent_search.js';
import { fuse } from './hybrid.js';
import { withoutThinking } from './wiki.js';

export interface EvalQuestion {
  question: string;
  /** The document that answers it: its ID, or a part of its path. */
  document: string;
  /** Other documents that answer it too (each its ID, or a part of its path). */
  documents?: string[];
  /** Free label, to read the result by kind (a keyword question, a paraphrase, …). */
  kind?: string;
}
export interface ModeScore {
  /** The document was the first one. */
  first: number;
  /** It was among the first three documents: what an assistant reads of a search. */
  top3: number;
  /** It was among the first ten. */
  top10: number;
  /** Mean of 1/rank over the questions (0 when it was not among the first ten). */
  mrr: number;
  /** Mean NDCG of the first ten. Not in measurements made before it was. */
  ndcg?: number;
  /** Mean share of the right documents among the first ten. Not in measurements made before it was. */
  recall?: number;
}
export type EvalMode = 'keyword' | 'meaning' | 'both' | 'agent';
/** What the search assistant cost, per question on average, when it was measured. */
export interface AgentCost {
  model: string;
  effort: Effort;
  seconds: number;
  /** Tokens read and written. */
  tokens: number;
  searches: number;
}
export interface EvalScore {
  questions: number;
  /** agent: null unless it was asked for. */
  modes: Record<EvalMode, ModeScore | null>;
  agent: AgentCost | null;
  /** Why meaning could not be scored, when it could not. */
  note: string | null;
  /** Questions whose document was not among the first three with both merged: what there is to look at. */
  misses: Array<{ question: string; document: string; got: string[] }>;
}

const DEPTH = 40;
/** The right documents of a question. */
export const targetsOf = (q: EvalQuestion): string[] => [...new Set([q.document, ...(q.documents ?? [])].filter(Boolean))];
const isTarget = (target: string, id: string, path: string): boolean => id === target || id.includes(target) || path.includes(target);

/** Where the right documents came among the first ten of a result (1-based, in order), for one question. */
export interface Placed {
  ranks: number[];
  /** How many right documents the question has. */
  wanted: number;
}
/** The documents of a result in order, each once, and where the right ones are among the first ten. */
export function placeOf(targets: string[], docs: Array<{ id: string; path: string }>): Placed & { got: string[] } {
  const seen: Array<{ id: string; path: string }> = [];
  for (const d of docs) {
    if (seen.some((s) => s.id === d.id)) continue;
    seen.push(d);
    if (seen.length >= 10) break;
  }
  // A target is a part of a path and may match several documents: each target is credited once, at the first
  // document that matches it, and each document once. So NDCG stays within 1 and recall counts targets.
  const open = [...targets];
  const ranks: number[] = [];
  seen.forEach((d, i) => {
    const t = open.findIndex((x) => isTarget(x, d.id, d.path));
    if (t < 0) return;
    open.splice(t, 1);
    ranks.push(i + 1);
  });
  return { ranks, wanted: Math.max(1, targets.length), got: seen.slice(0, 3).map((d) => d.path || d.id) };
}
const docsOf = (points: ScoredPoint[]) => points.map((p) => ({ id: String(p.payload?.file_id ?? ''), path: String(p.payload?.file_path ?? '') }));

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const gain = (rank: number) => 1 / Math.log2(rank + 1);
/** Scores over the questions. A number is where the one right document came (0: not among the first ten). */
export function scoreOf(placed: Array<number | Placed>): ModeScore {
  const ps: Placed[] = placed.map((p) => (typeof p === 'number' ? { ranks: p ? [p] : [], wanted: 1 } : p));
  const n = Math.max(1, ps.length);
  const ideal = (wanted: number) => Array.from({ length: Math.min(wanted, 10) }, (_, i) => gain(i + 1)).reduce((s, g) => s + g, 0);
  return {
    first: ps.filter((p) => p.ranks.includes(1)).length,
    top3: ps.filter((p) => p.ranks.some((r) => r <= 3)).length,
    top10: ps.filter((p) => p.ranks.length > 0).length,
    mrr: round3(ps.reduce((s, p) => s + (p.ranks.length ? 1 / Math.min(...p.ranks) : 0), 0) / n),
    ndcg: round3(ps.reduce((s, p) => s + p.ranks.reduce((g, r) => g + gain(r), 0) / ideal(p.wanted), 0) / n),
    recall: round3(ps.reduce((s, p) => s + Math.min(1, p.ranks.length / p.wanted), 0) / n),
  };
}

/** The owner of this machine, for measuring from the console or a terminal: every document is theirs to search. */
const owner = () => ({ ok: true as const, org_id: getConfig().orgId, role: 'admin' as const, email: 'console@localhost' });

/** Ask every question of the index as it is, three ways; and of the search assistant too with `agent`. */
export async function scoreQuestions(questions: EvalQuestion[], signal?: AbortSignal, each?: (done: number) => void, opts: { agent?: Effort } = {}): Promise<EvalScore> {
  const index = await getLocalIndex();
  if (!index) throw new Error('Scoring reads the built-in index. With QDRANT_URL set there is no keyword index to compare with.');
  const problem = embeddingsConfigured() ? await vectorProblem() : 'no embedding model is set';
  const agentModel = opts.agent ? searchLlmSettings() : null;
  if (opts.agent && !agentModel) throw new Error('Measuring the search assistant needs a language model. Connect one on the Models page.');
  const placed: Record<EvalMode, Placed[]> = { keyword: [], meaning: [], both: [], agent: [] };
  const misses: EvalScore['misses'] = [];
  const prefix = problem ? '' : (await vectorForm()).queryPrefix;
  const cost = { ms: 0, tokens: 0, searches: 0, model: agentModel?.model ?? '' };
  for (const [n, q] of questions.entries()) {
    if (signal?.aborted) break;
    each?.(n);
    const targets = targetsOf(q);
    const keyword = await index.keywordSearch(DRIVE_COLLECTION, { query: q.question, limit: DEPTH, with_payload: true });
    placed.keyword.push(placeOf(targets, docsOf(keyword)));
    let meaning: ScoredPoint[] | null = null;
    if (!problem) {
      meaning = await index.search(DRIVE_COLLECTION, { vector: await embedQuery(q.question, prefix), limit: DEPTH, with_payload: true });
      placed.meaning.push(placeOf(targets, docsOf(meaning)));
    }
    // Merged exactly as the search tool merges them.
    const merged = fuse([{ kind: 'keyword', points: keyword }, ...(meaning ? [{ kind: 'semantic' as const, points: meaning }] : [])]).map((h) => ({ id: '', score: h.score, payload: h.payload }) as unknown as ScoredPoint);
    const both = placeOf(targets, docsOf(merged));
    placed.both.push(both);
    if (!both.ranks.some((r) => r <= 3)) misses.push({ question: q.question, document: targets.join(', '), got: both.got });
    if (opts.agent && agentModel) {
      const run = () => agentSearch(q.question, { effort: opts.agent, limit: 10, signal, settings: agentModel });
      // A failure on one question counts as not found: a measurement is not lost to one bad answer.
      const r = await (getAuthMaybe() ? run() : authStore.run(owner(), run)).catch((e) => {
        if (signal?.aborted) throw e;
        return null;
      });
      placed.agent.push(placeOf(targets, r?.documents ?? []));
      if (r) {
        cost.ms += r.ms;
        cost.tokens += r.usage.input + r.usage.output;
        cost.searches += r.searches;
        cost.model = r.model;
      }
    }
  }
  const asked = Math.max(1, placed.both.length);
  return {
    questions: questions.length,
    modes: { keyword: scoreOf(placed.keyword), meaning: problem ? null : scoreOf(placed.meaning), both: scoreOf(placed.both), agent: opts.agent ? scoreOf(placed.agent) : null },
    agent: opts.agent ? { model: cost.model, effort: opts.agent, seconds: Math.round(cost.ms / asked / 100) / 10, tokens: Math.round(cost.tokens / asked), searches: Math.round((cost.searches / asked) * 10) / 10 } : null,
    note: problem,
    misses,
  };
}

const QUESTION_PROTOCOL = `You are given one document. Write one question that a person would ask and that this document answers.

- The person has not seen the document: use the words they would use, not the document's title and not its exact wording.
- The question must be about something specific to this document, so that other documents on the same subject would not answer it.
- Write it in the language of the document.

Answer with one line and nothing else:
QUESTION: the question`;

/** Documents to make questions from: spread over the folders, with enough text in them. */
export async function sampleDocuments(n: number, skipFolders: string[] = []): Promise<Array<LocalFile & { text: string }>> {
  const all: LocalFile[] = [];
  for (const folder of localFolders()) {
    if (skipFolders.includes(folder.name)) continue;
    try {
      all.push(...(await listLocalFiles(folder)).files);
    } catch {
      /* not readable now */
    }
  }
  const out: Array<LocalFile & { text: string }> = [];
  const step = Math.max(1, Math.floor(all.length / (n * 2)));
  for (let i = 0; i < all.length && out.length < n; i += step) {
    try {
      const { text, needsOcr } = await extractLocalFile(all[i].abs, all[i].mimeType);
      if (!needsOcr && text.trim().length >= 600) out.push({ ...all[i], text });
    } catch {
      /* a file that will not open makes no question */
    }
  }
  return out;
}

/** One question per document, written by the connected model. A document it writes nothing usable for is passed over. */
export async function makeQuestions(docs: Array<{ id: string; path: string; text: string }>, signal?: AbortSignal, each?: (done: number) => void): Promise<EvalQuestion[]> {
  const out: EvalQuestion[] = [];
  for (const [i, doc] of docs.entries()) {
    if (signal?.aborted) break;
    try {
      const a = await ask({ system: QUESTION_PROTOCOL, prompt: `Document: ${doc.path}\n---\n${doc.text.slice(0, 12_000)}\n---`, signal });
      const line = /^[\s>*#-]*(?:\*\*)?QUESTION(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.+)$/im.exec(withoutThinking(a.text))?.[1]?.trim();
      if (line && line.length >= 8) out.push({ question: line.slice(0, 400), document: doc.id, kind: 'made' });
    } catch (e) {
      if (signal?.aborted) break;
      throw e;
    }
    each?.(i + 1);
  }
  return out;
}
