/**
 * Drive 전체 indexing 스크립트.
 *
 * 동작:
 *   1. Drive 의 모든 .md 파일 list (recursive — 폴더 → 폴더)
 *   2. 각 파일 download → markdown 본문
 *   3. heading 기반 chunking + token 카운트
 *   4. OpenAI embedding (batch)
 *   5. Qdrant upsert (idempotent — chunk_id 기반)
 *
 * 사용 (drive 플러그인 명령):
 *   knowledge-mcp drive reindex                     # index all configured Drive roots
 *   knowledge-mcp drive reindex --root <folderId>   # 특정 폴더만
 *   knowledge-mcp drive reindex --dry-run           # indexing X, 통계만
 *   knowledge-mcp drive reindex --recreate          # collection 을 비우고 처음부터
 *
 * 전체 root 로 돌리면(--root/--biz-only/--dev-only 없이) 끝에서 이번 목록에 없는 파일의 벡터를 지운다.
 * 제외 폴더로 옮긴 파일, 나중에 excludeFolders 에 넣은 폴더, config 에서 뺀 root 의 청크가 여기서 정리된다.
 */
import type { DriveClient } from './client.js';
import { getDriveClient } from './client.js';
import { chunkMarkdown, parseFrontmatter } from './chunker.js';
import { embedTexts } from './embeddings.js';
import { extractText } from './extract_text.js';
import { isExcludedName } from './exclude.js';
import {
  ensureCollection,
  getQdrantClient,
  DRIVE_COLLECTION,
  type ChunkPayload,
} from './qdrant.js';
// 색인 코어 로직 SSOT — drive_sync(증분)와 공유해 drift 방지(특히 makeChunkId 일치 = orphan 로직 정합).
import {
  makeChunkId,
  classifyFile,
  contentHash,
  buildChunkPayload,
  deriveBizMeta,
  embedInputForChunk,
  SUPPORTED_MIMES,
  DRIVE_ROOTS,
  MAX_FILE_BYTES,
} from './indexer.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { dataDir } from '../../core/paths.js';
import { createLimiter } from '../../core/concurrency.js';

// 폴더 목록 호출의 동시 개수 상한. 하위 폴더를 제한 없이 동시에 열면 폴더가 수천 개일 때 Drive 속도 제한(403)이 난다.
const listGate = createLimiter(Number(process.env.DRIVE_LIST_CONCURRENCY ?? 8));

// 체크포인트 — 처리 완료 파일을 기록 → 재시작 시 skip (429 중단 후 재개·재실행 비용 절감).
// 파일마다 modifiedTime 을, 전체에 컬렉션 이름을 함께 둔다. 그래서 그사이 바뀐 파일과 다른 컬렉션(QDRANT_COLLECTION
// 교체 재색인)으로 도는 실행은 체크포인트를 믿지 않는다. 예전 형식(file_id 배열)은 버리고 처음부터 한다.
// 데이터 폴더에 둔다(패키지 폴더는 npm 설치본이라 쓰기 불가일 수 있다).
const CHECKPOINT_PATH = join(dataDir(), 'drive-reindex-checkpoint.json');
type Checkpoint = Map<string, string>; // file_id → modifiedTime
function loadCheckpoint(): Checkpoint {
  if (!existsSync(CHECKPOINT_PATH)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8')) as { collection?: string; files?: Record<string, string> };
    if (raw.collection !== DRIVE_COLLECTION || !raw.files) return new Map();
    return new Map(Object.entries(raw.files));
  } catch {
    return new Map();
  }
}
function saveCheckpoint(done: Checkpoint): void {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  writeFileSync(CHECKPOINT_PATH, JSON.stringify({ collection: DRIVE_COLLECTION, files: Object.fromEntries(done) }));
}
function clearCheckpoint(): void {
  if (existsSync(CHECKPOINT_PATH)) unlinkSync(CHECKPOINT_PATH);
}

interface DriveRoot {
  id: string;
  name: string;
  source: 'dev' | 'biz';
}

