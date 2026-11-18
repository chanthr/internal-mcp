/**
 * read_document: more of a document found by search_knowledge.
 *
 * Three ways to read, cheapest first, because what comes back is paid for in the reader's context:
 *   part      the passage a search returned and the parts around it, put back together from the index
 *   offset    the next stretch of a long document, where the last read stopped
 *   (neither) the document from its start, up to maxChars
 *
 * A Document ID that starts with "local:" names a file in a configured local folder. Anything else is a Drive file
 * id and is read through the Drive plugin's own reader, with all of its checks (shared by a trusted owner, not in
 * an excluded folder, inside the caller's folder scope).
 *
 * A local id is resolved back to a file and must still be inside its folder (folders.ts). Excluded folder names and
 * the caller's folder scope apply to local documents the same way they apply to Drive documents. Parts are read
 * from the index under the checks search_knowledge applies to the passages it shows, so reading around a passage
 * shows nothing a search could not.
 *
 * The answer is plain text with a short head. (As JSON, every line break and quote of the document was escaped:
 * more to read, and harder to read.)
 */
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { defineTool } from '../../../plugin/define.js';
import { getAuth } from '../../../core/context.js';
import { allowedDriveFolders, isPathInScope } from '../../../core/scope.js';
import { isExcludedPath } from '../../drive/exclude.js';
import { extractLocalFile } from '../../drive/extract_text.js';
import { joinChunks } from '../../drive/chunk_join.js';
import { indexedChunks, readOne as readDriveFile, reassembleFromIndex } from '../../drive/tools/read_drive_file.js';
import { isLocalId, resolveLocalId } from '../folders.js';

const DESCRIPTION =
  'Read more of a document found by search_knowledge, by its ID. ' +
  'With part (the number a result shows) it returns that passage and the parts around it: the cheap way to get context. ' +
  'Without part it returns the document from the start, up to maxChars, and says which offset continues it.';

const DEFAULT_MAX_CHARS = 20_000;

const inputSchema = z
  .object({
    documentId: z.string().min(1).optional().describe('An ID from search_knowledge.'),
    documentIds: z.array(z.string().min(1)).min(1).max(10).optional().describe('Several IDs in one call (1-10), each read from its start.'),
    part: z.number().int().min(1).optional().describe('Read around this part ("part N of M" in a search result).'),
    around: z.number().int().min(0).max(10).default(1).describe('With part: parts before and after it to include (default 1).'),
    offset: z.number().int().min(0).default(0).describe('Start at this character, to continue a document that was cut.'),
    maxChars: z.number().int().min(1000).max(200000).default(DEFAULT_MAX_CHARS).describe(`Most characters returned per document (default ${DEFAULT_MAX_CHARS}).`),
  })
  .refine((d) => d.documentId || (d.documentIds && d.documentIds.length > 0), { message: 'documentId or documentIds is required' })
  .refine((d) => d.part === undefined || (d.documentId && !d.documentIds), { message: 'part works with one documentId' });

/** One document as read, or why it could not be. */
type Read = { id: string; name: string; modified?: string; body: string; total?: number; note?: string } | { id: string; error: string };

const NOT_FOUND = '[not found] No readable document with this id. Use an id from a search_knowledge result.';
const day = (iso: string | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined);
const count = (n: number) => n.toLocaleString('en-US');

/** A stretch of a text, with the head line that says which stretch and how to go on. */
function stretch(id: string, name: string, modified: string | undefined, text: string, offset: number, maxChars: number, more = false): Read {
  if (offset > 0 && offset >= text.length) return { id, error: `offset ${offset} is past the end of this document (${count(text.length)} characters).` };
  const body = text.slice(offset, offset + maxChars);
  const end = offset + body.length;
  const cut = end < text.length || more;
  const note =
    offset === 0 && !cut
      ? `${count(text.length)} characters, the whole document`
      : `characters ${count(offset)}-${count(end)}${more ? '' : ` of ${count(text.length)}`}${cut ? ` · continue with offset=${end}` : ' · the end of the document'}`;
  return { id, name, modified, body, note };
}

