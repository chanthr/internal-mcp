/**
 * search_knowledge: a question → the best matching passages from everything that is indexed (Drive documents shared
 * with the service account, local folders).
 *
 * Pipeline:
 *   1. search the index by keywords, and by meaning when an embedding model is configured (hybrid.ts)
 *   2. rerank: config drive.rank rules (weights per path prefix) and frontmatter status (superseded and parked are demoted)
 *   3. drop excluded folders and anything outside the caller's folder scope
 *   4. at most a few passages per document, formatted as Markdown with the document's date
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { getAuth } from '../../../core/context.js';
import { getConfig } from '../../../core/config.js';
import { allowedDriveFolders, isPathInScope } from '../../../core/scope.js';
import { isExcludedPath } from '../../drive/exclude.js';
import { sourceLabels } from '../../drive/settings.js';
import type { ChunkPayload } from '../../drive/qdrant.js';
import { isLocalId, localFolders } from '../folders.js';
import { searchIndex, type Must } from '../hybrid.js';

const RANK_RULES = getConfig().drive.rank;

/** First rank rule whose prefix the path starts with. */
function rankRule(path: string): { label: string; weight: number } | null {
  const p = path.replace(/^\/+/, '');
  return RANK_RULES.find((r) => p.startsWith(r.prefix.replace(/^\/+/, ''))) ?? null;
}

/** Every `source` label a chunk can carry: Drive roots and shared documents, plus the local folders. */
function allSources(): string[] {
  return [...new Set([...sourceLabels(), ...localFolders().map((f) => f.source)])];
}

const DESCRIPTION =
  'Search the team knowledge base: the indexed documents (Drive documents and local folders). ' +
  'Ask in natural language, in any language; it matches by keywords and, when an embedding model is set up, by meaning. ' +
  'Use it for any question about what the documents say ("how does X work", "why did we decide Y", "what is our policy on Z"). ' +
  'Each result has the document date, path, heading, a Document ID and the passage text. ' +
  'When a passage lacks context, call read_document with its Document ID to read the whole document. ' +
  'Results are passages from documents written at some point in time: check the date before treating a figure as current.' +
  (allSources().length > 1 ? ` Narrow with source: ${allSources().map((l) => `"${l}"`).join(', ')}.` : '');

