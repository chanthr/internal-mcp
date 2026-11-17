/**
 * read_document: the whole text of a document found by search_knowledge.
 *
 * A Document ID that starts with "local:" names a file in a configured local folder. Anything else is a Drive file
 * id and is read through the Drive plugin's own reader, with all of its checks (shared by a trusted owner, not in
 * an excluded folder, inside the caller's folder scope).
 *
 * A local id is resolved back to a file and must still be inside its folder (folders.ts). Excluded folder names and
 * the caller's folder scope apply to local documents the same way they apply to Drive documents.
 */
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { defineTool } from '../../../plugin/define.js';
import { getAuth } from '../../../core/context.js';
import { allowedDriveFolders, isPathInScope } from '../../../core/scope.js';
import { isExcludedPath } from '../../drive/exclude.js';
import { extractLocalFile } from '../../drive/extract_text.js';
import { readOne as readDriveFile, reassembleFromIndex } from '../../drive/tools/read_drive_file.js';
import { isLocalId, resolveLocalId } from '../folders.js';

const DESCRIPTION =
  'Read the whole text of a document from the knowledge base. Pass the Document ID from a search_knowledge result. ' +
  'Use it when a passage is not enough: to see the surrounding context, exact figures, or the full procedure. ' +
  'To read several documents pass documentIds=[...] in one call (parallel). Long documents are cut at maxChars.';

const inputSchema = z
  .object({
    documentId: z.string().min(1).optional().describe('A Document ID from search_knowledge. Use either this or documentIds.'),
    documentIds: z.array(z.string().min(1)).min(1).max(10).optional().describe('Several Document IDs read in one call (1-10).'),
    maxChars: z.number().int().min(1000).max(200000).default(50000).describe('Maximum characters returned per document (1000-200000, default 50000).'),
  })
  .refine((d) => d.documentId || (d.documentIds && d.documentIds.length > 0), { message: 'documentId or documentIds is required' });

type ReadResult = Awaited<ReturnType<typeof readDriveFile>>;

async function readLocal(id: string, maxChars: number, folderScope: string[] | null): Promise<ReadResult> {
  const file = await resolveLocalId(id);
  // One message for "does not exist", "outside the folder" and "outside your permissions": the caller learns
  // nothing about files it may not see.
  const denied = { fileId: id, error: '[not found] No readable document with this id. Use an id from a search_knowledge result.' };
  if (!file || isExcludedPath(file.path) || !isPathInScope(file.path, folderScope)) return denied;
  try {
    let body: string;
    let extractMethod: string;
    if (file.mimeType === 'text/markdown' || file.mimeType === 'text/plain') {
      body = await readFile(file.abs, 'utf8');
      extractMethod = 'file';
    } else {
      // PDF and Office files: reuse the text extracted at indexing time, otherwise extract now.
      const indexed = await reassembleFromIndex(id);
      if (indexed && indexed.trim()) {
        body = indexed;
        extractMethod = 'index-reassembled';
      } else {
        const r = await extractLocalFile(file.abs, file.mimeType);
        if (r.needsOcr || !r.text.trim()) return { fileId: id, error: 'This file has no text layer (a scan or an image), so there is nothing to read.' };
        body = r.text;
        extractMethod = r.method;
      }
    }
    const truncated = body.length > maxChars;
    if (truncated) body = body.slice(0, maxChars);
    return {
      meta: { id, name: file.name, mimeType: file.mimeType, size: String(file.size), modifiedTime: file.modifiedTime, viewUrl: undefined, path: file.path, extractMethod },
      truncated,
      charCount: body.length,
      body,
    } as unknown as ReadResult;
  } catch (e) {
    return { fileId: id, error: e instanceof Error ? e.message : String(e) };
  }
}

async function readAny(id: string, maxChars: number, folderScope: string[] | null): Promise<ReadResult> {
  if (isLocalId(id)) return readLocal(id, maxChars, folderScope);
  const { driveConfigured } = await import('../../drive/index.js');
  if (!driveConfigured()) return { fileId: id, error: '[not found] No readable document with this id. Use an id from a search_knowledge result.' };
  const { getDriveClient } = await import('../../drive/client.js');
  return readDriveFile(await getDriveClient(), id, maxChars, folderScope);
}

export async function handleReadDocument(args: z.infer<typeof inputSchema>) {
  const { documentId, documentIds, maxChars } = args;
  const folderScope = allowedDriveFolders(getAuth());
  if (documentIds && documentIds.length > 0) {
    const documents = await Promise.all(documentIds.map((id) => readAny(id, maxChars, folderScope)));
    return { content: [{ type: 'text' as const, text: JSON.stringify({ count: documents.length, documents }, null, 2) }] };
  }
  const result = await readAny(documentId!, maxChars, folderScope);
  if ('error' in result) return { content: [{ type: 'text' as const, text: `[error] ${result.error}` }], isError: true };
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}

export const readDocumentTool = defineTool({
  name: 'read_document',
  description: DESCRIPTION,
  input: inputSchema,
  annotations: { readOnlyHint: true },
  run: (args) => handleReadDocument(args),
});
