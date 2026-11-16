/**
 * slack_read_channel(channel, limit?, oldest?, includeThreads?): reads a channel's conversation.
 *
 * Recent messages via conversations.history, optionally with thread replies.
 * channel accepts a name (#dev / dev) or an ID (C…/G…). A name is resolved with conversations.list.
 * Uses the Bot token. Trust boundary = "channels the bot is a member of" (same as slack_search). DMs (D…) and group DMs
 * are not read (so a personal DM sent to the bot is not opened to other users).
 * Permission group: slack. Channel scope comes from app_users.allowed_slack_channels.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { getAuth } from '../../../core/context.js';
import { allowedSlackChannels } from '../../../core/scope.js';
import {
  slackApi,
  SlackError,
  loadSlackUserMap,
  loadChannelNameMap,
  loadBotMemberChannelIds,
  mapLimit,
} from '../api.js';

const DESCRIPTION =
  'Reads the recent conversation in a Slack channel. channel is a name (#dev) or an ID (C…). ' +
  '**By default it also fetches the thread replies of each message (includeThreads=true by default).** ' +
  'Slack discussions and decisions often live in thread replies, so ' +
  'reading only the top-level (parent) messages misses the context entirely; read the replies to see the actual conclusion. ' +
  'Turn it off with includeThreads=false only when you want to skim the top-level messages quickly. ' +
  'The bot must be a member of the channel to read it (private channels need an invite).';

const inputSchema = z.object({
  channel: z.string().min(1).describe('Channel name (#dev or dev) or ID (C…).'),
  limit: z.number().int().min(1).max(200).default(50).describe('Number of messages (1-200). default 50.'),
  oldest: z.string().optional().describe('Optional. Only messages after this point (YYYY-MM-DD or Unix ts).'),
  includeThreads: z
    .boolean()
    .default(true)
    .describe('Whether to include thread replies. **default true**: included by default because the replies hold the actual discussion. Set false to see only the parent messages quickly.'),
});

export const slackReadChannelTool = defineTool({
  name: 'slack_read_channel',
  description: DESCRIPTION,
  input: inputSchema,
  annotations: { readOnlyHint: true },
  run: (args) => handleSlackReadChannel(args),
});

interface SlackMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
}

/** YYYY-MM-DD → Unix epoch seconds. A value that is already a ts (digits.digits) is returned as is. */
function toOldestTs(oldest: string | undefined): string | undefined {
  if (!oldest) return undefined;
  if (/^\d+(\.\d+)?$/.test(oldest)) return oldest;
  const d = new Date(oldest);
  if (isNaN(d.getTime())) return undefined;
  return String(Math.floor(d.getTime() / 1000));
}

async function resolveChannelId(input: string): Promise<{ id: string; name: string | null }> {
  // Already in ID form (public C… / private G…). DMs (D…) are not accepted.
  if (/^D[A-Z0-9]{6,}$/.test(input)) throw new SlackError('DMs cannot be read.');
  if (/^[CG][A-Z0-9]{6,}$/.test(input)) return { id: input, name: null };
  const cleaned = input.replace(/^#/, '');
  // Look up the shared channel-name cache (TTL). Replaces the sequential conversations.list paging on every call with
  // 0 calls after warmup.
  const byName = await loadChannelNameMap();
  const found = byName.get(cleaned);
  if (found) return { id: found.id, name: found.name };
  throw new SlackError(`Channel "${input}" not found (the bot is not a member, or the name has a typo).`);
}

// user-map and mapLimit use the shared versions in api.ts (loadSlackUserMap, mapLimit). This removes per-tool duplicate
// implementations and split caches: read_channel reuses the cache warmed by search (and vice versa), and users.list round
// trips are effectively gone.

export async function handleSlackReadChannel(args: z.infer<typeof inputSchema>) {
  const auth = getAuth();
  const { channel, limit, oldest, includeThreads } = args;

  try {
    const { id: channelId, name: channelName } = await resolveChannelId(channel);
    // Trust boundary: only (public + private) channels the bot is a member of. Group DMs (G…) and DMs are not in
    // conversations.list, so they are caught here.
    const botMemberIds = await loadBotMemberChannelIds();
    if (!botMemberIds.has(channelId)) {
      return {
        content: [
          { type: 'text' as const, text: `[forbidden] The bot is not a member of channel '${channel}'. Invite the bot to the channel to read it.` },
        ],
        isError: true,
      };
    }
    // Per-user Slack channel scope check (admin or unset = all)
    const channelScope = allowedSlackChannels(auth);
    if (channelScope && !channelScope.has(channelId)) {
      return {
        content: [
          { type: 'text' as const, text: `[forbidden] Channel '${channel}' is not accessible with your current permissions.` },
        ],
        isError: true,
      };
    }
    // The user map (cached) and the channel history run in parallel, since they are independent. (Previously userMap ran
    // first, then history.)
    const [userMap, hist] = await Promise.all([
      loadSlackUserMap(),
      slackApi<{ messages?: SlackMessage[] }>(
        'conversations.history',
        { channel: channelId, limit, oldest: toOldestTs(oldest) },
        'bot',
      ),
    ]);
    const nameOf = (m: SlackMessage) =>
      m.user ? (userMap[m.user] ?? m.user) : (m.bot_id ? `bot:${m.bot_id}` : null);

    // Thread replies run in parallel with concurrency 6 (removes the sequential N+1). One failed thread is isolated so it
    // does not break the whole result.
    const messages = await mapLimit(hist.messages ?? [], 6, async (m) => {
      const hasThread = !!m.thread_ts && (m.reply_count ?? 0) > 0;
      const entry: any = {
        ts: m.ts,
        datetime: m.ts ? new Date(Number(m.ts) * 1000).toISOString() : null,
        user: nameOf(m),
        text: m.text ?? '',
      };
      // For a parent message, always expose the reply count. Even when expansion is off or fails, the "there are more replies"
      // signal remains.
      if (hasThread) entry.reply_count = m.reply_count;
      if (includeThreads && hasThread) {
        try {
          const rep = await slackApi<{ messages?: SlackMessage[] }>(
            'conversations.replies',
            { channel: channelId, ts: m.thread_ts, limit: 100 },
            'bot',
          );
          // replies[0] == the parent message → excluded
          entry.replies = (rep.messages ?? []).slice(1).map((r) => ({
            ts: r.ts,
            datetime: r.ts ? new Date(Number(r.ts) * 1000).toISOString() : null,
            user: nameOf(r),
            text: r.text ?? '',
          }));
        } catch {
          // One failed thread must not break the whole channel read. But do not hide it as an empty []: say so explicitly.
          // When replies could not be fetched (rate limit etc.), leave a signal so it is not mistaken for "0 replies".
          entry.replies = [];
          entry.replies_error = true;
        }
      }
      return entry;
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              channel: channelName ? `#${channelName}` : channelId,
              channelId,
              count: messages.length,
              includeThreads,
              messages,
            },
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
