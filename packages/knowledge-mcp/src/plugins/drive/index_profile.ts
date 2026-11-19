/**
 * How documents are cut into passages, and what an embedding model is given to read.
 *
 * There is no one right way. Small passages match a precise question and lose the surroundings; large ones keep
 * the surroundings and blur the match. A document with headings is best cut at them; a transcript has none. An
 * embedding model trained with a prefix ("query: …") finds less without it. So these are settings, with the
 * defaults that were measured best on a mixed set of Markdown documents, and a way to measure them on one's own
 * documents (plugins/knowledge/eval.ts).
 *
 * Settings: `knowledge.index` in mcp.config.json, or these environment variables (which win):
 *   KNOWLEDGE_CHUNK_CUT       sections | windows
 *   KNOWLEDGE_CHUNK_TOKENS    the most tokens in a passage
 *   KNOWLEDGE_CHUNK_OVERLAP   tokens repeated from the passage before
 *   KNOWLEDGE_EMBED_HEADER    heading | document | none
 *   EMBEDDING_QUERY_PREFIX, EMBEDDING_PASSAGE_PREFIX
 *
 * Passages made one way and passages made another do not belong in one index, so the index remembers how its
 * were made. How a document was cut is kept with its passages (`cutMark`): after the setting changes, a document
 * cut the earlier way is read and cut again. What the vectors were made from is kept with the index
 * (`passageMark`): until new vectors are made, new passages are embedded the way the stored ones were, and
 * questions are asked that way too (qdrant.ts vectorForm).
 */
import { getConfig } from '../../core/config.js';

export interface IndexProfile {
  /** sections: cut at headings, then by paragraph. windows: by paragraph only, as if the document had no headings. */
  cut: 'sections' | 'windows';
  /** The most tokens in one passage. */
  maxTokens: number;
  /** A passage shorter than this joins the one before it. */
  minTokens: number;
  /** Tokens of the passage before, repeated at the start of a passage. */
  overlapTokens: number;
  /**
   * What is put before a passage in what the embedding model reads (the passage as stored and shown is not
   * changed): its heading path, the document's name and its heading path, or nothing.
   */
  header: 'heading' | 'document' | 'none';
  /** Put before a question, and before a passage, for an embedding model that was trained with such a prefix. */
  queryPrefix: string;
  passagePrefix: string;
  /** Where the prefixes come from: set by the person, known for the model, or there are none. */
  prefixFrom: 'settings' | 'model' | null;
}

/**
 * Prefixes embedding models are trained with, by the family the model name belongs to. Each is from the model's
 * own card. A model that expects one finds less without it: measured here with qwen3-embedding on 84 questions,
 * the right document was first for 48 with the prefix and for 43 without.
 *
 *   qwen3-embedding   "Instruct: {task}\nQuery:{query}" on questions, nothing on passages
 *   e5 (not -instruct) "query: " and "passage: "
 *   nomic-embed-text  "search_query: " and "search_document: "
 *   embeddinggemma    "task: search result | query: " and "title: none | text: "
 *   mxbai-embed-large, bge-*-en "Represent this sentence for searching relevant passages: " on questions
 *
 * bge-m3 and OpenAI's models take none. A model not listed gets none unless a prefix is set by hand.
 *
 * With Qdrant as the store nothing remembers what its vectors were made from, so there a prefix that goes before
 * passages is not added by itself: set both by hand, and build the collection again.
 */
