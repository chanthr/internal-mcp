/**
 * Qdrant REST client + collection 관리.
 *
 * Collection: config.qdrant.collection (default knowledge_v1), or env QDRANT_COLLECTION.
 * Vector size: 1536 (text-embedding-3-small)
 * Distance: Cosine
 *
 * @qdrant/js-client-rest 대신 Node 내장 fetch 로 REST API 를 부른다. 그 라이브러리는 최신판(1.19)도 취약한
 * undici 7.29 를 고정 의존성으로 끌어와, 이 패키지를 설치하는 모든 사람에게 npm audit 경고를 남겼다.
 * 쓰는 엔드포인트가 9개뿐이라 직접 부르는 편이 가볍다. 메서드 이름과 반환 모양은 그 라이브러리와 같게 뒀다.
 */
import { EMBEDDING_DIM } from './embeddings.js';
import { getConfig } from '../../core/config.js';

export type PointId = string | number;
export type QdrantFilter = { must?: unknown[]; should?: unknown[]; must_not?: unknown[] };
export interface QdrantPoint {
  id: PointId;
  vector?: number[];
  payload?: Record<string, unknown> | null;
}
export interface ScoredPoint extends QdrantPoint {
  score: number;
  version?: number;
}

const QDRANT_TIMEOUT_MS = 10_000; // 짧은 timeout 으로 cold-start hang 회피

export class QdrantError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'QdrantError';
  }
}

export class QdrantClient {
  private readonly base: string;

  constructor(
    url: string,
    private readonly apiKey?: string,
  ) {
    this.base = url.replace(/\/+$/, '');
  }

  private async call<T>(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.apiKey) headers['api-key'] = this.apiKey;
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(QDRANT_TIMEOUT_MS),
      });
    } catch (e) {
      const reason = e instanceof Error && e.name === 'TimeoutError' ? `timeout ${QDRANT_TIMEOUT_MS}ms` : String(e);
      throw new QdrantError(`[qdrant] ${method} ${path} failed: ${reason}`, 0);
    }
    const text = await res.text();
    let json: { result?: T; status?: unknown } | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const detail = (json?.status as { error?: string } | undefined)?.error ?? text.slice(0, 200);
      throw new QdrantError(`[qdrant] ${method} ${path} ${res.status}: ${detail}`, res.status);
    }
    return json?.result as T;
  }

  private col(name: string): string {
    return `/collections/${encodeURIComponent(name)}`;
  }

  getCollections(): Promise<{ collections: Array<{ name: string }> }> {
    return this.call('GET', '/collections');
  }

  createCollection(name: string, body: Record<string, unknown>): Promise<boolean> {
    return this.call('PUT', this.col(name), body);
  }

  deleteCollection(name: string): Promise<boolean> {
    return this.call('DELETE', this.col(name));
  }

  createPayloadIndex(name: string, body: { field_name: string; field_schema: string; wait?: boolean }): Promise<unknown> {
    const { wait = true, ...rest } = body;
    return this.call('PUT', `${this.col(name)}/index?wait=${wait}`, rest);
  }

  upsert(name: string, body: { points: QdrantPoint[]; wait?: boolean }): Promise<unknown> {
    const { wait = true, ...rest } = body;
    return this.call('PUT', `${this.col(name)}/points?wait=${wait}`, rest);
  }

  /** Delete by point ids or by filter. Waits by default, like the official client. */
  delete(name: string, body: { points?: PointId[]; filter?: QdrantFilter; wait?: boolean }): Promise<unknown> {
    const { wait = true, ...rest } = body;
    return this.call('POST', `${this.col(name)}/points/delete?wait=${wait}`, rest);
  }

  retrieve(name: string, body: { ids: PointId[]; with_payload?: boolean | string[]; with_vector?: boolean }): Promise<QdrantPoint[]> {
    return this.call('POST', `${this.col(name)}/points`, body);
  }

  scroll(
    name: string,
    body: { filter?: QdrantFilter; limit?: number; offset?: PointId; with_payload?: boolean | string[]; with_vector?: boolean },
  ): Promise<{ points: QdrantPoint[]; next_page_offset?: PointId | null }> {
    return this.call('POST', `${this.col(name)}/points/scroll`, body);
  }

  search(
    name: string,
    body: { vector: number[]; limit: number; filter?: QdrantFilter; with_payload?: boolean | string[]; score_threshold?: number },
  ): Promise<ScoredPoint[]> {
    return this.call('POST', `${this.col(name)}/points/search`, body);
  }
}

let _client: QdrantClient | null = null;

// Zero-downtime reindex: env QDRANT_COLLECTION overrides (index into a new collection, then swap the
// env var -> 0 downtime; remove it to roll back). Falls back to config.qdrant.collection.
export const DRIVE_COLLECTION = process.env.QDRANT_COLLECTION || getConfig().qdrant.collection;
// 차원 SSOT = embeddings.ts (모델 출력 차원). collection size 가 임베딩 차원과 항상 일치하도록 재노출.
export { EMBEDDING_DIM };

/** Qdrant 클라이언트(프로세스당 하나). */
export async function getQdrantClient(): Promise<QdrantClient> {
  if (_client) return _client;
  const url = process.env.QDRANT_URL;
  if (!url) throw new Error('[qdrant] QDRANT_URL env missing');
  _client = new QdrantClient(url, process.env.QDRANT_API_KEY || undefined);
  return _client;
}

/**
 * Collection 이 없으면 생성. Idempotent.
 * Payload field 중 자주 filter 하는 것은 indexed payload 로 등록.
 */
export async function ensureCollection(): Promise<void> {
  const client = await getQdrantClient();
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
