/**
 * Example plugin — copy this file to add your own tools. Each file in src/plugins is one plugin.
 *
 * The plugin id ("notes") is also its permission group: admins see it, members see it unless their
 * allowed tools exclude it, and viewers see it only if config access.viewerTools lists it.
 */
import { definePlugin, defineTool, ToolError, z } from '@chanthr/knowledge-mcp';

type Note = { text: string; by: string; at: string };

export default definePlugin({
  id: 'notes',
  description: 'Shared team notes (example plugin)',
  // env: ['MY_API_KEY'],       // tools stay hidden until these env vars are set
  instructions: 'Notes: save short facts with notes_add, read them back with notes_list.',
  tools: [
    defineTool({
      name: 'notes_add',
      description: 'Save a short note for the team.',
      input: z.object({
        text: z.string().min(1).max(500).describe('The note'),
      }),
      run: async ({ text }, ctx) => {
        const notes = (await ctx.state.get<Note[]>('all')) ?? [];
        notes.push({ text, by: ctx.user.email ?? 'unknown', at: new Date().toISOString() });
        await ctx.state.set('all', notes.slice(-200));
        return `Saved. ${notes.length} notes in total.`;
      },
    }),
    defineTool({
      name: 'notes_list',
      description: 'List the saved team notes, newest first.',
      input: z.object({
        limit: z.number().int().min(1).max(50).default(10).describe('How many notes'),
      }),
      annotations: { readOnlyHint: true },
      run: async ({ limit }, ctx) => {
        const notes = (await ctx.state.get<Note[]>('all')) ?? [];
        if (!notes.length) throw new ToolError('No notes yet. Add one with notes_add.');
        return notes.slice(-limit).reverse(); // any JSON value is returned as pretty JSON
      },
    }),
  ],
});