/** The parts around `part`, from the index. Under the checks a search applies to what it shows. */
async function readParts(id: string, part: number, around: number, folderScope: string[] | null): Promise<Read> {
  const chunks = await indexedChunks(id);
  const path = String(chunks[0]?.payload.file_path ?? '');
  if (chunks.length === 0 || isExcludedPath(path) || !isPathInScope(path, folderScope)) return { id, error: NOT_FOUND };
  const total = chunks.length;
  if (part > total) return { id, error: `This document has ${total} part${total === 1 ? '' : 's'}; part ${part} does not exist.` };
  const from = Math.max(1, part - around);
  const to = Math.min(total, part + around);
  const picked = chunks.slice(from - 1, to);
  const first = picked[0].payload;
  return {
    id,
    name: String(first.file_name ?? id),
    modified: day(typeof first.modified_time === 'string' ? first.modified_time : undefined),
    body: joinChunks(picked.map((c) => c.content)),
    note: `part${from === to ? ` ${from}` : `s ${from}-${to}`} of ${total}${to < total ? ` · the next is part ${to + 1}` : ' · the end of the document'}`,
  };
}

async function readLocal(id: string, offset: number, maxChars: number, folderScope: string[] | null): Promise<Read> {
  const file = await resolveLocalId(id);
  // One message for "does not exist", "outside the folder" and "outside your permissions": the caller learns
  // nothing about files it may not see.
  if (!file || isExcludedPath(file.path) || !isPathInScope(file.path, folderScope)) return { id, error: NOT_FOUND };
  try {
    let text: string;
    if (file.mimeType === 'text/markdown' || file.mimeType === 'text/plain') {
      text = await readFile(file.abs, 'utf8');
    } else {
      // PDF and Office files: reuse the text extracted at indexing time, otherwise extract now.
      const indexed = await reassembleFromIndex(id);
      if (indexed && indexed.trim()) text = indexed;
      else {
        const r = await extractLocalFile(file.abs, file.mimeType);
        if (r.needsOcr || !r.text.trim()) return { id, error: 'This file has no text layer (a scan or an image), so there is nothing to read.' };
        text = r.text;
      }
    }
    return stretch(id, file.name, day(file.modifiedTime), text, offset, maxChars);
  } catch (e) {
    return { id, error: e instanceof Error ? e.message : String(e) };
  }
}

async function readAny(id: string, offset: number, maxChars: number, folderScope: string[] | null): Promise<Read> {
  if (isLocalId(id)) return readLocal(id, offset, maxChars, folderScope);
  const { driveConfigured } = await import('../../drive/index.js');
  if (!driveConfigured()) return { id, error: NOT_FOUND };
  const { getDriveClient } = await import('../../drive/client.js');
  // The Drive reader cuts at the length it is given: ask for enough to reach the end of the stretch.
  const r = await readDriveFile(await getDriveClient(), id, offset + maxChars, folderScope);
  if ('error' in r) return { id, error: String(r.error) };
  return stretch(id, String(r.meta?.name ?? id), day(r.meta?.modifiedTime ?? undefined), String(r.body ?? ''), offset, maxChars, r.truncated === true);
}

function render(r: Read): string {
  if ('error' in r) return `# ${r.id}\n[error] ${r.error}`;
  return `# ${r.name}\nID: \`${r.id}\`${r.modified ? ` · modified ${r.modified}` : ''} · ${r.note}\n\n${r.body}`;
}

export async function handleReadDocument(args: z.infer<typeof inputSchema>) {
  const { documentId, documentIds, part, around = 1, offset = 0, maxChars = DEFAULT_MAX_CHARS } = args;
  const folderScope = allowedDriveFolders(getAuth());
  if (documentIds && documentIds.length > 0) {
    const documents = await Promise.all(documentIds.map((id) => readAny(id, 0, maxChars, folderScope)));
    return { content: [{ type: 'text' as const, text: documents.map(render).join('\n\n---\n\n') }] };
  }
  const result = part !== undefined ? await readParts(documentId!, part, around, folderScope) : await readAny(documentId!, offset, maxChars, folderScope);
  if ('error' in result) return { content: [{ type: 'text' as const, text: `[error] ${result.error}` }], isError: true };
  return { content: [{ type: 'text' as const, text: render(result) }] };
}

export const readDocumentTool = defineTool({
  name: 'read_document',
  description: DESCRIPTION,
  input: inputSchema,
  annotations: { readOnlyHint: true },
  run: (args) => handleReadDocument(args),
});
