/**
 * Tokens for the built-in keyword index (SQLite FTS5).
 *
 * FTS5's own tokenizers split on spaces and punctuation, which works for English but not for languages that glue
 * particles onto words or write without spaces: a search for "휴가" would not find "휴가를". So text in Korean,
 * Chinese and Japanese scripts is indexed as overlapping pairs of characters ("휴가를" → "휴가", "가를"), the usual
 * approach for these scripts, and everything else as lowercase words. The same function builds the query, so both
 * sides always agree. No imports: this is plain string work.
 */

// A run of CJK characters, or a run of other letters and digits. The second part excludes CJK so that a mixed word
// such as "API키" splits at the script boundary instead of becoming one token.
const RUNS = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|(?:(?![\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[\p{L}\p{N}_])+/gu;
const CJK = /^[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(RUNS)) {
    const run = m[0];
    if (!CJK.test(run)) {
      out.push(run);
      continue;
    }
    const chars = [...run];
    if (chars.length === 1) out.push(run);
    else for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

/** The text to store for a chunk: tokens joined by spaces (FTS5 then splits on the spaces). */
export function tokenText(text: string): string {
  return tokenize(text).join(' ');
}

// Words that say nothing about the topic. Only used on the query side, and only when other words remain.
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'was', 'be', 'how', 'what', 'why', 'do', 'does', 'i', 'we', 'it']);
const MAX_QUERY_TOKENS = 64;

/** The distinct terms a question is searched by: its tokens, without filler words when anything else is left. */
export function queryTerms(question: string): string[] {
  const all = [...new Set(tokenize(question))];
  const useful = all.filter((t) => !STOPWORDS.has(t));
  return (useful.length ? useful : all).slice(0, MAX_QUERY_TOKENS);
}

/**
 * An FTS5 MATCH expression for a free-text question: any token may match, ranking (BM25) favours chunks that match
 * more of them and rarer ones. Returns null when the question has nothing to search for.
 */
export function ftsQuery(question: string): string | null {
  return matchExpression(queryTerms(question));
}

/** The FTS5 MATCH expression for terms already chosen (see local_vectors.ts keywordTerms): any of them may match. */
export function matchExpression(terms: string[]): string | null {
  if (terms.length === 0) return null;
  // Quoted so that a token is never read as FTS5 syntax (AND, OR, NEAR, a column name, …).
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}
