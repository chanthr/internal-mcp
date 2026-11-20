/**
 * find_documents: a question → the documents that answer it, found by the search assistant (../agent_search.ts),
 * best first, each with what it holds.
 *
 * For the questions one search does not settle: several parts, or other words than the documents use. Slower than
 * search_knowledge (the connected model searches several times), so search_knowledge stays the first call. Only
 * listed while a model is connected for it (the search model, or the language model).
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import type { AuthContext } from '../../../core/auth.js';
import { LlmError, searchLlmSettings } from '../../../core/llm.js';
import { agentSearch, EFFORTS, type AgentSearch } from '../agent_search.js';
import { isLocalId } from '../folders.js';

const DESCRIPTION =
  'Hand a question to a search assistant (the language model connected to this server): it searches several times ' +
  'with different words, reads where needed, and returns the documents that answer the question, best first, each ' +
  'with what it holds. It does not answer the question: read the documents with read_document. ' +
  'Slower than search_knowledge: use it when a question has several parts, or search_knowledge did not find it.';

const inputSchema = z.object({
  question: z.string().min(1).max(1000).describe('The question, as asked.'),
  effort: z
    .enum(EFFORTS as [string, ...string[]])
    .optional()
    .default('medium')
    .describe('low: a few searches. medium (default). high: the question is split into its parts, each searched by its own assistant at once.'),
  limit: z.number().int().min(1).max(20).optional().default(8).describe('Most documents to return (1-20, default 8).'),
});

const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} s`;

/**
 * The model it uses is the server's, paid for by whoever runs the server, and every person who may search may
 * call it. So one person has at most this many questions at once, and this many in an hour.
 */
const AT_ONCE_EACH = 2;
const PER_HOUR_EACH = 60;
const callers = new Map<string, { running: number; times: number[] }>();
/** A place for this caller, or why there is none. Released by the function it returns. */
function take(auth: AuthContext): { release: () => void } | { refused: string } {
  const who = auth.key_id ?? auth.email ?? 'anyone';
  const c = callers.get(who) ?? { running: 0, times: [] };
  const now = Date.now();
  c.times = c.times.filter((t) => now - t < 3_600_000);
  if (c.running >= AT_ONCE_EACH) return { refused: `You have ${AT_ONCE_EACH} questions with the search assistant already. Wait for one to finish.` };
  if (c.times.length >= PER_HOUR_EACH) return { refused: `You have asked the search assistant ${PER_HOUR_EACH} questions in the last hour, the most one person may. search_knowledge still works.` };
  c.running++;
  c.times.push(now);
  callers.set(who, c);
  return { release: () => void (c.running = Math.max(0, c.running - 1)) };
}

/** The result as the asking model reads it. Exported for tests. */
export function render(r: AgentSearch): string {
  const how =
    `${r.agents > 1 ? `${r.agents} assistants at once (${r.parts.map((p) => `"${p}"`).join(', ')}), ` : ''}` +
    `${r.searches} search${r.searches === 1 ? '' : 'es'}, ${r.reads} read${r.reads === 1 ? '' : 's'}, ${r.seen} document${r.seen === 1 ? '' : 's'} looked at, ${seconds(r.ms)}`;
  const lines = [`# Documents for "${r.question}"`];
  if (r.documents.length === 0) {
    lines.push(`The search assistant (${r.model}) found no document that answers this (${how}). The documents may not cover it; say so rather than guess.`);
    if (r.note) lines.push(`> ${r.note}`);
    return lines.join('\n');
  }
  const judged = r.documents.filter((d) => d.reported).length;
  lines.push(
    `${r.documents.length} document${r.documents.length === 1 ? '' : 's'}, ${judged === r.documents.length ? 'all' : judged || 'none'} judged to answer, found by ${r.model}: ${how}. ` +
      'Read them with read_document (the ID, and the part where one is given). "Holds" is the assistant\'s summary, written from the documents: check it against them.',
  );
  if (r.note) lines.push(`> ${r.note}`);
  r.documents.forEach((d, i) => {
    lines.push('', `${i + 1}. ${d.name}${d.date ? ` — ${d.date}` : ''}`);
    lines.push(`   ID: \`${d.id}\`${d.part ? ` · part ${d.part}` : ''}`);
    if (!isLocalId(d.id)) lines.push(`   Path: \`${d.path}\``);
    lines.push(d.reported ? `   Holds: ${d.why || '(no note)'}` : '   Not judged: shown by its searches');
  });
  return lines.join('\n');
}

export const findDocumentsTool = defineTool({
  name: 'find_documents',
  description: DESCRIPTION,
  input: inputSchema,
  annotations: { readOnlyHint: true },
  enabled: () => searchLlmSettings() !== null || 'connect a language model on the Models page',
  run: async (args, ctx) => {
    const place = take(ctx.auth);
    if ('refused' in place) return { content: [{ type: 'text' as const, text: `[error] ${place.refused}` }], isError: true };
    let steps = 0;
    try {
      const r = await agentSearch(args.question, {
        effort: args.effort as AgentSearch['effort'],
        limit: args.limit,
        signal: ctx.signal,
        onStep: (s) => ctx.progress?.(++steps, s.tool === 'search' ? `searched for "${String(s.input.query ?? '').slice(0, 80)}"` : s.tool === 'read' ? 'read a document' : 'reported'),
      });
      return { content: [{ type: 'text' as const, text: render(r) }] };
    } catch (e) {
      const said = e instanceof Error ? e.message : String(e);
      ctx.log(`find_documents: ${said}`);
      // What went wrong at the model (its address, a provider's words) is for the owner. Others hear that it failed.
      const message = ctx.user.role === 'admin' ? (e instanceof LlmError ? said : `The search assistant stopped: ${said}`) : 'The search assistant could not search right now.';
      return { content: [{ type: 'text' as const, text: `[error] ${message} search_knowledge still works without it.` }], isError: true };
    } finally {
      place.release();
    }
  },
});
