/**
 * semantic_search_drive — 자연어 질의 → Qdrant vector search → top-K chunks.
 *
 * Pipeline:
 *   1. embed query (OpenAI text-embedding-3-small, 1536d)
 *   2. Qdrant search (Cosine, optional payload filter)
 *   3. rerank: config drive.rank 규칙(경로 접두별 가중치)과 frontmatter status(superseded, parked 강등)
 *   4. 제외 폴더와 직원별 폴더 범위로 거른 뒤 markdown 으로 포맷 (Drive 링크 포함)
 *
 * 예전엔 한 회사의 위키 구조(특정 폴더 이름별 "현황, 결정, 이력" 가중치)와 그 회사 예시가 코드에 박혀 있었다.
 * 이제 가중치는 설정(drive.rank)으로만 주고, 없으면 의미 점수 그대로 정렬한다.
 *
 * Indexing 안 됐으면 `knowledge-mcp drive reindex` 안내.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { getAuth } from '../../../core/context.js';
import { getConfig } from '../../../core/config.js';
import { allowedDriveFolders, isPathInScope } from '../../../core/scope.js';
import { isExcludedPath } from '../exclude.js';
import { embedQuery } from '../embeddings.js';
import { getQdrantClient, DRIVE_COLLECTION, type ChunkPayload } from '../qdrant.js';

const SOURCES = ['dev', 'biz'] as const;
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
  'source="dev" searches structured docs (Markdown), source="biz" searches general documents (PDF, Office, Google files).';

const inputSchema = z.object({
  query: z.string().min(1).max(500).describe('Natural-language question, in any language. e.g. "How do we rotate API keys?"'),
  topK: z.number().int().min(1).max(20).optional().default(5).describe('Number of chunks to return (1-20, default 5)'),
  source: z.enum(SOURCES).optional().describe('Optional: "dev" (structured Markdown docs) or "biz" (general documents)'),
  cluster: z.string().optional().describe('Optional: top-level folder under a Drive root, e.g. "Engineering"'),
  hasImage: z.boolean().optional().describe('Optional: only chunks that contain images (screenshots, diagrams)'),
  docStatus: z.string().optional().describe('Optional: the `status` from Markdown frontmatter, e.g. "draft" or "superseded"'),
  tags: z.string().optional().describe('Optional: one tag. dev = frontmatter `tags`; biz = folder and file-name words'),
  docType: z.string().optional().describe('Optional: the `type` from Markdown frontmatter, e.g. "guide"'),
  category: z.string().optional().describe('Optional (biz): top-level folder name without a leading number, e.g. "Sales"'),
  customer: z.string().optional().describe('Optional (biz): customer name, from folders listed in config drive.customerFolders, e.g. "Acme"'),
});

export const semanticSearchDriveTool = defineTool({
  name: 'semantic_search_drive',
  description: DESCRIPTION,
  input: inputSchema,
  annotations: { readOnlyHint: true },
  run: (args) => handleSemanticSearchDrive(args),
});

export async function handleSemanticSearchDrive(args: z.infer<typeof inputSchema>) {
  // 외부 의존(OpenAI 임베딩·Qdrant) 실패를 도구 특화 graceful 에러로 — 예전엔 [fatal] 로만 떴다.
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
  const searchLimit = folderScope ? 200 : Math.min(50, Math.max(topK * 3, 18));
  const results = await client.search(DRIVE_COLLECTION, {
    vector: queryVector,
    limit: searchLimit,
    with_payload: true,
    filter: must.length > 0 ? { must } : undefined,
  });

  if (results.length === 0) {
    const filters = Object.entries({ source, cluster, docStatus, tags, docType, category, customer })
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}="${v}"`);
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `No results for "${query}".\n\nPossible reasons:\n` +
            `- Drive is not indexed yet: ask an admin to run \`knowledge-mcp drive reindex\`\n` +
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
  const ranked = reranked
    .filter((x) => !isExcludedPath(x.p.file_path ?? ''))
    .filter((x) => !folderScope || isPathInScope(x.p.file_path ?? '', folderScope))
    .slice(0, topK);

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
    const tags = [label, p.doc_date, p.doc_status === 'superseded' ? '⚠️ superseded' : p.doc_status === 'parked' ? 'parked' : null]
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
    lines.push(`**File ID:** \`${p.file_id}\` — pass to read_drive_file for the whole document`);
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
