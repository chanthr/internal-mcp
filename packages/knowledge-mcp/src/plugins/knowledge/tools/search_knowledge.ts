/**
 * search_knowledge: a question → the best matching passages from everything that is indexed (Drive documents shared
 * with the service account, local folders).
 *
 * Pipeline:
 *   1. search the index by keywords, and by meaning when an embedding model is configured (hybrid.ts)
 *   2. rerank: config drive.rank rules (weights per path prefix) and frontmatter status (superseded and parked are demoted)
 *   3. drop excluded folders and anything outside the caller's folder scope
 *   4. at most a few passages per document; neighbouring parts of one document are shown as one passage
 *   5. written for a model to read: what it is, where it is from, how well it matched, then the text. Nothing is
 *      said twice, because every line here is paid for in the reader's context.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { getAuth } from '../../../core/context.js';
import { allowedDriveFolders } from '../../../core/scope.js';
import { getGraph } from '../graph.js';
import { graphVisibility, linkCounts } from './linked_documents.js';
import { sourceLabels } from '../../drive/settings.js';
import { driveConfigured } from '../../drive/index.js';
import type { ChunkPayload } from '../../drive/qdrant.js';
import { DRIVE_COLLECTION, getLocalIndex } from '../../drive/qdrant.js';
import { joinChunks } from '../../drive/chunk_join.js';
import { queryTerms, tokenize } from '../../drive/tokens.js';
import { isLocalId, localFolders } from '../folders.js';
import { RANK_RULES, searchIndex, visibleHits, type Must } from '../hybrid.js';

/**
 * Every `source` label a chunk can carry: the local folders, and Drive roots and shared documents when Drive is
 * connected. (Without Drive its labels name nothing, and a model told about them filters by them and finds nothing.)
 */
export function allSources(): string[] {
  return [...new Set([...(driveConfigured() ? sourceLabels() : []), ...localFolders().map((f) => f.source)])];
}

// What a tool says about itself is read at the start of every conversation, whether the tool is used or not: said
// once, briefly. What the answer looks like is left to the answer.
const DESCRIPTION =
  'Search the team knowledge base (local folders and Drive documents). Ask in natural language, in any language; ' +
  'it matches by keywords and, when an embedding model is set up, by meaning. ' +
  'Each result gives the document, its date, an ID and the passage, and says how much of the question the passage holds. ' +
  'To read around a passage call read_document with its ID and part. Check the date before treating a figure as current. ' +
  'A filter that matches nothing answers with the values that field has.';

const inputSchema = z.object({
  query: z.string().min(1).max(500).describe('The question or the words to look for, in any language.'),
  topK: z.number().int().min(1).max(20).optional().default(5).describe('Passages to return (1-20, default 5).'),
  source: z.string().optional().describe(`Only this source${allSources().length ? ` (${allSources().join(', ')})` : ''}.`),
  cluster: z.string().optional().describe('Only this top-level folder.'),
  hasImage: z.boolean().optional().describe('Only passages with images.'),
  docStatus: z.string().optional().describe('Only this frontmatter status, e.g. "draft".'),
  tags: z.string().optional().describe('Only documents with this tag.'),
  docType: z.string().optional().describe('Only this frontmatter type, e.g. "guide".'),
  category: z.string().optional().describe('Only this category (top-level folder name).'),
  customer: z.string().optional().describe('Only this customer (from the folders in config drive.customerFolders).'),
});

/**
 * The date shown with a result: the date written in the document (frontmatter), otherwise when the file was last
 * modified, with its age once it is over a month old. A figure from an old document reads as current unless the
 * model is told how old the document is.
 */