const KNOWN_PREFIXES: Array<{ model: RegExp; query: string; passage: string }> = [
  { model: /qwen3-embedding/i, query: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:', passage: '' },
  { model: /(^|[/:_-])(multilingual-)?e5-(small|base|large)(-v2)?(?!.*instruct)/i, query: 'query: ', passage: 'passage: ' },
  { model: /nomic-embed-text/i, query: 'search_query: ', passage: 'search_document: ' },
  { model: /embeddinggemma/i, query: 'task: search result | query: ', passage: 'title: none | text: ' },
  { model: /mxbai-embed-large|bge-(small|base|large)-en/i, query: 'Represent this sentence for searching relevant passages: ', passage: '' },
];
/** The prefixes the configured embedding model was trained with, or none. */
export function knownPrefixes(model: string | undefined = process.env.EMBEDDING_MODEL): { query: string; passage: string } | null {
  const name = model?.trim();
  if (!name) return null;
  const found = KNOWN_PREFIXES.find((k) => k.model.test(name));
  return found ? { query: found.query, passage: found.passage } : null;
}

export const DEFAULT_PROFILE: IndexProfile = { cut: 'sections', maxTokens: 800, minTokens: 50, overlapTokens: 100, header: 'heading', queryPrefix: '', passagePrefix: '', prefixFrom: null };

const int = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | undefined => (typeof v === 'string' && (values as readonly string[]).includes(v.trim()) ? (v.trim() as T) : undefined);
/** A prefix as written in a file: "\n" in it means a line break. */
const prefix = (v: unknown): string | undefined => (typeof v === 'string' ? v.replace(/\\n/g, '\n') : undefined);

/** The profile in force: the environment, then the config, then the defaults. Out-of-range values are passed over. */
export function indexProfile(env: NodeJS.ProcessEnv = process.env): IndexProfile {
  const c = ((getConfig() as { knowledge?: { index?: Partial<Record<keyof IndexProfile, unknown>> } }).knowledge?.index ?? {}) as Partial<Record<keyof IndexProfile, unknown>>;
  const maxTokens = int(env.KNOWLEDGE_CHUNK_TOKENS, 100, 4000) ?? int(c.maxTokens, 100, 4000) ?? DEFAULT_PROFILE.maxTokens;
  // An overlap of half a passage or more would say everything twice.
  const overlap = int(env.KNOWLEDGE_CHUNK_OVERLAP, 0, 1000) ?? int(c.overlapTokens, 0, 1000) ?? Math.min(DEFAULT_PROFILE.overlapTokens, Math.floor(maxTokens / 8));
  return {
    cut: oneOf(env.KNOWLEDGE_CHUNK_CUT, ['sections', 'windows'] as const) ?? oneOf(c.cut, ['sections', 'windows'] as const) ?? DEFAULT_PROFILE.cut,
    maxTokens,
    minTokens: Math.min(int(c.minTokens, 0, 500) ?? DEFAULT_PROFILE.minTokens, Math.floor(maxTokens / 4)),
    overlapTokens: Math.min(overlap, Math.floor(maxTokens / 2) - 1),
    header: oneOf(env.KNOWLEDGE_EMBED_HEADER, ['heading', 'document', 'none'] as const) ?? oneOf(c.header, ['heading', 'document', 'none'] as const) ?? DEFAULT_PROFILE.header,
    ...prefixes(env, c),
  };
}

/** A prefix set by hand (either of the two) is taken as it is. Otherwise the model's own, when it is known. */
function prefixes(env: NodeJS.ProcessEnv, c: Partial<Record<keyof IndexProfile, unknown>>): Pick<IndexProfile, 'queryPrefix' | 'passagePrefix' | 'prefixFrom'> {
  const query = prefix(env.EMBEDDING_QUERY_PREFIX) ?? prefix(c.queryPrefix);
  const passage = prefix(env.EMBEDDING_PASSAGE_PREFIX) ?? prefix(c.passagePrefix);
  if (query !== undefined || passage !== undefined) return { queryPrefix: query ?? '', passagePrefix: passage ?? '', prefixFrom: 'settings' };
  const known = knownPrefixes(env.EMBEDDING_MODEL);
  if (!known || (known.passage && env.QDRANT_URL?.trim())) return { queryPrefix: '', passagePrefix: '', prefixFrom: null };
  return { queryPrefix: known.query, passagePrefix: known.passage, prefixFrom: 'model' };
}

/** The part that decides which passages exist. Kept with every passage: a document cut another way is read again. */
export function cutMark(p: IndexProfile = indexProfile()): string {
  return `${p.cut}:${p.maxTokens}:${p.minTokens}:${p.overlapTokens}`;
}
/**
 * The part that decides what a passage's vector was made from. Kept with the index: other vectors are made again.
 * The prefix on questions is not part of it: it changes what a question looks like, not what is stored.
 */
export function passageMark(p: Pick<IndexProfile, 'header' | 'passagePrefix'> = indexProfile()): string {
  return `${p.header}|${p.passagePrefix}`;
}
/** How everything was made before these marks were kept: the defaults, and no prefix. */
export const LEGACY_CUT = 'sections:800:50:100';
export const LEGACY_PASSAGE = 'heading|';
