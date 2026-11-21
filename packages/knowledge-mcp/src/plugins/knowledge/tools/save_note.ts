/**
 * save_note: keep something as a Markdown note in this knowledge base: study notes made from a document, a summary,
 * what an assistant found on the web. It is searched with the other documents within seconds.
 *
 * Where it goes (notes.ts): the console's chat writes into notes/, every other caller into inbox/<who>/, so what
 * other programs send can be told apart from the person's own notes. With `path` a note there is replaced. Nothing
 * else is ever written: the documents in the person's folders are not changed by this tool.
 *
 * Viewers may not write. One caller saves at most PER_HOUR notes an hour.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { CONSOLE_EMAIL } from '../../../core/context.js';
import type { AuthContext } from '../../../core/auth.js';
import { scanFoldersSoon } from '../folders.js';
import { INBOX, NOTES, saveNote } from '../notes.js';

const DESCRIPTION =
  'Save a note as a Markdown file in this knowledge base: notes made from documents, a summary, something to keep. ' +
  'It is searched with the other documents within seconds. Give it a title and the text in Markdown. ' +
  'To change a note saved before, call it again with the path its answer gave.';

const inputSchema = z.object({
  title: z.string().trim().min(1).max(200).describe('The title of the note.'),
  content: z.string().min(1).max(200_000).describe('The note, in Markdown.'),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional().describe('A few words to find it by.'),
  path: z.string().max(500).optional().describe('Replace the note at this path (as a save_note answer gave it).'),
});

const PER_HOUR = 60;
const saved = new Map<string, number[]>();
/** Who is writing: the person's whole email, else the key. Their folder under inbox/ is made from it (notes.ts fromName). As POST /inbox. */
const whoOf = (auth: AuthContext): string => auth.email ?? (auth.key_id ? `key-${auth.key_id.slice(0, 8)}` : 'local');

export const saveNoteTool = defineTool({
  name: 'save_note',
  description: DESCRIPTION,
  input: inputSchema,
  // It writes only into this server's note folders, but with path it replaces a note there (the earlier version is
  // kept in .versions/): a client that asks before such a call should ask.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  run: (args, ctx) => {
    if (ctx.user.role === 'viewer') return { content: [{ type: 'text' as const, text: '[error] A viewer may not save notes.' }], isError: true };
    const who = whoOf(ctx.auth);
    const now = Date.now();
    const times = (saved.get(who) ?? []).filter((t) => now - t < 3_600_000);
    if (times.length >= PER_HOUR) return { content: [{ type: 'text' as const, text: `[error] ${PER_HOUR} notes were saved in the last hour, the most one caller may.` }], isError: true };
    const fromConsole = ctx.auth.email === CONSOLE_EMAIL;
    try {
      const r = saveNote({ title: args.title, content: args.content, tags: args.tags, path: args.path, place: fromConsole ? NOTES : INBOX, from: who });
      saved.set(who, [...times, now]);
      // Read into the index now rather than at the next pass.
      void scanFoldersSoon().catch(() => undefined);
      return {
        content: [
          {
            type: 'text' as const,
            text: `${r.created ? 'Saved' : 'Replaced'}: ${r.shown}. It is searched with the other documents within seconds. To change it, call save_note with path "${r.path}".`,
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `[error] ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  },
});
