/**
 * Putting neighbouring chunks of one document back together.
 *
 * The chunker starts every chunk but the first with the end of the one before it ("…" + up to 100 tokens + a blank
 * line), so a passage read alone still has its lead-in. Read one after the other, that lead-in is text the reader
 * has just seen. It is removed here by looking for it where it came from: the longest stretch at the start of a
 * chunk that is also the end of the chunk before it. (Cutting at the first blank line is not enough: the repeated
 * stretch often holds blank lines itself, and everything after the first one was then shown twice.)
 */

/** A chunk's own text, without the lead-in it repeats from `previous`. */
export function withoutLeadIn(previous: string, chunk: string): string {
  if (!chunk.startsWith('…')) return chunk;
  const body = chunk.slice(1);
  // The lead-in ends at a blank line. Try the blank lines from the farthest plausible one back to the first.
  const ends: number[] = [];
  for (let at = body.indexOf('\n\n'); at !== -1 && at <= 4000; at = body.indexOf('\n\n', at + 1)) ends.push(at);
  for (let i = ends.length - 1; i >= 0; i--) {
    if (previous.endsWith(body.slice(0, ends[i]))) return body.slice(ends[i] + 2);
  }
  // Not found as written (the text was cleaned after it was copied): fall back to the first blank line.
  return ends.length ? body.slice(ends[0] + 2) : chunk;
}

/** Consecutive chunks of one document as one text. `chunks` are in document order and next to each other. */
export function joinChunks(chunks: string[]): string {
  return chunks.map((c, i) => (i === 0 ? c : withoutLeadIn(chunks[i - 1], c))).join('\n\n');
}
