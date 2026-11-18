/**
 * New vectors for every stored passage, made by the embedding model that is configured now.
 *
 * Needed after the model changes: vectors of two models cannot be compared, so the old ones are dropped and new
 * ones are made from the passage text the index already holds. No document is read again, and keyword search keeps
 * answering the whole time. Used by `knowledge reembed` and by the console.
 */
import { cli } from '../../core/invocation.js';
import { embedQuery, embeddingsConfigured, EMBEDDING_DIM, EMBEDDING_MODEL } from '../drive/embeddings.js';
import { withLock } from '../../core/lock.js';
import { BACKFILL_LOCK, fillMissingVectors } from '../drive/indexer.js';
import { DRIVE_COLLECTION, getLocalIndex } from '../drive/qdrant.js';

export type Reembedded =
  | { ok: true; model: string; dropped: number; passages: number; withVectors: number }
  /** Nothing was changed, and `why` says what to do instead. */
  | { ok: false; why: string };

/**
 * Drop the stored vectors and make new ones. `onProgress` is called after every batch with how many passages have
 * a vector so far. Nothing is dropped unless the model answers first, with vectors of the configured size.
 */
export async function reembed(onProgress?: (done: number, total: number) => void): Promise<Reembedded> {
  if (!embeddingsConfigured()) return { ok: false, why: `No embedding model is configured. Set one first: ${cli('setup embeddings')} (search works by keywords without one).` };
  const index = await getLocalIndex();
  if (!index) return { ok: false, why: `Vectors are in Qdrant. After changing the model run: ${cli('drive reindex --recreate')}` };
  // Ask the model first: dropping the old vectors and then finding the new model unreachable would leave none.
  const probe = await embedQuery('ping');
  if (probe.length !== EMBEDDING_DIM) {
    return {
      ok: false,
      why: `${EMBEDDING_MODEL} returns ${probe.length}-dimension vectors but EMBEDDING_DIM is ${EMBEDDING_DIM}. Set EMBEDDING_DIM=${probe.length} (${cli('setup embeddings')} does this) and run this again.`,
    };
  }
  // The old vectors are dropped only by the run that then makes the new ones. Dropping them while another run was
  // filling in vectors left the index nearly empty of vectors and nobody at work on it.
  const result = await withLock(BACKFILL_LOCK, async () => {
    const before = await index.stats(DRIVE_COLLECTION);
    const dropped = await index.clearVectors(DRIVE_COLLECTION, EMBEDDING_DIM);
    onProgress?.(0, before.chunks);
    let done = 0;
    for (;;) {
      const n = await fillMissingVectors(1280);
      if (n === 0) break;
      done += n;
      onProgress?.(done, before.chunks);
    }
    return dropped;
  });
  if (result === null) return { ok: false, why: 'Vectors are being made right now by another run. Wait until it has finished, then try again.' };
  const dropped = result;
  const after = await index.stats(DRIVE_COLLECTION);
  return { ok: true, model: EMBEDDING_MODEL, dropped, passages: after.chunks, withVectors: after.withVectors };
}
