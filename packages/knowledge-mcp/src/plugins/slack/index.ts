/**
 * Slack plugin — read-only: channel map, channel history with threads, files, and message search.
 *
 *   SLACK_BOT_TOKEN  (xoxb-…)  every tool; the bot only sees channels it was invited to
 *   SLACK_USER_TOKEN (xoxp-…)  slack_search as well (results are limited to the bot's channels)
 * The two never stand in for each other — see api.ts.
 */
import { parseArgs } from 'node:util';
import { definePlugin } from '../../plugin/define.js';
import { getStore } from '../../store/index.js';
import { slackBotToken, slackUserToken } from './api.js';
import { slackListChannelsTool } from './tools/slack_list_channels.js';
import { slackReadChannelTool } from './tools/slack_read_channel.js';
import { slackFindFilesTool, slackGetFileTool } from './tools/slack_files.js';
import { slackSearchTool } from './tools/slack_search.js';

const BOT = 'set SLACK_BOT_TOKEN (xoxb-…)';

/** `knowledge-mcp slack channels` — the purpose map that slack_list_channels shows. */
async function listChannels(): Promise<void> {
  const rows = await (await getStore()).listSlackChannels();
  if (!rows.length) {
    console.error('No channels yet. Call slack_list_channels once (it syncs from Slack), then set purposes here.');
    return;
  }
  for (const r of rows) {
    process.stdout.write(
      `${r.enabled ? 'on ' : 'off'}  #${r.channel_name.padEnd(28)} ${(r.channel_id ?? '-').padEnd(12)} ${r.category ?? ''}  ${r.purpose}\n`,
    );
  }
}

/** `knowledge-mcp slack channel <#name|id> [--purpose P] [--category C] [--on|--off] [--order N]` */
async function editChannel(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      purpose: { type: 'string' },
      category: { type: 'string' },
      on: { type: 'boolean' },
      off: { type: 'boolean' },
      order: { type: 'string' },
    },
  });
  const target = positionals[0]?.replace(/^#/, '');
  if (!target) throw new Error('usage: knowledge-mcp slack channel <#name|id> [--purpose P] [--category C] [--on|--off] [--order N]');
  const store = await getStore();
  const row = (await store.listSlackChannels()).find((r) => r.channel_id === target || r.channel_name === target);
  if (!row) throw new Error(`channel ${target} is not in the map yet — call slack_list_channels once to sync it`);
  const patch: Record<string, unknown> = {};
  if (values.purpose !== undefined) patch.purpose = values.purpose;
  if (values.category !== undefined) patch.category = values.category || null;
  if (values.on) patch.enabled = true;
  if (values.off) patch.enabled = false;
  if (values.order !== undefined) patch.sort_order = Number(values.order);
  await store.updateSlackChannel(row.id, patch);
  console.error(`Updated #${row.channel_name}. slack_list_channels shows it within SLACK_LIST_CACHE_TTL_MS (default 60s).`);
}

export const slackPlugin = definePlugin({
  id: 'slack',
  description: 'Slack channels, threads, files and search (read-only)',
  enabled: () => !!slackBotToken() || BOT,
  tools: [
    slackListChannelsTool,
    slackReadChannelTool,
    slackFindFilesTool,
    slackGetFileTool,
    { ...slackSearchTool, enabled: () => !!slackUserToken() || 'set SLACK_USER_TOKEN (xoxp-…) for search' },
  ],
  instructions:
    'Slack: start with slack_list_channels to see which channels exist and which the bot can read; ' +
    'latest discussion → slack_search (sort="timestamp" for recency) or slack_read_channel.',
  commands: {
    channels: { description: 'list the channel purpose map', run: () => listChannels() },
    channel: { description: 'edit one channel: --purpose, --category, --on/--off, --order', run: (args) => editChannel(args) },
  },
});
