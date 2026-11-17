/**
 * read_drive_file(fileId | fileIds, maxChars?): reads the content of a Drive file.
 *
 * Markdown / text are read as raw media. Google Docs/Sheets/Slides are exported.
 *
 * Batch: fileIds reads several files at once, in **parallel**.
 *   Sequential calls (one MCP round trip + 2 Drive API calls per file) are merged into one call, which cuts the per-call
 *   network floor from N to 1 and runs Drive I/O concurrently. Essential when comparing or summarizing several sources.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { getDriveClient } from '../client.js';
import { getAuth } from '../../../core/context.js';
import { allowedDriveFolders, isPathInScope } from '../../../core/scope.js';
import { classifyAndPath, isReadableClass, ownerEmails } from '../path.js';
import { stripEmbeddedImages } from '../clean_text.js';
import { extractText } from '../extract_text.js';
import { getQdrantClient, DRIVE_COLLECTION } from '../qdrant.js';
import { MAX_FILE_BYTES } from '../settings.js';

const DESCRIPTION =
  'Reads the content of a Google Drive file. markdown/text is returned raw, Google Docs/Sheets/Slides are exported, ' +
  '**PDF, Word (docx), PowerPoint (pptx), Excel (xlsx), and images are extracted to text** (scanned PDFs and images use OCR). ' +
  'Use the id (File ID) from search_drive or list_drive_folder results. ' +
  '**To read several documents, do not call once per fileId; pass fileIds=[...] in one call (parallel, much faster than sequential).** ' +
  'Large files are truncated to maxChars.';

const inputSchema = z
  .object({
    fileId: z.string().min(1).optional().describe('Drive file ID (one). Use either this or fileIds.'),
    fileIds: z
      .array(z.string().min(1))
      .min(1)
      .max(10)
      .optional()
      .describe('Read several Drive file IDs in parallel in one call (1~10). Much faster than sequential calls. Use either this or fileId.'),
    maxChars: z.number().int().min(1000).max(200000).default(50000).describe('Max characters returned per file (1000-200000). default 50000.'),
  })
  .refine((d) => d.fileId || (d.fileIds && d.fileIds.length > 0), {
    message: 'One of fileId or fileIds is required',
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
  'application/vnd.google-apps.presentation': 'text/plain',
};

/** Binary formats that break when read as raw text. Their content must be extracted through the extract_text pipeline. */
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
 * For an indexed file, restores the original text by reassembling its Qdrant chunks in chunk_index order. It reuses the
 * text already extracted at indexing time (OCR for scans), so re-download and re-OCR cost is 0 (a scanned PDF does not go
 * through Mathpix again on every read).
 * Returns null when the file is not indexed or the lookup fails (→ extract_text fallback). The chunk overlap prefix ("…")
 * is removed on a best-effort basis.
 */
export async function reassembleFromIndex(fileId: string): Promise<string | null> {
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
        const nl = c.content.indexOf('\n\n'); // strip the overlap prefix (…tail\n\n)
        return nl >= 0 ? c.content.slice(nl + 2) : c.content;
      })
      .join('\n\n');
  } catch {
    return null;
  }
}

type DriveClient = Awaited<ReturnType<typeof getDriveClient>>;

/** Reads one file → a structured object (returns an error field instead of throwing, to isolate per-file errors in a batch). */
export async function readOne(
  drive: DriveClient,
  fileId: string,
  maxChars: number,
  folderScope: string[] | null,
) {
  try {
    const meta = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType, parents, size, modifiedTime, webViewLink, owners(emailAddress), driveId',
      supportsAllDrives: true, // without this flag, files on a shared drive return 404
    });
    const m = meta.data;
    const mimeType = m.mimeType || '';

    if (mimeType === 'application/vnd.google-apps.folder') {
      return { fileId, error: 'fileId is a folder. use list_drive_folder instead.' };
    }

    // Security: under the dev/biz root + not passing through an excluded folder (PII, contracts, HR, deprecated) + the
    // per-user folder scope.
    // Same guard as search_drive / search_knowledge. It blocks the bypass of entering an arbitrary File ID directly
    // to read files outside the index, in sensitive folders or outside the user's permissions.
    const { cls, path } = await classifyAndPath(drive, m.parents ?? undefined, { owners: ownerEmails(m), driveId: m.driveId });
    if (!isReadableClass(cls) || !isPathInScope(path, folderScope)) {
      return {
        fileId,
        error: '[forbidden] This file is outside the allowed scope (not shared with this server / sensitive folder / outside your permissions).',
      };
    }

    // Size cap: the file is loaded into memory whole, so this keeps a huge file (video, large PDF) from killing the server.
    // If a reassembled copy exists in the index, read that instead (no re-download). Google documents have no size, so the
    // cap does not apply to them.
    const tooLarge = !!m.size && Number(m.size) > MAX_FILE_BYTES;
    const tooLargeError = {
      fileId,
      error: `File is too large to read (${m.size}B > ${MAX_FILE_BYTES}B, DRIVE_MAX_FILE_BYTES).`,
    };

    let body: string;
    let extractMethod: string | undefined;
    if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      // Every tab, not just the first (see extract_text.ts).
      const r = await extractText(drive, fileId, mimeType);
      body = r.text;
      extractMethod = r.method;
    } else if (GOOGLE_DOC_EXPORT[mimeType]) {
      const res = await drive.files.export(
        { fileId, mimeType: GOOGLE_DOC_EXPORT[mimeType] },
        { responseType: 'text' }
      );
      body = String(res.data ?? '');
      // A Google Doc exported as Markdown carries its pictures as base64 at the end. In a picture-heavy document that
      // is many times the text, so maxChars would be spent on picture data or cut the text short.
      if (mimeType === 'application/vnd.google-apps.document') body = stripEmbeddedImages(body);
    } else if (isExtractableBinary(mimeType)) {
      // PDF, docx, pptx, xlsx, image. For an indexed file, prefer reassembling the Qdrant chunks (reuses the text extracted and
      // OCRed at indexing time → 0 re-downloads, 0 re-OCR). If not indexed, use the extract_text pipeline (pdf-parse, ooxml,
      // Mathpix OCR etc.).
      // Previously the binary was passed through String() and garbled text was returned, which made PDF reads fail.
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
            error: r.method.includes('OCR off')
              ? `No text layer (mimeType=${mimeType}). Scanned PDFs and images need OCR: set MATHPIX_APP_ID and MATHPIX_APP_KEY.`
              : `Could not extract text (mimeType=${mimeType}). The format may be unsupported or the scan unreadable.`,
          };
        }
        body = r.text;
        extractMethod = r.method;
      }
    } else {
      if (tooLarge) return tooLargeError;
      const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'text' });
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

  // Batch: with fileIds, read in parallel (one per-call floor + concurrent Drive I/O).
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

  // Single (backward compatible): keeps the original response format.
  const result = await readOne(drive, fileId!, maxChars, folderScope);
  if ('error' in result) {
    return { content: [{ type: 'text' as const, text: `[error] ${result.error}` }], isError: true };
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}
