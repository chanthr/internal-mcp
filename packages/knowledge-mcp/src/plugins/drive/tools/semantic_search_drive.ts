/**
 * semantic_search_drive: natural-language query → Qdrant vector search → top-K chunks.
 *
 * Pipeline:
 *   1. embed query (OpenAI text-embedding-3-small, 1536d)
 *   2. Qdrant search (Cosine, optional payload filter)
 *   3. rerank: config drive.rank rules (weights per path prefix) and frontmatter status (superseded and parked are demoted)
 *   4. filter by excluded folders and the per-user folder scope, then format as markdown (with Drive links)
 *
 * Formerly one company's wiki structure (weights for "status, decision, history" keyed by specific folder names) and that
 * company's examples were hard-coded here. Now weights come only from config (drive.rank). Without them, results are
 * sorted by the semantic score as is.
 *
 * If nothing is indexed yet, the tool points to `knowledge-mcp drive reindex`.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { getAuth } from '../../../core/context.js';
import { getConfig } from '../../../core/config.js';
import { allowedDriveFolders, isPathInScope } from '../../../core/scope.js';
import { isExcludedPath } from '../exclude.js';
import { embedQuery } from '../embeddings.js';
import { sourceLabels } from '../settings.js';
import { getQdrantClient, DRIVE_COLLECTION, type ChunkPayload } from '../qdrant.js';

const RANK_RULES = getConfig().drive.rank;

/** First rank rule whose prefix the path starts with. */
function rankRule(path: string): { label: string; weight: number } | null {
  const p = path.replace(/^\/+/, '');
  return RANK_RULES.find((r) => p.startsWith(r.prefix.replace(/^\/+/, ''))) ?? null;
}

const DESCRIPTION =
  'Semantic (vector) search over the indexed Drive content. Returns the top-K matching chunks for a natural-language question. ' +
  'Use it for meaning questions ("how does X work", "why did we decide Y", what a document says about a topic); ' +
  'for file names or exact keywords use search_drive. ' +
  'Each result has a score, path, heading, File ID, Drive link and the chunk text. ' +
  'Two-step search: when a chunk lacks context, call read_drive_file with its File ID to read the whole document. ' +
  (sourceLabels().length > 1 ? `Narrow with source: ${sourceLabels().map((l) => `"${l}"`).join(', ')}.` : '');

const inputSchema = z.object({
  query: z.string().min(1).max(500).describe('Natural-language question, in any language. e.g. "How do we rotate API keys?"'),
  topK: z.number().int().min(1).max(20).optional().default(5).describe('Number of chunks to return (1-20, default 5)'),
  source: z.string().optional().describe(`Optional: only documents with this source label${sourceLabels().length ? ` (${sourceLabels().join(', ')})` : ''}`),
  cluster: z.string().optional().describe('Optional: top-level folder under a Drive root, e.g. "Engineering"'),
  hasImage: z.boolean().optional().describe('Optional: only chunks that contain images (screenshots, diagrams)'),
  docStatus: z.string().optional().describe('Optional: the `status` from Markdown frontmatter, e.g. "draft" or "superseded"'),
  tags: z.string().optional().describe('Optional: one tag. From frontmatter `tags`, or for path-metadata sources from folder and file-name words'),
  docType: z.string().optional().describe('Optional: the `type` from Markdown frontmatter, e.g. "guide"'),
  category: z.string().optional().describe('Optional (path-metadata sources): top-level folder name without a leading number, e.g. "Sales"'),
  customer: z.string().optional().describe('Optional (path-metadata sources): customer name, from folders listed in config drive.customerFolders, e.g. "Acme"'),
});

export const semanticSearchDriveTool = defineTool({
  name: 'semantic_search_drive',
  description: DESCRIPTION,
  input: inputSchema,
  annotations: { readOnlyHint: true },
  run: (args) => handleSemanticSearchDrive(args),
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

/** Chunks shown per document (env SEMANTIC_MAX_PER_DOC). */
const MAX_PER_DOC = Math.max(1, Number(process.env.SEMANTIC_MAX_PER_DOC ?? 2));

export async function handleSemanticSearchDrive(args: z.infer<typeof inputSchema>) {
  // Turn failures of external dependencies (OpenAI embeddings, Qdrant) into a tool-specific graceful error. Previously they
  // only showed up as [fatal].
  try {
    return await _handleSemanticSearchDrive(args);
  } catch (e: unknown) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `[error] Semantic search is temporarily unavailable; retry later or use search_drive. (${e instanceof Error ? e.message : String(e)})`,
        },
      ],
      isError: true,
    };
  }
}