const inputSchema = z.object({
  query: z.string().min(1).max(500).describe('The question or the words to look for, in any language. e.g. "How do we rotate API keys?"'),
  topK: z.number().int().min(1).max(20).optional().default(5).describe('Number of passages to return (1-20, default 5)'),
  source: z.string().optional().describe(`Optional: only documents with this source label${allSources().length ? ` (${allSources().join(', ')})` : ''}`),
  cluster: z.string().optional().describe('Optional: top-level folder, e.g. "Engineering"'),
  hasImage: z.boolean().optional().describe('Optional: only passages that contain images (screenshots, diagrams)'),
  docStatus: z.string().optional().describe('Optional: the `status` from Markdown frontmatter, e.g. "draft" or "superseded"'),
  tags: z.string().optional().describe('Optional: one tag. From frontmatter `tags`, or for path-metadata sources from folder and file-name words'),
  docType: z.string().optional().describe('Optional: the `type` from Markdown frontmatter, e.g. "guide"'),
  category: z.string().optional().describe('Optional (path-metadata sources): top-level folder name without a leading number, e.g. "Sales"'),
  customer: z.string().optional().describe('Optional (path-metadata sources): customer name, from folders listed in config drive.customerFolders, e.g. "Acme"'),
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
  const noResults = () => {
    const filters = Object.entries({ source, cluster, docStatus, tags, docType, category, customer })
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}="${v}"`);
    const reasons = found.empty
      ? ['The index is empty. The server builds it by itself after setup; if it was just started, try again in a few minutes.']
      : [
          ...(filters.length ? [`The filters are too narrow (${filters.join(', ')}); try without them`] : []),
          found.mode === 'keyword'
            ? 'No document contains these words. Rephrase with the words the documents would use (this index searches by keywords)'
            : 'No good match. Rephrase the question, or use more specific words',
        ];
    return { content: [{ type: 'text' as const, text: `No results for "${query}".\n\n${reasons.map((r) => `- ${r}`).join('\n')}` }] };
  };
  if (found.hits.length === 0) return noResults();

  // Rerank: drive.rank rules by path, then demote superseded and parked documents (frontmatter status).
  const reranked = found.hits
    .map((h) => {
      const p = h.payload;
      const rule = rankRule(p.file_path ?? '');
      let boost = rule?.weight ?? 1;
      if (p.doc_status === 'superseded') boost *= 0.8;
      else if (p.doc_status === 'parked') boost *= 0.92;
      return { h, p, label: rule?.label ?? null, adj: h.score * boost };
    })
    .sort((a, b) => b.adj - a.adj);

  // Re-check excluded folders (chunks indexed before a folder was excluded) and the caller's folder scope.
  const allowed = reranked
    .filter((x) => !isExcludedPath(x.p.file_path ?? ''))
    .filter((x) => !folderScope || isPathInScope(x.p.file_path ?? '', folderScope));

  if (allowed.length === 0) return noResults();

  // At most MAX_PER_DOC passages per document. Without this one long document fills every slot with its own
  // neighbouring passages and the answer rests on a single source. The rest is one read_document call away.
  const perDoc = new Map<string, number>();
  const more = new Map<string, number>();
  const ranked: typeof allowed = [];
  for (const x of allowed) {
    const id = x.p.file_id;
    const n = perDoc.get(id) ?? 0;
    if (n >= MAX_PER_DOC || ranked.length >= topK) {
      if (perDoc.has(id)) more.set(id, (more.get(id) ?? 0) + 1);
      continue;
    }
    perDoc.set(id, n + 1);
    ranked.push(x);
  }

  const lines: string[] = [];
  lines.push(`# Knowledge search — "${query}"`);
  lines.push(`${ranked.length} passages from ${perDoc.size} document${perDoc.size === 1 ? '' : 's'} · matched by ${found.mode}`);
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
  lines.push('');

  for (let i = 0; i < ranked.length; i++) {
    const { h, p, label, adj } = ranked[i];
    const tagsLine = [label, dateLabel(p), p.doc_status === 'superseded' ? 'superseded' : p.doc_status === 'parked' ? 'parked' : null]
      .filter(Boolean)
      .join(' · ');
    lines.push(`---`);
    lines.push(`### ${i + 1}. ${tagsLine ? `[${tagsLine}] ` : ''}${p.file_name}`);
    const part =
      typeof p.chunk_index === 'number' && typeof p.chunk_count === 'number' && p.chunk_count > 1
        ? ` · **Part:** ${p.chunk_index + 1}/${p.chunk_count} (use read_document for the full context)`
        : '';
    lines.push(`**Score:** ${adj.toFixed(2)} (${h.matched.join(' + ')}) · **Source:** ${p.source}${part}`);
    lines.push(`**Path:** \`${p.file_path}\``);
    if (p.heading) lines.push(`**Heading:** ${p.heading}`);
    lines.push(
      `**Document ID:** \`${p.file_id}\` — pass to read_document for the whole document` +
        (more.get(p.file_id) ? ` (${more.get(p.file_id)} more matching passages in it)` : ''),
    );
    if (!isLocalId(p.file_id)) lines.push(`**Drive:** [open](https://drive.google.com/file/d/${p.file_id}/view)`);
    if (p.image_urls && p.image_urls.length > 0) {
      lines.push(`**Images:** ${p.image_urls.length} — ${p.image_urls.join(' · ')}`);
    }
    lines.push('');
    lines.push(p.content);
    lines.push('');
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}

export const searchKnowledgeTool = defineTool({
  name: 'search_knowledge',
  description: DESCRIPTION,
  input: inputSchema,
  annotations: { readOnlyHint: true },
  run: (args) => handleSearchKnowledge(args),
});
