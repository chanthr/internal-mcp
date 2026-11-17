/**
 * Search over the index: keywords, meaning, or both.
 *
 *   - Built-in index, no embedding model  → keyword search (BM25). Works with nothing configured.
 *   - Built-in index, embedding model     → keyword and vector search, merged.
 *   - Qdrant                              → vector search (Qdrant holds no keyword index here).
 *
 * Why both: keyword search finds the document that uses the words of the question, and costs nothing. Vector
 * search also finds it when the question is phrased differently, but needs a model. Merged, each covers the other's
 * misses. And when the embedding endpoint is down, search still answers from keywords instead of failing.
 *
 * Merging uses reciprocal rank fusion: a chunk's score is the sum of 1 / (K + its rank) over the lists it appears
 * in. Only ranks are used, so the two kinds of score (BM25, cosine) never have to be made comparable.
 *
 * K is 2, not the textbook 60. With 60 the top of a list is almost flat (rank 1 scores 1/61, rank 30 scores 1/90),
 * so a passage that is 30th in both lists outranks the passage that is first in one of them. That suits merging
 * long result lists; here five passages are shown, and the first hit of either search is the likeliest answer.
 * Measured on 24 questions over 508 documents with a small local model: keywords alone found 16, meaning alone 17,
 * merged with K=60 only 14, merged with any K from 0 to 5 found 17.
 */
import { embedQuery, embeddingsConfigured } from '../drive/embeddings.js';
import { DRIVE_COLLECTION, getLocalIndex, getQdrantClient, vectorProblem, type ChunkPayload, type ScoredPoint } from '../drive/qdrant.js';

export type SearchMode = 'keyword' | 'keyword + semantic' | 'semantic';
export type Must = Array<{ key: string; match: { value: string | boolean } }>;

export interface IndexHit {
  payload: ChunkPayload;
  /** Fused score, 1.0 for the best hit. Comparable only within one search. */
  score: number;
  /** Which searches found this chunk. */
  matched: Array<'keyword' | 'semantic'>;
}

export interface IndexSearch {
  mode: SearchMode;
  hits: IndexHit[];
  /** Set when vector search was configured but failed and the result is keywords only. */
  degraded?: string;
  /** True when nothing is indexed at all (as opposed to nothing matching). */
  empty: boolean;
}

const RRF_K = 2;

/** Merge ranked lists by reciprocal rank fusion. Exported for tests. */
export function fuse(lists: Array<{ kind: 'keyword' | 'semantic'; points: ScoredPoint[] }>): IndexHit[] {
  const byId = new Map<string, { payload: ChunkPayload; score: number; matched: Array<'keyword' | 'semantic'> }>();
  for (const { kind, points } of lists) {
    points.forEach((pt, rank) => {
      const id = String(pt.id);
      const hit = byId.get(id) ?? { payload: pt.payload as unknown as ChunkPayload, score: 0, matched: [] };
      hit.score += 1 / (RRF_K + rank + 1);
      hit.matched.push(kind);
      byId.set(id, hit);
    });
  }
  const hits = [...byId.values()].sort((a, b) => b.score - a.score);
  const best = hits[0]?.score ?? 1;
  return hits.map((h) => ({ ...h, score: h.score / best }));
}

/** Search the index. `limit` is how many candidates to return (callers filter and trim afterwards). */
export async function searchIndex(query: string, must: Must, limit: number): Promise<IndexSearch> {
  const filter = must.length > 0 ? { must } : undefined;
  const local = await getLocalIndex();

  if (!local) {
    const vector = await embedQuery(query);
    const points = await (await getQdrantClient()).search(DRIVE_COLLECTION, { vector, limit, with_payload: true, filter });
    return { mode: 'semantic', hits: fuse([{ kind: 'semantic', points }]), empty: points.length === 0 && (await isEmpty()) };
  }

  const keyword = await local.keywordSearch(DRIVE_COLLECTION, { query, limit, filter, with_payload: true });
  let semantic: ScoredPoint[] | null = null;
  let degraded: string | undefined;
  if (embeddingsConfigured()) {
    try {
      // Vectors of another model must not be searched with this model's query vector.
      const problem = await vectorProblem();
      if (problem) throw new Error(problem);
      const vector = await embedQuery(query);
      semantic = await local.search(DRIVE_COLLECTION, { vector, limit, with_payload: true, filter });
    } catch (e) {
      // The embedding endpoint is down, the key is wrong, or the stored vectors are another model's. Keywords still answer.
      degraded = e instanceof Error ? e.message : String(e);
    }
  }
  const lists: Array<{ kind: 'keyword' | 'semantic'; points: ScoredPoint[] }> = [{ kind: 'keyword', points: keyword }];
  if (semantic) lists.push({ kind: 'semantic', points: semantic });
  const hits = fuse(lists).slice(0, limit);
  return {
    mode: semantic ? 'keyword + semantic' : 'keyword',
    hits,
    degraded,
    empty: hits.length === 0 && (await local.stats(DRIVE_COLLECTION)).chunks === 0,
  };
}

async function isEmpty(): Promise<boolean> {
  const page = await (await getQdrantClient()).scroll(DRIVE_COLLECTION, { limit: 1, with_payload: false, with_vector: false });
  return page.points.length === 0;
}
