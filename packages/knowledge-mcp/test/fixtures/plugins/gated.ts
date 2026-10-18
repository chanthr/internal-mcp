/** Test plugin that stays off until KMCP_TEST_GATE is set. */
import { definePlugin, defineTool } from '../../../src/plugin/define.js';

export default definePlugin({
  id: 'gated',
  env: ['KMCP_TEST_GATE'],
  tools: [defineTool({ name: 'gated_hello', description: 'Hello when the gate env is set', run: () => 'hello' })],
});