interface CliArgs {
  roots: DriveRoot[];
  dryRun: boolean;
  recreate: boolean;
  /** 일부 root 만 도는 실행인가 — 그때는 다른 root 의 벡터를 지우면 안 되므로 정리를 건너뛴다. */
  partial: boolean;
}

function parseArgs(args: string[]): CliArgs {
  let roots: DriveRoot[] = DRIVE_ROOTS;
  if (DRIVE_ROOTS.length === 0) {
    // 빈 목록으로 전체 실행을 하면 "목록에 없는 파일" 정리가 컬렉션을 통째로 지운다.
    throw new Error(
      'drive.roots is empty, so there is nothing to index. Set drive.roots in mcp.config.json or MCP_CONFIG_JSON ' +
        '(the Docker image reads /app/mcp.config.json).',
    );
  }
  let dryRun = false;
  let recreate = false;
  let partial = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) {
      // 설정한 root 하나만. 아무 폴더나 받으면 그 폴더 기준의 짧은 경로로 색인돼 폴더 권한을 비켜 가거나,
      // root 밖 내용이 의미 검색에 들어간다.
      const id = args[++i];
      const root = DRIVE_ROOTS.find((r) => r.id === id);
      if (!root) throw new Error(`--root ${id} is not one of drive.roots (${DRIVE_ROOTS.map((r) => r.id).join(', ')})`);
      roots = [root];
      partial = true;
    } else if (args[i] === '--biz-only') {
      roots = DRIVE_ROOTS.filter((r) => r.source === 'biz');
      partial = true;
    } else if (args[i] === '--dev-only') {
      roots = DRIVE_ROOTS.filter((r) => r.source === 'dev');
      partial = true;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--recreate') {
      // collection 비우고 새로 (orphan chunk 제거 — 정제·chunk 수 변동 반영)
      recreate = true;
    }
  }
  return { roots, dryRun, recreate, partial };
}

interface ListedFile {
  id: string;
  name: string;
  path: string;
  modifiedTime: string;
  mimeType: string;
  size?: number;
}

/**
 * 폴더 ID 의 지원 형식 파일 recursive list (deprecated 제외).
 */
async function listAllMarkdown(
  drive: DriveClient,
  folderId: string,
  pathPrefix: string,
): Promise<ListedFile[]> {
  const out: ListedFile[] = [];
  const subfolderTasks: Promise<ListedFile[]>[] = []; // 하위 폴더 recursion 을 병렬로
  let pageToken: string | undefined;

  do {
    const resp = await listGate(() =>
      drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,size)',
        pageSize: 100,
        pageToken,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      }),
    );

    for (const f of resp.data.files ?? []) {
      if (!f.id || !f.name) continue;
      const currentPath = pathPrefix ? `${pathPrefix}/${f.name}` : f.name;
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        // 제외 폴더 (민감 PII/계약/HR + 개발 아티팩트. SSOT: exclude.ts) skip — recursion 자체 안 함
        if (isExcludedName(f.name)) continue;
        // gather as parallel tasks instead of sequential await (hundreds of folders: minutes -> seconds)
        subfolderTasks.push(listAllMarkdown(drive, f.id, currentPath));
      } else if (f.mimeType && SUPPORTED_MIMES.has(f.mimeType)) {
        out.push({
          id: f.id,
          name: f.name,
          path: currentPath,
          modifiedTime: f.modifiedTime ?? '',
          mimeType: f.mimeType,
          size: f.size ? Number(f.size) : undefined,
        });
      }
    }

    pageToken = resp.data.nextPageToken ?? undefined;
  } while (pageToken);

  // 하위 폴더 병렬 recursion 결과 합치기
  const childResults = await Promise.all(subfolderTasks);
  for (const child of childResults) out.push(...child);

  return out;
}

async function downloadMarkdown(drive: DriveClient, fileId: string): Promise<string> {
  const resp = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' },
  );
  return resp.data as unknown as string;
}

/**
 * 이번 목록(keep)에 없는 파일의 벡터를 지운다. 반환 = 지운 파일 수.
 * 목록 단계가 실패하면 main 이 그 전에 FATAL 로 끝나므로, 여기 도달했다면 목록은 완전하다.
 */
