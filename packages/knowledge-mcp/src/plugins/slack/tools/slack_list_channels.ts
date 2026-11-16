/**
 * slack_list_channels(enabledOnly?): returns the Slack channel map (purpose mapping) and syncs it automatically.
 *
 * Data: the `slack_channels` store (purpose mapping, single source: a SQLite file or Supabase)
 *       joined with Slack `conversations.list` (live channels and membership).
 *
 * Automatic sync (lazy, on call. Writes only when something changed):
 *   - existing channel renamed → update channel_name (matching is by channel_id, so a rename does not break it)
 *   - row without channel_id   → match by name and backfill channel_id (settles once, the first time)
 *   - new channel              → added with enabled=false (exposed once a person fills in purpose and enables it
 *                                with the `knowledge-mcp slack channel` command or in the Supabase table)
 * bot_can_read is also decided by channel_id, so it survives renames.
 *
 * For Slack questions, a bot or assistant calls this tool first to learn which channel is for what and whether the bot
 * can read it (bot_can_read), then targets slack_search (in:#channel) or slack_read_channel. Both tools return only
 * channels the bot is a member of.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { getAuth } from '../../../core/context.js';
import { allowedSlackChannels } from '../../../core/scope.js';
import { getStore, type Store } from '../../../store/index.js';
import type { SlackChannelRow } from '../../../store/types.js';
import { slackApi } from '../api.js';

const inputSchema = z.object({
  enabledOnly: z
    .boolean()
    .default(true)
    .describe('true (default) returns active channels only. false also includes inactive ones (including new, uncategorized channels).'),
});

export const slackListChannelsTool = defineTool({
  name: 'slack_list_channels',
  description:
    'Returns the Slack channel landscape — each channel purpose and whether the bot can read it (bot_can_read). ' +
    'Call this first for any Slack question to decide which channel to search or read. ' +
    'bot_can_read=true means slack_read_channel and slack_search can read it; false means the bot must be invited to that channel before it can be read or searched. ' +
    'Each call syncs with the actual Slack channels (renames and new channels are picked up). The purpose mapping is managed in slack_channels in the server store.',
  input: inputSchema,
  run: (args) => handleSlackListChannels(args),
});

// ── Response TTL cache ──
// On every call this tool runs conversations.list (Slack), a sync write and a DB read.
// When several users ask Slack questions at once the same work repeats, so the final response is cached with a short TTL.
// (Channel additions and renames show up at most TTL seconds late, which is acceptable for a lazy sync.)
const LIST_CACHE_TTL_MS = Number(process.env.SLACK_LIST_CACHE_TTL_MS ?? 60_000);
const _listCache = new Map<string, { text: string; expiresAt: number }>();

type ChannelRow = SlackChannelRow;

interface LiveChannel {
  id: string;
  name: string;
  is_member: boolean;
}

/**
 * Syncs slack_channels with the conversations.list result (writes only what changed).
 * Graceful: on failure it does not throw and returns zero counts (the read still proceeds).
 */
async function syncChannels(
  store: Store,
  rows: ChannelRow[],
  live: LiveChannel[],
): Promise<{ inserted: number; renamed: number; linked: number }> {
  const byId = new Map<string, ChannelRow>();
  const byName = new Map<string, ChannelRow>();
  for (const r of rows) {
    if (r.channel_id) byId.set(r.channel_id, r);
    byName.set(r.channel_name, r);
  }

  const toInsert: Array<Omit<ChannelRow, 'id'>> = [];
  const toUpdate: { id: string; patch: Partial<ChannelRow> }[] = [];

  for (const c of live) {
    const hit = byId.get(c.id);
    if (hit) {
      // Channel already settled by id: update the name if it changed
      if (hit.channel_name !== c.name) toUpdate.push({ id: hit.id, patch: { channel_name: c.name } });
      continue;
    }
    const named = byName.get(c.name);
    if (named && !named.channel_id) {
      // Name matches but channel_id is not recorded: first backfill
      toUpdate.push({ id: named.id, patch: { channel_id: c.id } });
      continue;
    }
    if (!named) {
      // New channel not in the DB: add it disabled (exposed once a person fills in purpose)
      toInsert.push({ channel_id: c.id, channel_name: c.name, purpose: '', category: null, enabled: false, sort_order: 100 });
    }
  }

  let inserted = 0;
  let renamed = 0;
  let linked = 0;
  try {
    if (toInsert.length) {
      await store.insertSlackChannels(toInsert);
      inserted = toInsert.length;
    }
    for (const u of toUpdate) {
      await store.updateSlackChannel(u.id, u.patch);
      if ('channel_name' in u.patch) renamed++;
      else linked++;
    }
  } catch {
    /* the mapping read proceeds even if the sync fails */
  }
  return { inserted, renamed, linked };
}

