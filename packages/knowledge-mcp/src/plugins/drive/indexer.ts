/**
 * Drive 파일 1개 → Qdrant 색인/삭제 공통 로직.
 * 전체 reindex (reindex.ts) 와 증분 sync (sync.ts) 가 공유.
 */
import type { DriveClient } from './client.js';
import { createHash } from 'crypto';
import { chunkMarkdown, type RawChunk } from './chunker.js';
import { embedTexts } from './embeddings.js';
import { extractText } from './extract_text.js';
import { getQdrantClient, DRIVE_COLLECTION, type ChunkPayload } from './qdrant.js';

import { DRIVE_ROOTS, MAX_FILE_BYTES } from './settings.js';
import { normalizeFolderName } from './exclude.js';
import { getConfig } from '../../core/config.js';

export { DRIVE_ROOTS, MAX_FILE_BYTES };

/** 추출 지원 mimeType (extract_text.ts 와 일치). 스캔 PDF/이미지는 Mathpix OCR. 풀 reindex·증분 sync 공용 SSOT. */
export const SUPPORTED_MIMES = new Set<string>([
  'text/markdown',
  'text/plain',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);


/** 점진적 chunk ID — file_id + index 면 항상 같은 ID (idempotent upsert). 색인 전 경로 공용. */
export function makeChunkId(fileId: string, chunkIndex: number): number {
  const hash = createHash('md5').update(`${fileId}:${chunkIndex}`).digest();
  return Number(hash.readBigUInt64BE(0) & 0x7fffffffffffffffn);
}

/** path + source -> file_type / cluster. cluster = top-level folder (generic). */
export function classifyFile(
  path: string,
  source: 'dev' | 'biz',
): { type: ChunkPayload['file_type']; cluster: string | null } {
  const m = path.match(/^([^/]+)\//);
  const topFolder = m ? m[1] : null;
  return { type: source === 'biz' ? 'biz' : 'other', cluster: topFolder };
}

export interface IndexableFile {
  id: string;
  name: string;
  path: string;
  modifiedTime: string;
  source: 'dev' | 'biz';
  mimeType: string;
  /** Drive 메타의 바이트 크기. Google 문서는 없음. */
  size?: number;
}

/**
 * 청크의 임베딩 입력 텍스트 — heading breadcrumb(상위>하위 섹션 맥락)를 본문 앞에 붙인다.
 * (contextual chunk header) 부모 heading 은 청크 본문에 없어(다른 섹션) 벡터가 섹션 맥락을 잃는데,
 * 이를 임베딩에 포함하면 recall 이 오른다. 저장·표시용 content(payload)는 그대로 두고 임베딩 입력에만 적용.
 * heading 이 없으면(첫 heading 이전 본문) 본문만. 옛 자리표시 '문서 시작' 도 건너뛴다. ★증분(indexFile)·전체(reindex.ts) 공용 SSOT —
 * 두 경로가 반드시 같은 입력을 임베딩해야 같은 청크가 같은 벡터를 가진다(벡터 공간 정합).
 */
export function embedInputForChunk(chunk: RawChunk): string {
  const h = chunk.heading?.trim();
  if (!h || h === '문서 시작') return chunk.content;
  return `${h}\n\n${chunk.content}`;
}

/** 추출 텍스트 → sha256 (무변경 재색인 skip 판정용). */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface BizMeta {
  doc_category: string | null;
  doc_customer: string | null;
  path_tags: string[];
}

// 폴더/파일명 앞 번호 prefix("01_", "06_", "0316_") 제거용.
const NN_PREFIX = /^\d{1,4}[_-]/;
// 고객사별 하위 폴더를 둔 최상위 폴더 이름(config drive.customerFolders). 번호 접두를 떼고 대소문자 무시로 비교.
const CUSTOMER_FOLDERS = getConfig().drive.customerFolders.map((n) => normalizeFolderName(n.replace(NN_PREFIX, '')));

/**
 * biz 소스(PDF/docx — frontmatter 없음)의 경로/파일명에서 메타 파생.
 * EXTRACTED — 사람이 폴더로 분류한 사실(LLM 추론 아님). dev 소스는 frontmatter 가 SSOT 라 빈 값.
 *   doc_category : 최상위 폴더(NN_ 제거)  예) "01_Clients/…" → "Clients"
 *   doc_customer : {customerFolders}/{name}  예) "01_Clients/Acme/…" → "Acme"
 *   path_tags    : 폴더 세그먼트(NN_ 제거) + 파일명 토큰 (검색 태그)
 */
export function deriveBizMeta(path: string, source: 'dev' | 'biz'): BizMeta {
  if (source !== 'biz') return { doc_category: null, doc_customer: null, path_tags: [] };
  const segs = path.split('/').filter(Boolean);
  const folders = segs.slice(0, -1); // 마지막 = 파일명
  const fileName = segs[segs.length - 1] ?? '';
  const strip = (s: string) => s.replace(NN_PREFIX, '');
  const category = folders[0] ? strip(folders[0]) : null;
  const top = folders[0] ? normalizeFolderName(strip(folders[0])) : '';
  const customer = top && folders[1] && CUSTOMER_FOLDERS.some((c) => c && top.includes(c)) ? folders[1] : null;
  const folderTags = folders.map(strip);
  const nameTokens = fileName
    .replace(/\.[a-z0-9]+$/i, '') // 확장자 제거
    .split(/[_\-\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const path_tags = [...new Set([...folderTags, ...nameTokens])].filter(Boolean);
  return { doc_category: category, doc_customer: customer, path_tags };
}

/**
 * chunk + 파일/분류/경로 메타 → ChunkPayload. reindex(reindex.ts)·증분(indexFile) 공유 SSOT.
 * dev 메타는 chunk(frontmatter 파싱)에, biz 메타는 bizMeta(경로 파싱)에 담겨 들어온다.
 */
export function buildChunkPayload(
  chunk: RawChunk,
  file: IndexableFile,
  idx: number,
  chunkCount: number,
  classification: { type: ChunkPayload['file_type']; cluster: string | null },
  bizMeta: BizMeta,
  hash: string,
): ChunkPayload {
  const tags = [...new Set([...chunk.doc_tags, ...bizMeta.path_tags])];
  return {
    chunk_id: `${file.id}_${idx}`,
    file_id: file.id,
    file_name: file.name,
    file_path: file.path,
    heading: chunk.heading,
    chunk_index: idx,
    chunk_count: chunkCount,
    content: chunk.content,
    modified_time: file.modifiedTime,
    content_hash: hash,
    file_type: classification.type,
    cluster: classification.cluster,
    source: file.source,
    image_urls: chunk.image_urls,
    has_image: chunk.image_urls.length > 0,
    table_count: chunk.table_count,
    has_code_block: chunk.has_code_block,
    doc_status: chunk.doc_status,
    doc_date: chunk.doc_date,
    doc_authors: chunk.doc_authors,
    doc_related: chunk.doc_related,
    doc_source_refs: chunk.doc_source_refs,
    doc_affects: chunk.doc_affects,
    doc_products: chunk.doc_products,
    doc_type: chunk.doc_type,
    doc_confidence: chunk.doc_confidence,
    doc_tags: tags,
    doc_category: bizMeta.doc_category,
    doc_customer: bizMeta.doc_customer,
  };
}

/**
 * 파일의 기존 색인 상태(청크0 payload) 조회 — content_hash·청크 수.
 * 못 찾으면 null (미색인). 조회 실패 시 null 취급(안전 — 재색인 진행).
 */
async function getIndexedState(
  fileId: string,
): Promise<{ content_hash: string | null; chunk_count: number; file_path: string; file_name: string; source: string } | null> {
  try {
    const got = await (await getQdrantClient()).retrieve(DRIVE_COLLECTION, {
      ids: [makeChunkId(fileId, 0)],
      with_payload: true,
      with_vector: false,
    });
    if (!got || got.length === 0) return null;
    const p = got[0].payload as Record<string, unknown> | undefined;
    return {
      content_hash: (p?.content_hash as string) ?? null,
      chunk_count: typeof p?.chunk_count === 'number' ? (p.chunk_count as number) : 0,
      file_path: String(p?.file_path ?? ''),
      file_name: String(p?.file_name ?? ''),
      source: String(p?.source ?? ''),
    };
  } catch {
    return null; // 조회 실패 = 미확인 → 재색인 진행(안전)
  }
}

/**
 * 파일 1개 형식별 추출 → chunk → embed → Qdrant upsert. 색인된 chunk 수 반환 (skip 시 0).
 *
 * - EFF-1: 추출 텍스트 sha256 이 기존 색인과 동일하면 embed/upsert 생략(무변경 skip).
 * - B-1: 재색인 시 청크 수가 줄면 옛 청크(chunk_index >= 새 수)를 삭제해 유령 청크(폐기된 사실) 잔류 방지.
 * - B-9: 증분 경로는 wait:true 로 색인 직후 검색 가시성 + 실패 인지.
 */
export async function indexFile(drive: DriveClient, file: IndexableFile): Promise<number> {
  if (file.size && file.size > MAX_FILE_BYTES) {
    console.error(`[index] skip (too large: ${file.size}B > ${MAX_FILE_BYTES}B): ${file.path}`);
    return 0;
  }
  const { text, needsOcr } = await extractText(drive, file.id, file.mimeType);
  // needsOcr=true 는 이제 미지원 형식만 (PDF 스캔본·이미지는 extract_text 가 Mathpix 로 처리).
  // 미지원 또는 추출 결과 빈 파일 → 색인 skip.
  if (needsOcr || text.trim().length === 0) return 0;

  const hash = contentHash(text);

  // EFF-1: 본문·경로·이름이 모두 그대로면 embed/upsert 생략 (sharing 등 메타 change 비용 차단).
  // 옮기거나 이름만 바꾼 파일은 다시 색인한다 — payload 의 file_path 가 직원별 폴더 scope 판정 기준이라
  // 옛 경로가 남으면 옮긴 뒤에도 옛 폴더 권한자에게 검색된다. 경로 태그(doc_tags)도 청크마다 다시 만든다.
  const prev = await getIndexedState(file.id);
  if (
    prev &&
    prev.content_hash === hash &&
    prev.file_path === file.path &&
    prev.file_name === file.name &&
    prev.source === file.source
  ) {
    return 0;
  }

  const chunks = chunkMarkdown(text);
  if (chunks.length === 0) return 0;

  const classification = classifyFile(file.path, file.source);
  const bizMeta = deriveBizMeta(file.path, file.source);
  // heading breadcrumb 포함 임베딩(embedInputForChunk) — 저장 content 는 그대로, 임베딩 입력만 섹션 맥락 부여.
  const vectors = await embedTexts(chunks.map(embedInputForChunk), 'RETRIEVAL_DOCUMENT');

  const points = chunks.map((c, idx) => ({
    id: makeChunkId(file.id, idx),
    vector: vectors[idx],
    payload: buildChunkPayload(c, file, idx, chunks.length, classification, bizMeta, hash),
  }));

  const client = await getQdrantClient();
  // 새 청크 0..M-1 upsert (wait:true — 단일 파일이라 비용 작고, 직후 검색 가시성·실패 인지 확보)
  await client.upsert(DRIVE_COLLECTION, { wait: true, points });
  // B-1: 줄어든 경우 옛 청크(index >= M)를 결정적 chunk ID 로 직접 삭제.
  //      (Qdrant range 필터는 비인덱싱 payload 에서 400 Bad Request → ID 삭제로 우회. upsert 와 disjoint 집합)
  if (prev && prev.chunk_count > chunks.length) {
    const orphanIds: number[] = [];
    for (let i = chunks.length; i < prev.chunk_count; i++) orphanIds.push(makeChunkId(file.id, i));
    await client.delete(DRIVE_COLLECTION, { wait: true, points: orphanIds });
  }
  return chunks.length;
}

/** 특정 파일의 모든 chunk 를 Qdrant 에서 삭제 (파일 삭제·trashed 시). */
export async function deleteFileVectors(fileId: string): Promise<void> {
  await (await getQdrantClient()).delete(DRIVE_COLLECTION, {
    filter: { must: [{ key: 'file_id', match: { value: fileId } }] },
  });
}
