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
 * 사용:
 *   npm run reindex                        # index all configured Drive roots
 *   npm run reindex -- --root <folderId>  # 특정 폴더만
 *   npm run reindex -- --dry-run          # indexing X, 통계만
 */
import 'dotenv/config';
import type { drive_v3 } from 'googleapis';
import { getDriveClient } from '../src/integrations/drive.js';
import { chunkMarkdown, parseFrontmatter } from '../src/lib/chunker.js';
import { embedTexts } from '../src/lib/embeddings.js';
import { extractText } from '../src/lib/extract_text.js';
import { EXCLUDED_FOLDER_NAMES } from '../src/lib/exclude.js';
import {
  ensureCollection,
  getQdrantClient,
  DRIVE_COLLECTION,
  type ChunkPayload,
} from '../src/lib/qdrant.js';
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
} from '../src/lib/drive_indexer.js';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';

// 체크포인트 — 처리 완료 file_id 기록 → 재시작 시 skip (429 중단 후 재개·재실행 비용 절감).
// fileURLToPath conversion avoids %20 breakage when the path contains spaces.
const CHECKPOINT_PATH = fileURLToPath(new URL('../.reindex_checkpoint.json', import.meta.url));
function loadCheckpoint(): Set<string> {
  if (!existsSync(CHECKPOINT_PATH)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8')) as string[]);
  } catch {
    return new Set();
  }
}
function saveCheckpoint(done: Set<string>): void {
  writeFileSync(CHECKPOINT_PATH, JSON.stringify([...done]));
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
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let roots: DriveRoot[] = DRIVE_ROOTS;
  let dryRun = false;
  let recreate = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) {
      // override default with single root (source=dev 가정)
      roots = [{ id: args[++i], name: 'custom', source: 'dev' }];
    } else if (args[i] === '--biz-only') {
      roots = DRIVE_ROOTS.filter((r) => r.source === 'biz');
    } else if (args[i] === '--dev-only') {
      roots = DRIVE_ROOTS.filter((r) => r.source === 'dev');
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--recreate') {
      // collection 비우고 새로 (orphan chunk 제거 — 정제·chunk 수 변동 반영)
      recreate = true;
    }
  }
  return { roots, dryRun, recreate };
}

/** 색인 제외 폴더 — 민감(PII/계약/HR/deprecated) + 개발 아티팩트(node_modules 등). SSOT: lib/exclude.ts */
const EXCLUDED_FOLDERS = EXCLUDED_FOLDER_NAMES;

interface ListedFile {
  id: string;
  name: string;
  path: string;
  modifiedTime: string;
  mimeType: string;
}

/**
 * 폴더 ID 의 지원 형식 파일 recursive list (deprecated 제외).
 */
async function listAllMarkdown(
  drive: drive_v3.Drive,
  folderId: string,
  pathPrefix: string,
): Promise<ListedFile[]> {
  const out: ListedFile[] = [];
  const subfolderTasks: Promise<ListedFile[]>[] = []; // 하위 폴더 recursion 을 병렬로
  let pageToken: string | undefined;

  do {
    const resp = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType,modifiedTime)',
      pageSize: 100,
      pageToken,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    for (const f of resp.data.files ?? []) {
      if (!f.id || !f.name) continue;
      const currentPath = pathPrefix ? `${pathPrefix}/${f.name}` : f.name;
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        // 제외 폴더 (deprecated + 민감 PII/계약/HR) skip — recursion 자체 안 함
        if (EXCLUDED_FOLDERS.has(f.name)) continue;
        // gather as parallel tasks instead of sequential await (hundreds of folders: minutes -> seconds)
        subfolderTasks.push(listAllMarkdown(drive, f.id, currentPath));
      } else if (f.mimeType && SUPPORTED_MIMES.has(f.mimeType)) {
        out.push({
          id: f.id,
          name: f.name,
          path: currentPath,
          modifiedTime: f.modifiedTime ?? '',
          mimeType: f.mimeType,
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

async function downloadMarkdown(drive: drive_v3.Drive, fileId: string): Promise<string> {
  const resp = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' },
  );
  return resp.data as unknown as string;
}

async function main() {
  const { roots, dryRun, recreate } = parseArgs();
  const startTs = Date.now();

  console.log(
    `[index] start — roots=${roots.map((r) => r.name).join(',')} dryRun=${dryRun} recreate=${recreate}`,
  );

  // 1. Qdrant collection 보장 (--recreate 시 기존 비우고 새로)
  if (!dryRun) {
    if (recreate) {
      try {
        await getQdrantClient().deleteCollection(DRIVE_COLLECTION);
        console.log(`[index] collection '${DRIVE_COLLECTION}' 삭제 (recreate)`);
      } catch {
        /* 없으면 무시 */
      }
    }
    await ensureCollection();
    console.log(`[index] collection '${DRIVE_COLLECTION}' ready`);
  }

  // 2. Drive 모든 markdown list (root 별)
  const drive = getDriveClient();
  const allFiles: Array<{
    id: string;
    name: string;
    path: string;
    modifiedTime: string;
    source: 'dev' | 'biz';
    mimeType: string;
  }> = [];

  for (const root of roots) {
    const files = await listAllMarkdown(drive, root.id, '');
    console.log(`[index] '${root.name}' (${root.source}) — ${files.length} files`);
    for (const f of files) allFiles.push({ ...f, source: root.source });
  }
  console.log(`[index] total ${allFiles.length} files`);

  // 3. 파일별 download + chunk + embed + upsert
  //    체크포인트 — recreate 면 초기화, 아니면 이전 진행분 skip (429 중단 후 재개)
  if (recreate) clearCheckpoint();
  const done = dryRun ? new Set<string>() : loadCheckpoint();
  if (done.size > 0) console.log(`[index] 체크포인트 — 이미 처리 ${done.size}개 skip`);

  let totalChunks = 0;
  let totalTokens = 0;
  let processed = 0;

  for (const file of allFiles) {
    processed++;
    if (done.has(file.id)) continue; // 체크포인트 — 이미 처리됨
    try {
      const { text, needsOcr } = await extractText(drive, file.id, file.mimeType);
      if (needsOcr || text.trim().length === 0) {
        console.log(`[index] skip (ocr/empty): [${file.source}] ${file.path}`);
        done.add(file.id);
        saveCheckpoint(done);
        continue;
      }
      const chunks = chunkMarkdown(text);
      if (chunks.length === 0) {
        console.log(`[index] skip empty: [${file.source}] ${file.path}`);
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

      const qdrant = getQdrantClient();
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

      done.add(file.id); // 체크포인트 기록 (upsert 성공)
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

main().catch((err) => {
  console.error('[index] FATAL:', err);
  process.exit(1);
});