export async function handleSlackListChannels(args: z.infer<typeof inputSchema>) {
  // Graceful wrapper so a network throw from the store read does not leak as [fatal]. The registry has already validated
  // the input.
  try {
    return await _handleSlackListChannels(args);
  } catch (e: unknown) {
    return {
      content: [{ type: 'text' as const, text: `[error] Temporary error while listing channels (${e instanceof Error ? e.message : String(e)}).` }],
      isError: true,
    };
  }
}

async function _handleSlackListChannels(args: z.infer<typeof inputSchema>) {
  const auth = getAuth();
  const { enabledOnly } = args;
  const channelScope = allowedSlackChannels(auth);

  // Cache hit: skip the Slack call, the sync and the DB read. Users with a scope skip the cache to avoid cache pollution.
  const cacheKey = enabledOnly ? 'enabled' : 'all';
  if (!channelScope) {
    const cached = _listCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { content: [{ type: 'text' as const, text: cached.text }] };
    }
  }

  const store = await getStore();

  // 1. Current mapping in the store (for sync comparison: all rows, regardless of enabled)
  let rows: ChannelRow[];
  try {
    rows = await store.listSlackChannels();
  } catch (e) {
    return {
      content: [{ type: 'text' as const, text: `[error] slack_channels lookup failed: ${e instanceof Error ? e.message : String(e)}` }],
      isError: true,
    };
  }

  // 2. Live channels (if Slack is unavailable, return the mapping only: graceful). Follow the cursor to the end: Slack may
  //    return fewer than limit along with a cursor, so reading only the first page marks later channels bot_can_read=false.
  const live: LiveChannel[] = [];
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 15; page++) {
      const r = await slackApi<{
        channels?: { id: string; name: string; is_member?: boolean }[];
        response_metadata?: { next_cursor?: string };
      }>(
        'conversations.list',
        { types: 'public_channel,private_channel', limit: 1000, exclude_archived: true, cursor },
        'bot',
      );
      for (const c of r.channels ?? []) {
        if (c.id && c.name) live.push({ id: c.id, name: c.name, is_member: !!c.is_member });
      }
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  } catch {
    /* the mapping is still returned on a Slack token or scope problem */
  }

  // 3. Automatic sync (only when live is non-empty, so an empty response cannot corrupt the DB)
  let synced = { inserted: 0, renamed: 0, linked: 0 };
  if (live.length > 0) {
    synced = await syncChannels(store, rows, live);
  }

  // 4. If the sync changed anything, re-read the updated rows
  let outRows = rows;
  if (synced.inserted || synced.renamed || synced.linked) {
    outRows = await store.listSlackChannels().catch(() => rows);
  }
  if (enabledOnly) outRows = outRows.filter((r) => r.enabled);
  // Per-user Slack channel scope (admin or unset = all). Based on channel_id.
  if (channelScope) outRows = outRows.filter((r) => r.channel_id && channelScope.has(r.channel_id));

  // 5. bot_can_read: based on channel_id (survives renames). Unlinked rows fall back to the name
  const liveById = new Map<string, boolean>();
  const liveByName = new Map<string, boolean>();
  for (const c of live) {
    liveById.set(c.id, c.is_member);
    liveByName.set(c.name, c.is_member);
  }

  const channels = outRows.map((r) => ({
    channel: `#${r.channel_name}`,
    purpose: r.purpose,
    category: r.category,
    bot_can_read: r.channel_id ? !!liveById.get(r.channel_id) : !!liveByName.get(r.channel_name),
    enabled: r.enabled,
  }));

  const syncNote =
    synced.inserted || synced.renamed || synced.linked
      ? ` (synced: ${synced.inserted} new, ${synced.renamed} renamed, ${synced.linked} id-linked)`
      : '';

  const text = JSON.stringify(
    {
      count: channels.length,
      note: 'bot_can_read=true → slack_read_channel / slack_search work. false → invite the bot first.' + syncNote,
      channels,
    },
    null,
    2,
  );
  // Cache only when the Slack response was healthy (an empty live may be a transient outage, so it is not cached and the
  // next call retries)
  if (live.length > 0 && !channelScope) {
    _listCache.set(cacheKey, { text, expiresAt: Date.now() + LIST_CACHE_TTL_MS });
  }

  return { content: [{ type: 'text' as const, text }] };
}
