/**
 * Qdrant client singleton + collection 관리.
 *
 * Collection: config.qdrant.collection (default knowledge_v1), or env QDRANT_COLLECTION.
 * Vector size: 1536 (text-embedding-3-small)
 * Distance: Cosine
 */
import { QdrantClient } from '@qdrant/js-client-rest';
import { EMBEDDING_DIM } from './embeddings.js';
import { getConfig } from './config.js';

let _client: QdrantClient | null = null;

// Zero-downtime reindex: env QDRANT_COLLECTION overrides (index into a new collection, then swap the
// env var -> 0 downtime; remove it to roll back). Falls back to config.qdrant.collection.
export const DRIVE_COLLECTION = process.env.QDRANT_COLLECTION || getConfig().qdrant.collection;
// 차원 SSOT = embeddings.ts (모델 출력 차원). collection size 가 임베딩 차원과 항상 일치하도록 재노출.
export { EMBEDDING_DIM };

export function getQdrantClient(): QdrantClient {
  if (_client) return _client;

  const url = process.env.QDRANT_URL;
  const apiKey = process.env.QDRANT_API_KEY;

  if (!url) {
    throw new Error('[qdrant] QDRANT_URL env missing');
  }

  _client = new QdrantClient({
    url,
    apiKey: apiKey || undefined,
    // production: 짧은 timeout 으로 cold-start hang 회피
    timeout: 10_000,
  });

  return _client;
}

/**
 * Collection 이 없으면 생성. Idempotent.
 * Payload field 중 자주 filter 하는 것은 indexed payload 로 등록.
 */
export async function ensureCollection(): Promise<void> {
  const client = getQdrantClient();
  const collections = await client.getCollections();
  const exists = collections.collections.some((c) => c.name === DRIVE_COLLECTION);

  if (exists) return;

  await client.createCollection(DRIVE_COLLECTION, {
    vectors: {
      size: EMBEDDING_DIM,
      distance: 'Cosine',
    },
    // HNSW 기본 (m=16, ef_construct=100) — 1만 vec 까지 충분
    optimizers_config: {
      default_segment_number: 2,
    },
  });

  // 자주 filter 하는 payload field 에 index (검색 빠름)
  for (const fieldName of [
    'file_type', 'cluster', 'file_id', 'source',
    // 이미지 유무 / frontmatter 메타 filter
    'has_image', 'doc_status', 'doc_tier',
    // 신규 — 태그·모드·경로 파생 filter (배열 doc_tags 는 원소 단위 keyword 매칭)
    'doc_tags', 'doc_type', 'doc_category', 'doc_customer',
  ] as const) {
    await client.createPayloadIndex(DRIVE_COLLECTION, {
      field_name: fieldName,
      field_schema: fieldName === 'has_image' ? 'bool' : 'keyword',
    });
  }
}

// interface 가 아니라 type 별칭 — Qdrant upsert 의 payload(Record<string, unknown>) 에 할당 가능해야 함
// (interface 는 declaration merging 때문에 index-signature 타입에 비할당. type 별칭은 가능).
export type ChunkPayload = {
  chunk_id: string;
  file_id: string;
  file_name: string;
  file_path: string;
  heading: string;
  chunk_index: number;
  chunk_count: number; // 이 파일의 총 청크 수 — 재색인 시 줄어든 orphan 청크 삭제(B-1) 판정용.
  content: string;
  modified_time: string;
  content_hash: string; // 추출 텍스트 sha256 — 무변경 재색인 skip(EFF-1) 판정용. 모든 청크 동일값.
  file_type: 'dev_log' | 'decision' | 'rule' | 'template' | 'biz' | 'other';
  cluster: string | null;
  source: 'dev' | 'biz';

  // ── 신규: 이미지·구조 메타 (2026-05-27 RAG 개선) ──
  image_urls: string[]; // 청크 내 Mathpix CDN(또는 영구화) 이미지 URL
  has_image: boolean; // image_urls.length > 0 — payload filter 인덱싱용
  table_count: number; // 청크 내 markdown table 개수
  has_code_block: boolean; // ``` fence 존재 여부

  // ── frontmatter 승격 (검색 filter·연결) ──
  doc_status: string | null; // living | implemented | accepted | exploring | parked | superseded
  doc_tier: string | null; // (레거시 S|M|L — 신규 문서 미사용)
  doc_date: string | null; // ISO date
  doc_authors: string[]; // ["alice", "claude"]
  doc_related: string[]; // 문서↔문서 연결 (related)
  doc_tags: string[]; // 태그 (dev=frontmatter tags / biz=경로·파일명 파생)
  doc_source_refs: string[]; // 문서→코드 경로 (source_refs)
  doc_affects: string[]; // 결정→현황 (affects)
  doc_products: string[]; // 가로지르는 제품
  doc_type: string | null; // 현황 | 결정 | 이력 | bug
  doc_confidence: string | null; // HIGH | MEDIUM

  // ── 경로 파생 (biz 소스 — frontmatter 없는 PDF/docx) ──
  doc_category: string | null; // 최상위 폴더(NN_ 제거): 고객사·IR_피칭덱·세일즈 …
  doc_customer: string | null; // 01_고객사/{name} → 고객사명
}
