/**
 * read_drive_file(fileId | fileIds, maxChars?) — Drive 파일 본문 read.
 *
 * Markdown / text 는 raw media. Google Docs/Sheets/Slides 는 export.
 *
 * 배치: fileIds 로 여러 파일을 한 번에 **병렬** read.
 *   순차 호출(파일당 MCP 왕복 + Drive API 2회)을 1회 호출로 합쳐 per-call 네트워크
 *   floor 를 N→1 로 줄이고 Drive I/O 도 동시 처리. 원문 여러 개를 비교/요약할 때 핵심.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { getDriveClient } from '../client.js';
import { getAuth } from '../../../core/context.js';
import { allowedDriveFolders, isPathInScope } from '../../../core/scope.js';
import { classifyAndPath } from '../path.js';
import { extractText } from '../extract_text.js';
import { getQdrantClient, DRIVE_COLLECTION } from '../qdrant.js';
import { MAX_FILE_BYTES } from '../settings.js';

const DESCRIPTION =
  'Google Drive 파일 본문 read. markdown/text 는 raw, Google Docs/Sheets/Slides 는 export, ' +
  '**PDF·Word(docx)·PowerPoint(pptx)·Excel(xlsx)·이미지는 본문 텍스트로 추출**(스캔 PDF·이미지는 OCR). ' +
  'search_drive / semantic_search_drive 응답의 id (File ID) 사용. ' +
  'semantic_search_drive 로 관련 청크를 찾은 뒤 원문 전체 맥락이 필요할 때 호출하는 2단계 검색의 2단계. ' +
  '**여러 문서를 읽어야 하면 fileId 를 하나씩 여러 번 호출하지 말고 fileIds=[...] 로 한 번에 (병렬 — 순차보다 훨씬 빠름).** ' +
  '큰 파일은 maxChars 로 truncate.';

const inputSchema = z
  .object({
    fileId: z.string().min(1).optional().describe('Drive file ID (단일). fileIds 와 둘 중 하나.'),
    fileIds: z
      .array(z.string().min(1))
      .min(1)
      .max(10)
      .optional()
      .describe('여러 Drive file ID 를 한 번에 병렬 read (1~10개). 순차 호출보다 훨씬 빠름. fileId 와 둘 중 하나.'),
    maxChars: z.number().int().min(1000).max(200000).default(50000).describe('파일당 최대 반환 문자 수 (1000-200000). default 50000.'),
  })
  .refine((d) => d.fileId || (d.fileIds && d.fileIds.length > 0), {
    message: 'fileId 또는 fileIds 중 하나는 필수',
  });

export const readDriveFileTool = defineTool({
  name: 'read_drive_file',
  description: DESCRIPTION,
  input: inputSchema,
  annotations: { readOnlyHint: true },
  run: (args) => handleReadDriveFile(args),
});

const GOOGLE_DOC_EXPORT: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/markdown',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

/** raw text 로 읽으면 깨지는 바이너리 — extract_text 파이프라인으로 본문 추출해야 하는 형식. */
function isExtractableBinary(mime: string): boolean {
  return (
    mime === 'application/pdf' ||
    mime.includes('wordprocessingml') || // .docx
    mime.includes('presentationml') || // .pptx
    mime.includes('spreadsheetml') || // .xlsx
    mime.startsWith('image/')
  );
}

/**
 * 색인된 파일이면 Qdrant 청크를 chunk_index 순으로 재조립해 원문 복원 — 색인 시 이미 추출(스캔본은 OCR)한
 * 텍스트를 재사용하므로 재다운로드·재OCR 비용 0(스캔 PDF 를 읽을 때마다 Mathpix 를 다시 태우지 않음).
 * 미색인이거나 조회 실패면 null(→ extract_text 폴백). 청크 overlap 접두("…") 는 best-effort 제거.
 */
async function reassembleFromIndex(fileId: string): Promise<string | null> {
  try {
    const res = await (await getQdrantClient()).scroll(DRIVE_COLLECTION, {
      filter: { must: [{ key: 'file_id', match: { value: fileId } }] },
      limit: 1000,
      with_payload: true,
      with_vector: false,
    });
    const chunks = (res.points ?? [])
      .map((pt) => {
        const p = pt.payload as Record<string, unknown> | undefined;
        return {
          content: typeof p?.content === 'string' ? (p.content as string) : null,
          idx: typeof p?.chunk_index === 'number' ? (p.chunk_index as number) : 0,
        };
      })
      .filter((c): c is { content: string; idx: number } => c.content !== null)
      .sort((a, b) => a.idx - b.idx);
    if (chunks.length === 0) return null;
    return chunks
      .map((c, i) => {
        if (i === 0 || !c.content.startsWith('…')) return c.content;
        const nl = c.content.indexOf('\n\n'); // overlap 접두(…tail\n\n) 제거
        return nl >= 0 ? c.content.slice(nl + 2) : c.content;
      })
      .join('\n\n');
  } catch {
    return null;
  }
}

