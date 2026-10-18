/** Test plugin: no env, three tools covering text, JSON, errors and state. */
import { definePlugin, defineTool, ToolError } from '../../../src/plugin/define.js';
import { z } from 'zod';

export default definePlugin({
  id: 'echo',
  description: 'test plugin',
  instructions: 'Echo: echo_text repeats text.',
  tools: [
    defineTool({
      name: 'echo_text',
      description: 'Repeat the text',
      input: z.object({ text: z.string().min(1).describe('Text to repeat'), times: z.number().int().min(1).max(3).default(1) }),
      run: ({ text, times }, ctx) => `${Array(times).fill(text).join(' ')} (${ctx.user.role})`,
    }),
    defineTool({
      name: 'echo_count',
      description: 'Count calls (plugin state)',
      run: async (_input, ctx) => {
        const n = ((await ctx.state.get<number>('n')) ?? 0) + 1;
        await ctx.state.set('n', n);
        return { n, by: ctx.user.email ?? null };
      },
    }),
    defineTool({
      name: 'echo_fail',
      description: 'Always fails with a ToolError',
      run: () => {
        throw new ToolError('expected failure');
      },
    }),
  ],
});