async function _handleSemanticSearchDrive(args: z.infer<typeof inputSchema>) {
  const auth = getAuth();
  const { query, topK, source, cluster, hasImage, docStatus, tags, docType, category, customer } = args;

  // 1. Embed query
  const queryVector = await embedQuery(query);

  // 2. Qdrant filter (optional)
  const must: Array<{ key: string; match: { value: string | boolean } }> = [];
  if (source) must.push({ key: 'source', match: { value: source } });
  if (cluster) must.push({ key: 'cluster', match: { value: cluster } });
  if (hasImage !== undefined) must.push({ key: 'has_image', match: { value: hasImage } });
  if (docStatus) must.push({ key: 'doc_status', match: { value: docStatus } });
  if (tags) must.push({ key: 'doc_tags', match: { value: tags } });
  if (docType) must.push({ key: 'doc_type', match: { value: docType } });
  if (category) must.push({ key: 'doc_category', match: { value: category } });
  if (customer) must.push({ key: 'doc_customer', match: { value: customer } });

  // 3. Search wider than topK: reranking may reorder, and results outside the caller's folders are dropped
  //    afterwards. A person limited to a few folders needs a much wider net, or they get 0-2 results even
  //    when relevant documents exist in their folders.
  const folderScope = allowedDriveFolders(auth);
  const client = await getQdrantClient();
  const searchLimit = folderScope ? 200 : Math.min(80, Math.max(topK * 5, 30));
  const results = await client.search(DRIVE_COLLECTION, {
    vector: queryVector,
    limit: searchLimit,
    with_payload: true,
    filter: must.length > 0 ? { must } : undefined,
  });

  if (results.length === 0) {
    // Tell an empty index apart from a query that matched nothing: the advice is different.
    const indexEmpty = (await client.scroll(DRIVE_COLLECTION, { limit: 1, with_payload: false, with_vector: false })).points.length === 0;
    const filters = Object.entries({ source, cluster, docStatus, tags, docType, category, customer })
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}="${v}"`);
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `No results for "${query}".\n\nPossible reasons:\n` +
            (indexEmpty
              ? `- The search index is empty. The server builds it by itself after setup; if it was just started, try again in a few minutes. Meanwhile search_drive (keywords) and read_drive_file work.\n`
              : '') +
            (filters.length ? `- The filters are too narrow (${filters.join(', ')}); try without them\n` : '') +
            `- Weak semantic match: rephrase, or try search_drive for exact words`,
        },
      ],
    };
  }

  // 3b. Rerank: drive.rank rules by path, then demote superseded and parked documents (frontmatter status).
  const reranked = results
    .map((r) => {
      const p = r.payload as unknown as ChunkPayload;
      const rule = rankRule(p.file_path ?? '');
      let boost = rule?.weight ?? 1;
      if (p.doc_status === 'superseded') boost *= 0.8;
      else if (p.doc_status === 'parked') boost *= 0.92;
      return { r, p, label: rule?.label ?? null, adj: r.score * boost };
    })
    .sort((a, b) => b.adj - a.adj);

  // 3c. Re-check excluded folders (chunks indexed before a folder was excluded) and the caller's folder scope.
  const allowed = reranked
    .filter((x) => !isExcludedPath(x.p.file_path ?? ''))
    .filter((x) => !folderScope || isPathInScope(x.p.file_path ?? '', folderScope));

  // 3d. At most MAX_PER_DOC chunks per document. Without this one long document fills every slot with its own
  //     neighbouring chunks and the answer rests on a single source. The rest is one read_drive_file call away.
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

  // 4. Markdown output (readable for people and models)
  const lines: string[] = [];
  lines.push(`# Semantic search — "${query}"`);
  lines.push(`${ranked.length} chunks (from ${results.length} candidates) · top-${topK} requested`);
  if (RANK_RULES.length) {
    lines.push(
      `> Ranked with the configured rules: ${RANK_RULES.map((r) => `\`${r.prefix}\` = [${r.label}] ×${r.weight}`).join(', ')}. ` +
        `When results disagree, prefer the higher-weighted label and the newer date.`,
    );
  }
  lines.push('');

  for (let i = 0; i < ranked.length; i++) {
    const { r, p, label, adj } = ranked[i];
    const driveLink = `https://drive.google.com/file/d/${p.file_id}/view`;
    const tags = [label, dateLabel(p), p.doc_status === 'superseded' ? '⚠️ superseded' : p.doc_status === 'parked' ? 'parked' : null]
      .filter(Boolean)
      .join(' · ');
    lines.push(`---`);
    lines.push(`### ${i + 1}. ${tags ? `[${tags}] ` : ''}${p.file_name}`);
    const chunkPos =
      typeof p.chunk_index === 'number' && typeof p.chunk_count === 'number' && p.chunk_count > 1
        ? ` · **Chunk:** ${p.chunk_index + 1}/${p.chunk_count} (part of the document; use read_drive_file for the full context)`
        : '';
    // The shown score is the sort key. When a rule or status changed it, the raw similarity is shown too.
    lines.push(
      `**Score:** ${adj.toFixed(3)}` +
        (Math.abs(adj - r.score) > 0.001 ? ` (raw ${r.score.toFixed(3)})` : '') +
        ` · **Source:** ${p.source}` +
        (p.cluster ? ` · **Cluster:** ${p.cluster}` : '') +
        chunkPos,
    );
    lines.push(`**Path:** \`${p.file_path}\``);
    if (p.heading) lines.push(`**Heading:** ${p.heading}`);
    lines.push(
      `**File ID:** \`${p.file_id}\` — pass to read_drive_file for the whole document` +
        (more.get(p.file_id) ? ` (${more.get(p.file_id)} more matching chunks in it)` : ''),
    );
    lines.push(`**Drive:** [open](${driveLink})`);
    if (p.image_urls && p.image_urls.length > 0) {
      lines.push(`**Images:** ${p.image_urls.length} — ${p.image_urls.join(' · ')}`);
    }
    lines.push('');
    lines.push(p.content);
    lines.push('');
  }

  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}