type DriveClient = Awaited<ReturnType<typeof getDriveClient>>;

/** 파일 1개 read → 구조화 객체 (배치에서 파일별 에러 격리용으로 throw 대신 error 필드 반환). */
async function readOne(
  drive: DriveClient,
  fileId: string,
  maxChars: number,
  folderScope: string[] | null,
) {
  try {
    const meta = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType, parents, size, modifiedTime, webViewLink',
    });
    const m = meta.data;
    const mimeType = m.mimeType || '';

    if (mimeType === 'application/vnd.google-apps.folder') {
      return { fileId, error: 'fileId is a folder. use list_drive_folder instead.' };
    }

    // 보안: dev/biz root 하위 + 제외 폴더(PII·계약·HR·deprecated) 미경유 + 직원 폴더 scope.
    // search_drive / semantic_search_drive 와 동일 가드 — 임의 File ID 직접 입력으로
    // 색인 대상 밖·민감 폴더·권한 밖 파일을 읽는 우회를 차단한다.
    const { cls, path } = await classifyAndPath(drive, m.parents ?? undefined);
    if (cls !== 'ok' || !isPathInScope(path, folderScope)) {
      return {
        fileId,
        error: '[forbidden] 접근 범위 밖 파일입니다 (색인 대상 root 밖 / 민감 폴더 / 직원 권한 밖).',
      };
    }

    // 크기 상한 — 파일을 통째로 메모리에 올리므로 거대한 파일(영상·대용량 PDF)이 서버를 죽이지 않게 막는다.
    // 색인 재조립본이 있으면 그것으로 읽는다(재다운로드 없음). Google 문서는 size 가 없어 해당 없음.
    const tooLarge = !!m.size && Number(m.size) > MAX_FILE_BYTES;
    const tooLargeError = {
      fileId,
      error: `파일이 너무 커서 읽지 않습니다 (${m.size}B > ${MAX_FILE_BYTES}B, DRIVE_MAX_FILE_BYTES).`,
    };

    let body: string;
    let extractMethod: string | undefined;
    if (GOOGLE_DOC_EXPORT[mimeType]) {
      const res = await drive.files.export(
        { fileId, mimeType: GOOGLE_DOC_EXPORT[mimeType] },
        { responseType: 'text' }
      );
      body = String(res.data ?? '');
    } else if (isExtractableBinary(mimeType)) {
      // PDF·docx·pptx·xlsx·image. 색인된 파일이면 Qdrant 청크 재조립(색인 시 추출·OCR 한 텍스트 재사용
      // → 재다운로드·재OCR 0)을 우선. 미색인이면 extract_text 파이프라인(pdf-parse·mammoth·Mathpix OCR 등).
      // 예전엔 바이너리를 String() 해 깨진 텍스트를 반환했다(검색 챗봇 PDF 읽기 실패의 원인).
      const reassembled = await reassembleFromIndex(fileId);
      if (reassembled && reassembled.trim()) {
        body = reassembled;
        extractMethod = 'index-reassembled';
      } else {
        if (tooLarge) return tooLargeError;
        const r = await extractText(drive, fileId, mimeType);
        if (r.needsOcr || !r.text.trim()) {
          return {
            fileId,
            error: `본문 추출 불가/미지원입니다 (mimeType=${mimeType}). 스캔 품질이 낮거나 지원하지 않는 형식일 수 있습니다.`,
          };
        }
        body = r.text;
        extractMethod = r.method;
      }
    } else {
      if (tooLarge) return tooLargeError;
      const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
      body = String(res.data ?? '');
    }

    let truncated = false;
    if (body.length > maxChars) {
      body = body.slice(0, maxChars);
      truncated = true;
    }

    return {
      meta: {
        id: m.id,
        name: m.name,
        mimeType: m.mimeType,
        size: m.size,
        modifiedTime: m.modifiedTime,
        viewUrl: m.webViewLink,
        ...(extractMethod ? { extractMethod } : {}),
      },
      truncated,
      charCount: body.length,
      body,
    };
  } catch (e: unknown) {
    return { fileId, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function handleReadDriveFile(args: z.infer<typeof inputSchema>) {
  const auth = getAuth();
  const { fileId, fileIds, maxChars } = args;
  const drive = await getDriveClient();
  const folderScope = allowedDriveFolders(auth);

  // 배치: fileIds 면 병렬 read (per-call floor 1회 + Drive I/O 동시).
  if (fileIds && fileIds.length > 0) {
    const files = await Promise.all(
      fileIds.map((id) => readOne(drive, id, maxChars, folderScope)),
    );
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ count: files.length, files }, null, 2) },
      ],
    };
  }

  // 단일 (하위호환): 기존 응답 형식 유지.
  const result = await readOne(drive, fileId!, maxChars, folderScope);
  if ('error' in result) {
    return { content: [{ type: 'text' as const, text: `[error] ${result.error}` }], isError: true };
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}