async function pruneStaleVectors(keep: Set<string>): Promise<number> {
  const qdrant = await getQdrantClient();
  const stale = new Set<string>();
  let offset: string | number | null | undefined = undefined;
  do {
    const page = await qdrant.scroll(DRIVE_COLLECTION, {
      limit: 1000,
      offset: offset ?? undefined,
      with_payload: ['file_id'],
      with_vector: false,
    });
    for (const pt of page.points) {
      const fid = (pt.payload as { file_id?: unknown } | null | undefined)?.file_id;
      if (typeof fid === 'string' && !keep.has(fid)) stale.add(fid);
    }
    offset = (page.next_page_offset as string | number | null | undefined) ?? null;
  } while (offset !== null);
  for (const fid of stale) {
    await qdrant.delete(DRIVE_COLLECTION, {
      wait: true,
      filter: { must: [{ key: 'file_id', match: { value: fid } }] },
    });
  }
  return stale.size;
}

/** `knowledge-mcp drive reindex [--root ID | --dev-only | --biz-only] [--dry-run] [--recreate]` */
export async function runReindex(argv: string[]): Promise<void> {
  const { roots, dryRun, recreate, partial } = parseArgs(argv);
  const startTs = Date.now();

  console.log(
    `[index] start — roots=${roots.map((r) => r.name).join(',')} dryRun=${dryRun} recreate=${recreate}`,
  );

  // 1. Qdrant collection 보장 (--recreate 시 기존 비우고 새로)
  if (!dryRun) {
    if (recreate) {
      try {
        await (await getQdrantClient()).deleteCollection(DRIVE_COLLECTION);
        console.log(`[index] collection '${DRIVE_COLLECTION}' deleted (recreate)`);
      } catch {
        /* 없으면 무시 */
      }
    }
    await ensureCollection();
    console.log(`[index] collection '${DRIVE_COLLECTION}' ready`);
  }

  // 2. Drive 모든 markdown list (root 별)
  const drive = await getDriveClient();
  const allFiles: Array<ListedFile & { source: 'dev' | 'biz' }> = [];

  for (const root of roots) {
    const files = await listAllMarkdown(drive, root.id, '');
    console.log(`[index] '${root.name}' (${root.source}) — ${files.length} files`);
    for (const f of files) allFiles.push({ ...f, source: root.source });
  }
  console.log(`[index] total ${allFiles.length} files`);

  // 3. 파일별 download + chunk + embed + upsert
  //    체크포인트 — recreate 면 초기화, 아니면 이전 진행분 skip (429 중단 후 재개)
  if (recreate) clearCheckpoint();
  const done: Checkpoint = dryRun ? new Map() : loadCheckpoint();
  if (done.size > 0) console.log(`[index] checkpoint — skipping ${done.size} already processed files`);

  let totalChunks = 0;
  let totalTokens = 0;
  let processed = 0;

  for (const file of allFiles) {
    processed++;
    if (done.get(file.id) === file.modifiedTime) continue; // 체크포인트 — 이미 처리됨(그 뒤 바뀌지 않음)
    if (file.size && file.size > MAX_FILE_BYTES) {
      console.log(`[index] skip (too large: ${file.size}B > ${MAX_FILE_BYTES}B): [${file.source}] ${file.path}`);
      done.set(file.id, file.modifiedTime);
      if (!dryRun) saveCheckpoint(done);
      continue;
    }
    try {
      // dry-run 은 OCR 을 부르지 않는다(Mathpix 는 쪽마다 과금).
      const { text, needsOcr } = await extractText(drive, file.id, file.mimeType, { ocr: !dryRun });
      if (needsOcr || text.trim().length === 0) {
        console.log(`[index] skip (ocr/empty): [${file.source}] ${file.path}`);
        done.set(file.id, file.modifiedTime);
        if (!dryRun) saveCheckpoint(done);
        continue;
      }
      const chunks = chunkMarkdown(text);
      if (chunks.length === 0) {
        console.log(`[index] skip empty: [${file.source}] ${file.path}`);
        // 처리 완료로 기록 — 빠뜨리면 체크포인트가 영구히 남아 다음 재색인이 바뀐 파일을 건너뛴다.
        done.set(file.id, file.modifiedTime);
        if (!dryRun) saveCheckpoint(done);
        continue;
      }

      const classification = classifyFile(file.path, file.source);
      const bizMeta = deriveBizMeta(file.path, file.source);
      const hash = contentHash(text); // 무변경 skip(EFF-1) 판정용 — payload 동봉 (SSOT: drive_indexer)
      const fileTokens = chunks.reduce((s, c) => s + c.tokens, 0);
      totalChunks += chunks.length;
      totalTokens += fileTokens;

      if (dryRun) {
        console.log(
          `[index] [${processed}/${allFiles.length}] [${file.source}] ${file.path} — ${chunks.length} chunks, ${fileTokens} tok`,
        );
        continue;
      }

      // Embed — heading breadcrumb 포함(embedInputForChunk). 증분 경로(drive_indexer.indexFile)와 동일 입력.
      const vectors = await embedTexts(chunks.map(embedInputForChunk));

      // Qdrant upsert — payload 구성은 buildChunkPayload SSOT (drive_indexer) 공유
      const points = chunks.map((c, idx) => ({
        id: makeChunkId(file.id, idx),
        vector: vectors[idx],
        payload: buildChunkPayload(c, file, idx, chunks.length, classification, bizMeta, hash),
      }));

      const qdrant = await getQdrantClient();
      // B-1: 이 파일의 기존 청크를 전부 제거한 뒤 새로 upsert (줄어든 경우 유령 청크 잔류 방지).
      // 검증된 match 필터만 사용(range 필터는 비인덱싱 payload 에서 400). --recreate 면 매칭 0건(no-op).
      // 풀 reindex 는 배치 작업이라 delete~upsert 사이의 짧은 공백 허용.
      await qdrant.delete(DRIVE_COLLECTION, {
        wait: false,
        filter: { must: [{ key: 'file_id', match: { value: file.id } }] },
      });
      await qdrant.upsert(DRIVE_COLLECTION, {
        wait: false,
        points,
      });

      done.set(file.id, file.modifiedTime); // 체크포인트 기록 (upsert 성공)
      saveCheckpoint(done);

      console.log(
        `[index] [${processed}/${allFiles.length}] [${file.source}] ${file.path} — ${chunks.length} chunks upserted (${fileTokens} tok)`,
      );
    } catch (err) {
      // 실패 파일은 체크포인트에 기록 안 함 → 재실행 시 재시도
      console.error(
        `[index] ERROR [${file.source}] ${file.path}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 4. 이번 목록에 없는 파일의 벡터 정리 (전체 root 실행일 때만)
  if (!dryRun && !partial) {
    if (allFiles.length === 0) {
      // 목록이 비면(권한 문제, 잘못된 root id) 정리가 컬렉션 전체를 지운다. 이때는 건너뛴다.
      console.error('[index] listed 0 files — skipping cleanup so the existing index is not wiped. Check drive.roots and sharing.');
    } else {
      const pruned = await pruneStaleVectors(new Set(allFiles.map((f) => f.id)));
      console.log(`[index] cleanup — deleted vectors of ${pruned} files no longer listed`);
    }
  }

  const elapsedSec = ((Date.now() - startTs) / 1000).toFixed(1);
  // OpenAI text-embedding-3-small: $0.02/1M tokens.
  const costUsd = ((totalTokens / 1_000_000) * 0.02).toFixed(4);
  console.log(
    `\n[index] DONE — ${totalChunks} chunks, ${totalTokens} tokens, ` +
      `~$${costUsd} (OpenAI text-embedding-3-small), ${elapsedSec}s`,
  );
  // 전부 성공적으로 끝났으면 체크포인트 정리 (실패가 남아있으면 보존)
  if (!dryRun && done.size >= allFiles.length) clearCheckpoint();
}

