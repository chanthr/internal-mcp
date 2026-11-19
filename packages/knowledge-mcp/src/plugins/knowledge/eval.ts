/**
 * How well does search find the right document, on these documents?
 *
 * How passages are cut and embedded changes what search finds, and which way is best depends on the documents.
 * So it is measured rather than assumed: a set of questions, each with the document that answers it, is asked of
 * the index, and what counts is where that document comes out. The questions can be written by hand, or made from
 * the documents by the connected model (a question a person would ask, in other words than the document's).
 *
 * Three ways of searching are scored side by side, since they fail on different questions: keywords, meaning
 * (vectors), and both merged as the search tool does.
 */
import { ask } from '../../core/llm.js';
import { embedQuery, embeddingsConfigured } from '../drive/embeddings.js';
import { extractLocalFile } from '../drive/extract_text.js';
import { DRIVE_COLLECTION, getLocalIndex, vectorForm, vectorProblem, type ScoredPoint } from '../drive/qdrant.js';
import { listLocalFiles, localFolders, type LocalFile } from './folders.js';
import { fuse } from './hybrid.js';
import { withoutThinking } from './wiki.js';

export interface EvalQuestion {
  question: string;
  /** The document that answers it: its ID, or a part of its path. */
  document: string;
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
}
export type EvalMode = 'keyword' | 'meaning' | 'both';
export interface EvalScore {
  questions: number;
  modes: Record<EvalMode, ModeScore | null>;
  /** Why meaning could not be scored, when it could not. */
  note: string | null;
  /** Questions whose document was not among the first three with both merged: what there is to look at. */
  misses: Array<{ question: string; document: string; got: string[] }>;
}

const DEPTH = 40;
const matches = (target: string, p: ScoredPoint): boolean => {
  const id = String(p.payload?.file_id ?? '');
  const path = String(p.payload?.file_path ?? '');
  return id === target || id.includes(target) || path.includes(target);
};
/** The documents of a result in order, each once, and where the wanted one is among them (0: not among the first ten). */
function rankOf(target: string, points: ScoredPoint[]): { rank: number; got: string[] } {
  const seen: string[] = [];
  let rank = 0;
  for (const p of points) {
    const id = String(p.payload?.file_id ?? '');
    if (seen.includes(id)) continue;
    seen.push(id);
    if (!rank && matches(target, p)) rank = seen.length;
    if (seen.length >= 10) break;
  }
  return { rank, got: seen.slice(0, 3).map((id) => String(points.find((p) => String(p.payload?.file_id) === id)?.payload?.file_path ?? id)) };
}
export const scoreOf = (ranks: number[]): ModeScore => ({
  first: ranks.filter((r) => r === 1).length,
  top3: ranks.filter((r) => r >= 1 && r <= 3).length,
  top10: ranks.filter((r) => r >= 1).length,
  mrr: Math.round((ranks.reduce((s, r) => s + (r ? 1 / r : 0), 0) / Math.max(1, ranks.length)) * 1000) / 1000,
});

/** Ask every question of the index as it is now, three ways. */
export async function scoreQuestions(questions: EvalQuestion[], signal?: AbortSignal, each?: (done: number) => void): Promise<EvalScore> {
  const index = await getLocalIndex();
  if (!index) throw new Error('Scoring reads the built-in index. With QDRANT_URL set there is no keyword index to compare with.');
  const problem = embeddingsConfigured() ? await vectorProblem() : 'no embedding model is set';
  const ranks: Record<EvalMode, number[]> = { keyword: [], meaning: [], both: [] };
  const misses: EvalScore['misses'] = [];
  const prefix = problem ? '' : (await vectorForm()).queryPrefix;
  for (const [n, q] of questions.entries()) {
    if (signal?.aborted) break;
    each?.(n);
    const keyword = await index.keywordSearch(DRIVE_COLLECTION, { query: q.question, limit: DEPTH, with_payload: true });
    ranks.keyword.push(rankOf(q.document, keyword).rank);
    let meaning: ScoredPoint[] | null = null;
    if (!problem) {
      meaning = await index.search(DRIVE_COLLECTION, { vector: await embedQuery(q.question, prefix), limit: DEPTH, with_payload: true });
      ranks.meaning.push(rankOf(q.document, meaning).rank);
    }
    // Merged exactly as the search tool merges them.
    const merged = fuse([{ kind: 'keyword', points: keyword }, ...(meaning ? [{ kind: 'semantic' as const, points: meaning }] : [])]).map((h) => ({ id: '', score: h.score, payload: h.payload }) as unknown as ScoredPoint);
    const both = rankOf(q.document, merged);
    ranks.both.push(both.rank);
    if (!(both.rank >= 1 && both.rank <= 3)) misses.push({ question: q.question, document: q.document, got: both.got });
  }
  return { questions: questions.length, modes: { keyword: scoreOf(ranks.keyword), meaning: problem ? null : scoreOf(ranks.meaning), both: scoreOf(ranks.both) }, note: problem, misses };
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
