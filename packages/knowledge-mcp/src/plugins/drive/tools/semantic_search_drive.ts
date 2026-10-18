/**
 * semantic_search_drive — 자연어 질의 → Qdrant vector search → top-K chunks.
 *
 * Pipeline:
 *   1. embed query (OpenAI text-embedding-3-small, 1536d)
 *   2. Qdrant search (Cosine, optional payload filter)
 *   3. payload 를 markdown 으로 포맷 (citation drive link 포함)
 *
 * Latency target (P95):
 *   - embed: 200~400ms (OpenAI API)
 *   - search: 10~30ms (Qdrant HNSW)
 *   - total: 300~500ms
 *
 * Indexing 안 됐으면 `knowledge-mcp drive reindex` 안내.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { getAuth } from '../../../core/context.js';
import { allowedDriveFolders, isPathInScope } from '../../../core/scope.js';
import { isExcludedPath } from '../exclude.js';
import { embedQuery } from '../embeddings.js';
import { getQdrantClient, DRIVE_COLLECTION, type ChunkPayload } from '../qdrant.js';

const FILE_TYPES = ['dev_log', 'decision', 'rule', 'template', 'biz', 'other'] as const;
const SOURCES = ['dev', 'biz'] as const;
const DOC_STATUS = ['living', 'implemented', 'accepted', 'exploring', 'designed', 'parked', 'superseded'] as const;
const DOC_TIER = ['S', 'M', 'L'] as const; // 레거시(폐기) — dev-logs 호환용
const DOC_TYPES = ['현황', '결정', '이력', 'bug'] as const;

// ── 현황/이력 분류 (file_path 기반 — file_type 은 개발문서도 'other' 라 부정확) ──
// 잘못된 정보 차단 핵심: '현황(개발문서)' 을 '이력(dev-logs)' 보다 우선해
// 과거 수치·상태가 현재 사실로 오인되는 것을 막는다.
type DocKind = 'current' | 'decision' | 'rule' | 'biz' | 'log' | 'other';
const KIND_META: Record<DocKind, { label: string; boost: number }> = {
  current: { label: '현황', boost: 1.1 }, // 개발문서/ — 현재 사실의 1차 근거
  decision: { label: '결정', boost: 1.05 }, // decisions/ — 최신이 현재 정책
  rule: { label: '룰', boost: 1.03 },
  biz: { label: '경영', boost: 1.0 },
  other: { label: '기타', boost: 1.0 },
  log: { label: '이력', boost: 0.97 }, // dev-logs/ — 과거 시점 (현재와 다를 수 있음)
};
function classifyKind(p: ChunkPayload): DocKind {
  const path = p.file_path ?? '';
  if (path.startsWith('개발문서/')) return 'current';
  if (path.startsWith('decisions/')) return 'decision';
  if (path.startsWith('dev-logs/')) return 'log';
  if (p.source === 'biz') return 'biz';
  if (path.includes('_rules') || path.includes('룰베이스')) return 'rule';
  return 'other';
}

const DESCRIPTION =
  'Semantic (vector RAG) search over your indexed Drive content. ' +
  '자연어 질의로 관련 청크 top-K 반환. ' +
  'source 로 범위 한정: source="dev"(개발 기록) / source="biz"(경영·고객사). **비개발(고객사·경영·전략 등) 질문이면 source="biz" 로 좁혀라.** ' +
  '키워드/파일명 검색 (search_drive) 으로 답이 안 나올 때, 또는 "X 가 어떻게 동작하는지", "Y 결정의 배경", 특정 고객사·전략 내용 같은 의미 질의 시 사용. ' +
  '결과에 score · file_path · heading · File ID · Drive link · 본문 청크 포함. ' +
  '**2단계 검색**: 청크만으로 맥락이 부족하면 응답의 File ID 로 read_drive_file 을 호출해 원문 전체를 읽어라.';

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe('자연어 검색 쿼리 (한국어/영어). 예: "JSON-LD planner 가 schema type 어떻게 분류하지?"'),
  topK: z.number().int().min(1).max(20).optional().default(5).describe('반환할 청크 수 (1~20, default 5)'),
  fileType: z.enum(FILE_TYPES).optional().describe('파일 종류 filter (선택): dev_log / decision / rule / template / biz / other'),
  source: z.enum(SOURCES).optional().describe('Source filter (optional): dev (structured docs) / biz (general documents)'),
  cluster: z.string().optional().describe('테마 cluster filter (선택). dev: "03-jsonld-pipeline" 등 / biz: "01_고객사" 등'),
  hasImage: z.boolean().optional().describe('이미지 포함 청크만 (선택). 화면 캡처·다이어그램 있는 문서 찾을 때.'),
  docStatus: z
    .enum(DOC_STATUS)
    .optional()
    .describe('문서 상태 filter (선택): living / implemented / accepted / exploring / parked / superseded'),
  docTier: z.enum(DOC_TIER).optional().describe('(레거시) 문서 tier filter: S / M / L — 폐기됨, dev-logs 호환용'),
  tags: z
    .string()
    .optional()
    .describe('태그 filter (선택). dev=frontmatter tags(예 "geo-audit","supabase") / biz=경로·파일명 파생 태그'),
  docType: z.enum(DOC_TYPES).optional().describe('문서 모드 filter (선택): 현황 / 결정 / 이력 / bug'),
  category: z.string().optional().describe('biz 경영문서 분류 filter (선택). 예: "고객사", "IR_피칭덱", "세일즈"'),
  customer: z.string().optional().describe('biz 고객사 filter (선택). 예: "Acme", "Globex"'),
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
  // 입력은 registry 가 이미 검증했다.
  try {
    return await _handleSemanticSearchDrive(args);
  } catch (e: unknown) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `[error] 의미 검색 백엔드 일시 오류 — 잠시 후 재시도하거나 search_drive 로 대체하세요. (${e instanceof Error ? e.message : String(e)})`,
        },
      ],
      isError: true,
    };
  }
}

async function _handleSemanticSearchDrive(args: z.infer<typeof inputSchema>) {
  const auth = getAuth();
  const { query, topK, fileType, source, cluster, hasImage, docStatus, docTier, tags, docType, category, customer } = args;

  // 1. Embed query (RETRIEVAL_QUERY taskType — asymmetric retrieval)
  const queryVector = await embedQuery(query);

  // 2. Qdrant filter (optional)
  const must: Array<{ key: string; match: { value: string | boolean } }> = [];
  if (fileType) must.push({ key: 'file_type', match: { value: fileType } });
  if (source) must.push({ key: 'source', match: { value: source } });
  if (cluster) must.push({ key: 'cluster', match: { value: cluster } });
  if (hasImage !== undefined) must.push({ key: 'has_image', match: { value: hasImage } });
  if (docStatus) must.push({ key: 'doc_status', match: { value: docStatus } });
  if (docTier) must.push({ key: 'doc_tier', match: { value: docTier } });
  if (tags) must.push({ key: 'doc_tags', match: { value: tags } });
  if (docType) must.push({ key: 'doc_type', match: { value: docType } });
  if (category) must.push({ key: 'doc_category', match: { value: category } });
  if (customer) must.push({ key: 'doc_customer', match: { value: customer } });

  // 3. Search — 현황 우선 rerank 여지 위해 topK 보다 넓게 검색 (현황이 topK 밖으로 밀리는 것 방지)
  const client = await getQdrantClient();
  const searchLimit = Math.min(50, Math.max(topK * 3, 18));
  const results = await client.search(DRIVE_COLLECTION, {
    vector: queryVector,
    limit: searchLimit,
    with_payload: true,
    filter: must.length > 0 ? { must } : undefined,
  });

  if (results.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `검색 결과 없음. query="${query}"\n\n` +
            `가능한 원인:\n` +
            `- Drive 가 아직 indexing 안 됨 → 관리자에게 \`knowledge-mcp drive reindex\` 실행 요청\n` +
            `- filter 가 너무 좁힘 (source="${source ?? '없음'}", fileType="${fileType ?? '없음'}", cluster="${cluster ?? '없음'}")` +
            (fileType && source &&
            ((source === 'dev' && fileType === 'biz') ||
              (source === 'biz' && fileType !== 'biz' && fileType !== 'other'))
              ? ` ⚠️ **source 와 fileType 이 모순** — biz fileType 은 source=biz 에만, dev_log/decision/rule/template 은 source=dev 에만 존재. 둘 중 하나만 쓰세요.`
              : '') +
            `\n` +
            `- 의미 매칭이 약함 → 다른 단어로 재시도`,
        },
      ],
    };
  }

  // 3b. 현황 우선 rerank — kind boost + superseded/parked 강등
  const reranked = results
    .map((r) => {
      const p = r.payload as unknown as ChunkPayload;
      const kind = classifyKind(p);
      let boost = KIND_META[kind].boost;
      if (p.doc_status === 'superseded') boost *= 0.8; // 대체된 문서 강등
      else if (p.doc_status === 'parked') boost *= 0.92;
      return { r, p, kind, adj: r.score * boost };
    })
    .sort((a, b) => b.adj - a.adj);

  // 3c. 제외 폴더 재확인 + 직원별 Drive 폴더 scope 필터 (admin·미설정 = 전체) 적용 후 topK 선별.
  // 제외 재확인: excludeFolders 를 나중에 추가했거나 아직 sync 가 돌지 않아 남은 옛 청크를 응답에서 뺀다.
  const folderScope = allowedDriveFolders(auth);
  const ranked = reranked
    .filter((x) => !isExcludedPath(x.p.file_path ?? ''))
    .filter((x) => !folderScope || isPathInScope(x.p.file_path ?? '', folderScope))
    .slice(0, topK);

  // 4. Markdown 포맷 (사람·LLM 둘 다 읽기 좋음)
  const lines: string[] = [];
  lines.push(`# 의미 검색 결과 — "${query}"`);
  lines.push(`${ranked.length}개 chunk (${results.length}개 중 현황 우선 정렬) · top-${topK} 요청`);
  lines.push(
    `> **현황 우선 정렬됨.** \`[현황]\`=현재 사실(개발문서) · \`[이력]\`=과거 시점(dev-logs, 현재와 다를 수 있음) · \`[결정]\`=정책. ` +
      `**사실·수치는 [현황]/최신 날짜를 신뢰**하고, [이력]과 충돌하면 [현황]을 현재 값으로 채택하라.`,
  );
  if (fileType || cluster) {
    lines.push(`Filter: ${[fileType && `fileType=${fileType}`, cluster && `cluster=${cluster}`].filter(Boolean).join(', ')}`);
  }
  lines.push('');

  for (let i = 0; i < ranked.length; i++) {
    const { r, p, kind, adj } = ranked[i];
    const meta = KIND_META[kind];
    const driveLink = `https://drive.google.com/file/d/${p.file_id}/view`;
    const dateStr = p.doc_date ? ` · ${p.doc_date}` : '';
    const statusStr =
      p.doc_status === 'superseded' ? ' · ⚠️대체됨' : p.doc_status === 'parked' ? ' · 보류' : '';

    lines.push(`---`);
    lines.push(`### ${i + 1}. [${meta.label}${dateStr}${statusStr}] ${p.file_name}`);
    const chunkPos =
      typeof p.chunk_index === 'number' && typeof p.chunk_count === 'number' && p.chunk_count > 1
        ? ` · **청크:** ${p.chunk_index + 1}/${p.chunk_count}(문서 일부 — 수치·전체 맥락은 read_drive_file)`
        : '';
    // 표시 점수 = 정렬 기준(adj). 현황/이력 boost 로 raw 와 달라졌으면 raw 도 병기(표시-정렬 불일치 혼란 방지).
    lines.push(
      `**Score:** ${adj.toFixed(3)}` +
        (Math.abs(adj - r.score) > 0.001 ? ` (raw ${r.score.toFixed(3)} · 현황/이력 boost 반영)` : '') +
        ` · **종류:** ${meta.label} · **Type:** ${p.file_type}` +
        (p.cluster ? ` · **Cluster:** ${p.cluster}` : '') +
        chunkPos,
    );
    lines.push(`**Path:** \`${p.file_path}\``);
    lines.push(`**Heading:** ${p.heading}`);
    lines.push(`**File ID:** \`${p.file_id}\` — 전문 필요 시 \`read_drive_file\` 에 사용`);
    lines.push(`**Drive:** [열기](${driveLink})`);
    if (p.image_urls && p.image_urls.length > 0) {
      lines.push(`**Images:** ${p.image_urls.length}개 — ${p.image_urls.join(' · ')}`);
    }
    lines.push('');
    lines.push(p.content);
    lines.push('');
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: lines.join('\n'),
      },
    ],
  };
}
