/**
 * slack_search(query, count?): searches messages in the Slack workspace.
 *
 * Uses the search.messages API, so a User token (xoxp-…, search:read scope) is required.
 * Permission group: slack. Results are filtered to channels the bot is a member of and to the user's channel scope.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { getAuth } from '../../../core/context.js';
import { allowedSlackChannels } from '../../../core/scope.js';
import {
  slackApi,
  SlackError,
  loadSlackUserMap,
  mapLimit,
  loadBotMemberChannelIds,
} from '../api.js';

const DESCRIPTION =
  'Search Slack workspace messages by keyword. Slack search operators are supported ' +
  '(e.g. "deploy in:#dev", "from:@alex decision", "release after:2026-01-01"). ' +
  'Use it together with Drive search when internal discussions or decisions live in Slack. ' +
  '**By default it searches every channel the bot is a member of** (public or private, every channel the bot was invited to). Do not narrow the channel first; search by keyword right away, and add in:#channel only to restrict to one channel. DMs and channels the bot was not invited to are excluded. ' +
  '**Search matches single messages only; the actual discussion and conclusion are often in the thread replies of that message.** ' +
  'By default (expandThreads=true), matches in channels the bot can read come with the surrounding thread context. ' +
  'thread_unavailable=true means more replies exist but the bot is not a member of that channel and could not read them; slack_read_channel is blocked too. ' +
  '**For questions where recency matters, such as "recent / latest status / newest progress / who said what", use sort="timestamp" (newest first).** Requires a User token.';

const inputSchema = z.object({
  query: z.string().min(1).describe('Search query. Supports Slack operators (in:, from:, after:, before:).'),
  count: z.number().int().min(1).max(50).default(20).describe('Max number of results (1-50). default 20.'),
  sort: z
    .enum(['score', 'timestamp'])
    .default('score')
    .describe('"score" (relevance, default) or "timestamp" (newest first). Use timestamp for questions about the latest discussion or status.'),
  expandThreads: z
    .boolean()
    .default(true)
    .describe('If a matching message is inside a thread, also fetch the surrounding replies. default true (keeps the discussion context). Set false for quick flat results only.'),
});

export const slackSearchTool = defineTool({
  name: 'slack_search',
  description: DESCRIPTION,
  input: inputSchema,
  annotations: { readOnlyHint: true },
  run: (args) => handleSlackSearch(args),
});

interface ThreadMsg {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
}

interface SlackSearchMatch {
  iid?: string;
  ts?: string;
  user?: string;
  username?: string;
  text?: string;
  channel?: {
    id?: string;
    name?: string;
    is_private?: boolean;
    is_group?: boolean;
    is_im?: boolean;
    is_mpim?: boolean;
  };
  permalink?: string;
}

/**
 * Search surface = "channels the bot is a member of", the same trust boundary as read_channel.
 *
 * search.messages runs with User token (xoxp) permissions, so it sees the token owner's personal DMs and private channels.
 * Exposing that as is would leak the token owner's private conversations, so results are limited to "channels the bot was
 * invited to" (a bot invite = a channel the team has allowed the assistant to read). Most channels are private, so the
 * earlier "public only" filter blocked nearly everything and search returned 0 results.
 *   - DMs (D…) and group DMs (mpim): not listed by conversations.list, so absent from botMemberIds → excluded.
 *   - Private channels the bot was not invited to: not permitted → excluded (read_channel cannot read them either).
 */
function isAllowedSearchMatch(m: SlackSearchMatch, botMemberIds: Set<string>): boolean {
  const c = m.channel;
  if (!c?.id) return false;
  if (c.is_im || c.is_mpim) return false; // defense in depth: DMs never appear in the search surface
  return botMemberIds.has(c.id);
}

export async function handleSlackSearch(args: z.infer<typeof inputSchema>) {
  const auth = getAuth();
  const { query, count, sort, expandThreads } = args;

  try {
    const res = await slackApi<{
      messages?: { total?: number; matches?: SlackSearchMatch[] };
    }>(
      'search.messages',
      { query, count, sort, highlight: false },
      'search',
    );

    // 1) Only channels the bot is a member of (drops DMs and private channels the bot was not invited to, which blocks the
    //    User token's personal visibility)
    // 2) Per-user Slack channel scope (admin or unset = all). Result messages are filtered to the allowed channels.
    const channelScope = allowedSlackChannels(auth);
    const botMemberIds = await loadBotMemberChannelIds();
    const matches = (res.messages?.matches ?? []).filter(
      (m) =>
        isAllowedSearchMatch(m, botMemberIds) &&
        (!channelScope || (m.channel?.id != null && channelScope.has(m.channel.id))),
    );
    const results = matches.map((m) => ({
      ts: m.ts,
      datetime: m.ts ? new Date(Number(m.ts) * 1000).toISOString() : null,
      user: m.username ?? m.user ?? null,
      channel: m.channel?.name ? `#${m.channel.name}` : (m.channel?.id ?? null),
      channelId: m.channel?.id ?? null,
      text: m.text ?? '',
      permalink: m.permalink ?? null,
    }));

    // search.messages returns single messages only. When the match is inside a thread, the surrounding replies are missing.
    // For channels the bot is a member of, fetch the whole thread with conversations.replies (ts = match ts) and attach it.
    // (Slack returns the whole thread for the ts of any message in it, parent or reply.)
    // In channels the bot is not in, this fails with not_in_channel etc. → only marked thread_unavailable (flat result kept).
    if (expandThreads && results.length > 0) {
      const userMap = await loadSlackUserMap();
      const nameOf = (t: ThreadMsg) =>
        t.user ? (userMap[t.user] ?? t.user) : t.bot_id ? `bot:${t.bot_id}` : null;
      const seenThreads = new Set<string>(); // channelId:rootTs, avoids expanding the same thread twice

      await mapLimit(results, 6, async (r) => {
        if (!r.channelId || !r.ts) return;
        try {
          const rep = await slackApi<{ messages?: ThreadMsg[] }>(
            'conversations.replies',
            { channel: r.channelId, ts: r.ts, limit: 100 },
            'bot',
          );
          const msgs = rep.messages ?? [];
          if (msgs.length <= 1) return; // not a thread (single message): no context to attach
          const rootTs = msgs[0]?.ts ?? r.ts;
          const key = `${r.channelId}:${rootTs}`;
          if (seenThreads.has(key)) {
            (r as any).thread_root_ts = rootTs; // thread already expanded from another match
            return;
          }
          seenThreads.add(key);
          (r as any).thread = msgs.map((t) => ({
            ts: t.ts,
            user: nameOf(t),
            text: t.text ?? '',
            is_match: t.ts === r.ts, // marks the exact message the search matched
          }));
        } catch {
          // The bot is not a channel member (not_in_channel) etc. → there may be more replies, but they cannot be read
          (r as any).thread_unavailable = true;
        }
      });
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            // total (Slack's raw count) is not included: it would reveal match counts from DMs and channels outside the user's
            // permissions.
            { query, count: results.length, results },
            null,
            2,
          ),
        },
      ],
    };
  } catch (e: unknown) {
    const msg = e instanceof SlackError ? e.message : e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: 'text' as const, text: `[error] ${msg}` }],
      isError: true,
    };
  }
}