export function dateLabel(p: Pick<ChunkPayload, 'doc_date' | 'modified_time'>, now = Date.now()): string | null {
  const fromDoc = /^\d{4}-\d{2}-\d{2}/.test(p.doc_date ?? '');
  const raw = fromDoc ? p.doc_date! : (p.modified_time ?? '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  const date = raw.slice(0, 10);
  const days = Math.floor((now - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  const age = days >= 365 ? `${Math.floor(days / 365)}y old` : days >= 30 ? `${Math.floor(days / 30)}mo old` : '';
  return `${fromDoc ? '' : 'modified '}${date}${age ? `, ${age}` : ''}`;
}

/** Parts of one document that are next to each other are shown as one passage, up to this many. */
const MAX_JOINED = 2;

/** The metadata field behind each filter argument. */
const FILTER_FIELDS: Record<string, string> = { source: 'source', cluster: 'cluster', docStatus: 'doc_status', tags: 'doc_tags', docType: 'doc_type', category: 'doc_category', customer: 'doc_customer' };

/** Passages shown per document (env KNOWLEDGE_MAX_PER_DOC). */
const MAX_PER_DOC = Math.max(1, Number(process.env.KNOWLEDGE_MAX_PER_DOC ?? process.env.SEMANTIC_MAX_PER_DOC ?? 2));

export async function handleSearchKnowledge(args: z.infer<typeof inputSchema>) {
  try {
    return await search(args);
  } catch (e: unknown) {
    // A failing store or embedding endpoint becomes a message the model can act on, not a crash.
    return {
      content: [{ type: 'text' as const, text: `[error] The knowledge index is temporarily unavailable; retry later. (${e instanceof Error ? e.message : String(e)})` }],
      isError: true,
    };
  }
}

async function search(args: z.infer<typeof inputSchema>) {
  const auth = getAuth();
  const { query, topK, source, cluster, hasImage, docStatus, tags, docType, category, customer } = args;

  const must: Must = [];
  if (source) must.push({ key: 'source', match: { value: source } });
  if (cluster) must.push({ key: 'cluster', match: { value: cluster } });
  if (hasImage !== undefined) must.push({ key: 'has_image', match: { value: hasImage } });
  if (docStatus) must.push({ key: 'doc_status', match: { value: docStatus } });
  if (tags) must.push({ key: 'doc_tags', match: { value: tags } });
  if (docType) must.push({ key: 'doc_type', match: { value: docType } });
  if (category) must.push({ key: 'doc_category', match: { value: category } });
  if (customer) must.push({ key: 'doc_customer', match: { value: customer } });

  // Fetch more than topK: reranking may reorder, several passages of one document collapse into a few, and results
  // outside the caller's folders are dropped afterwards. A person limited to a few folders needs a much wider net,
  // or they get 0-2 results even when relevant documents exist in their folders.
  const folderScope = allowedDriveFolders(auth);
  const candidates = folderScope ? 200 : Math.min(80, Math.max(topK * 5, 30));
  const found = await searchIndex(query, must, candidates);

  // The same answer whether nothing matched or every match was outside what the caller may see: a person must not
  // learn from the wording that hidden documents contain their words.
  const noResults = async () => {
    const used = Object.entries({ source, cluster, docStatus, tags, docType, category, customer }).filter(([, v]) => v) as Array<[string, string]>;
    const filters = used.map(([k, v]) => `${k}="${v}"`);
    // A filter value is a guess until the caller has seen one. Say what each field holds, so the next call can be
    // right. Only for a caller who may see everything: the values of documents outside someone's folders are not
    // theirs to learn.
    const local = folderScope ? null : await getLocalIndex();
    const holds: string[] = [];
    if (local && !found.empty) {
      for (const [k] of used) {
        const values = await local.fieldValues(DRIVE_COLLECTION, FILTER_FIELDS[k]);
        holds.push(values.length ? `${k} is one of: ${values.map((v) => `"${v.value}"`).join(', ')}` : `no document has a ${k}`);
      }
    }
    const reasons = found.empty
      ? ['The index is empty. The server builds it by itself after setup; if it was just started, try again in a few minutes.']
      : [
          ...(filters.length ? [`The filters are too narrow (${filters.join(', ')}); try without them${holds.length ? `. In this index ${holds.join('; ')}` : ''}`] : []),
          found.mode === 'keyword'
            ? 'No document contains these words. Rephrase with the words the documents would use (this index searches by keywords)'
            : 'No good match. Rephrase the question, or use more specific words',
        ];
    return { content: [{ type: 'text' as const, text: `No results for "${query}".\n\n${reasons.map((r) => `- ${r}`).join('\n')}` }] };
  };
  if (found.hits.length === 0) return await noResults();

  // Rank rules and document status, then excluded folders and the caller's folder scope (hybrid.ts).
  const allowed = visibleHits(found.hits, folderScope);

  if (allowed.length === 0) return await noResults();

  // At most MAX_PER_DOC parts per document. Without this one long document fills every slot with its own
  // neighbouring parts and the answer rests on a single source. The rest is one read_document call away.
  type Hit = (typeof allowed)[number];
  const perDoc = new Map<string, number>();
  const more = new Map<string, number>();
  const chosen: Hit[] = [];
  for (const x of allowed) {
    const id = x.p.file_id;
    const n = perDoc.get(id) ?? 0;
    if (n >= MAX_PER_DOC || chosen.length >= topK) {
      if (perDoc.has(id)) more.set(id, (more.get(id) ?? 0) + 1);
      continue;
    }
    perDoc.set(id, n + 1);
    chosen.push(x);
  }

  // What is shown is exactly what was chosen. Two chosen parts that are neighbours in their document are shown as
  // one passage, at the place of the better one: apart, each repeats the edge of the other.
  interface Passage {
    parts: Hit[];
  }
  const part = (x: Hit) => (typeof x.p.chunk_index === 'number' ? x.p.chunk_index : null);
  const passages: Passage[] = [];
  for (const x of chosen) {
    const at = part(x);
    const beside = at === null ? undefined : passages.find((ps) => ps.parts.length < MAX_JOINED && ps.parts[0].p.file_id === x.p.file_id && ps.parts.some((q) => Math.abs((part(q) ?? -9) - at) === 1));
    if (beside) beside.parts.push(x);
    else passages.push({ parts: [x] });
  }

  // How much of the question a passage holds, in the terms the index searches by. A keyword search always returns
  // its best matches, however poor: this is how the reader tells a real match from a stray shared word.
  const terms = queryTerms(query);
  const holds = (xs: Hit[]) => {
    const text = new Set(tokenize(xs.map((x) => `${x.p.heading ?? ''} ${x.p.content}`).join(' ')));
    return terms.filter((t) => text.has(t)).length;
  };
  const held = passages.map((ps) => holds(ps.parts));
  const weak = found.mode === 'keyword' && terms.length >= 2 && Math.max(...held) * 2 < terms.length;

  // How each shown document is connected to others the caller may see (the links people wrote: ../graph.ts).
  const graph = getGraph();
  const mayLink = graphVisibility();
  const linked = passages.map((ps) => linkCounts(graph, ps.parts[0].p.file_id, mayLink));

  const severalSources = allSources().length > 1;
  const lines: string[] = [];
  lines.push(`# Knowledge search — "${query}"`);
  lines.push(
    `${passages.length} passage${passages.length === 1 ? '' : 's'} from ${perDoc.size} document${perDoc.size === 1 ? '' : 's'} · matched by ${found.mode}. ` +
      'To read around a passage: read_document with its ID and part.' +
      (linked.some(Boolean) ? ' To follow a document\'s links: linked_documents with its ID.' : ''),
  );
  if (weak) lines.push('> Weak match: no passage holds even half of the terms of the question. The documents may not cover it; say so rather than answer from these.');
  if (found.degraded) {
    // Not cut short: when the cause is a changed embedding model, the message ends with the command that fixes it.
    lines.push(`> Search by meaning is unavailable right now: ${found.degraded.slice(0, 400)}. These results are keyword matches only.`);
  }
  if (RANK_RULES.length) {
    lines.push(
      `> Ranked with the configured rules: ${RANK_RULES.map((r) => `\`${r.prefix}\` = [${r.label}] ×${r.weight}`).join(', ')}. ` +
        `When results disagree, prefer the higher-weighted label and the newer date.`,
    );
  }

  passages.forEach((ps, i) => {
    const parts = [...ps.parts].sort((x, y) => (part(x) ?? 0) - (part(y) ?? 0));
    const { p, label } = ps.parts[0]; // the best-ranked part speaks for the passage
    const about = [dateLabel(p), p.doc_status === 'superseded' ? 'superseded' : p.doc_status === 'parked' ? 'parked' : null, label ? `[${label}]` : null].filter(Boolean).join(' · ');
    lines.push('');
    lines.push(`## ${i + 1}. ${p.file_name}${about ? ` — ${about}` : ''}`);
    const first = part(parts[0]);
    const last = part(parts[parts.length - 1]);
    const where =
      first !== null && typeof p.chunk_count === 'number' && p.chunk_count > 1
        ? ` · part${first === last ? ` ${first + 1}` : `s ${first + 1}-${(last ?? first) + 1}`} of ${p.chunk_count}`
        : '';
    const rest = more.get(p.file_id);
    lines.push(`ID: \`${p.file_id}\`${where}${rest ? ` · ${rest} more matching part${rest === 1 ? '' : 's'}` : ''}`);
    // A local document's ID is its path. A Drive document's ID says nothing, so its path and link are given.
    if (!isLocalId(p.file_id)) lines.push(`Path: \`${p.file_path}\` · [open in Drive](https://drive.google.com/file/d/${p.file_id}/view)`);
    if (p.heading) lines.push(`Heading: ${p.heading}`);
    const matched = [...new Set(ps.parts.flatMap((x) => x.h.matched))];
    const byWords = matched.includes('keyword') && terms.length > 1 ? ` (${held[i]} of ${terms.length} terms of the question)` : '';
    lines.push(`Match: ${matched.join(' + ')}${byWords}${severalSources ? ` · source: ${p.source}` : ''}`);
    const l = linked[i];
    if (l) lines.push(`Links: to ${l.out} · from ${l.in}`);
    const images = [...new Set(parts.flatMap((x) => x.p.image_urls ?? []))];
    if (images.length) lines.push(`Images: ${images.join(' · ')}`);
    lines.push('');
    const consecutive = parts.every((x, k) => k === 0 || part(x) === (part(parts[k - 1]) ?? -9) + 1);
    lines.push(consecutive ? joinChunks(parts.map((x) => x.p.content)) : parts.map((x) => x.p.content).join('\n\n'));
  });

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

export const searchKnowledgeTool = defineTool({
  name: 'search_knowledge',
  description: DESCRIPTION,
  input: inputSchema,
  annotations: { readOnlyHint: true },
  run: (args) => handleSearchKnowledge(args),
});
