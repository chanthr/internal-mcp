/**
 * slack_read_channel(channel, limit?, oldest?, includeThreads?) — 채널 대화 읽기.
 *
 * conversations.history 로 최근 메시지, 옵션으로 thread replies 까지.
 * channel 은 이름(#dev / dev) 또는 ID(C…/G…) 허용 — 이름이면 conversations.list 로 resolve.
 * Bot token 사용. 신뢰 경계 = "봇이 멤버인 채널"(slack_search 와 동일). DM(D…)·그룹 DM 은 읽지 않는다
 * (봇에게 보낸 개인 DM 이 다른 사용자에게 열리는 것 방지).
 * 권한 그룹: slack. 채널 범위는 app_users.allowed_slack_channels.
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

/** YYYY-MM-DD → Unix epoch 초. 이미 ts(숫자.숫자)면 그대로. */
function toOldestTs(oldest: string | undefined): string | undefined {
  if (!oldest) return undefined;
  if (/^\d+(\.\d+)?$/.test(oldest)) return oldest;
  const d = new Date(oldest);
  if (isNaN(d.getTime())) return undefined;
  return String(Math.floor(d.getTime() / 1000));
}

async function resolveChannelId(input: string): Promise<{ id: string; name: string | null }> {
  // 이미 ID 형태 (공개 C… / 비공개 G…). DM(D…)은 받지 않는다.
  if (/^D[A-Z0-9]{6,}$/.test(input)) throw new SlackError('DMs cannot be read.');
  if (/^[CG][A-Z0-9]{6,}$/.test(input)) return { id: input, name: null };
  const cleaned = input.replace(/^#/, '');
  // 공용 채널명 캐시(TTL) 조회 — 매 호출 conversations.list 순차 순회를 warmup 후 0콜로.
  const byName = await loadChannelNameMap();
  const found = byName.get(cleaned);
  if (found) return { id: found.id, name: found.name };
  throw new SlackError(`Channel "${input}" not found (the bot is not a member, or the name has a typo).`);
}

// user-map·mapLimit 은 slack.ts 공용 버전(loadSlackUserMap·mapLimit) 사용 — 도구별 중복 구현·캐시
// 분절을 제거해, search 가 데운 캐시를 read_channel 이 재사용(반대도)하고 users.list 왕복이 실질 제거.

export async function handleSlackReadChannel(args: z.infer<typeof inputSchema>) {
  const auth = getAuth();
  const { channel, limit, oldest, includeThreads } = args;

  try {
    const { id: channelId, name: channelName } = await resolveChannelId(channel);
    // 신뢰 경계: 봇이 멤버인 (공개+비공개) 채널만. 그룹 DM(G…)·DM 은 conversations.list 에 없어 여기서 걸린다.
    const botMemberIds = await loadBotMemberChannelIds();
    if (!botMemberIds.has(channelId)) {
      return {
        content: [
          { type: 'text' as const, text: `[forbidden] The bot is not a member of channel '${channel}'. Invite the bot to the channel to read it.` },
        ],
        isError: true,
      };
    }
    // 직원별 Slack 채널 scope 체크 (admin·미설정 = 전체)
    const channelScope = allowedSlackChannels(auth);
    if (channelScope && !channelScope.has(channelId)) {
      return {
        content: [
          { type: 'text' as const, text: `[forbidden] Channel '${channel}' is not accessible with your current permissions.` },
        ],
        isError: true,
      };
    }
    // user map(캐시)과 채널 history 를 병렬 — 서로 독립. (예전엔 userMap 직렬 후 history)
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

    // thread replies 를 동시성 6 으로 병렬(순차 N+1 제거). thread 하나 실패가 전체를 안 깨게 격리.
    const messages = await mapLimit(hist.messages ?? [], 6, async (m) => {
      const hasThread = !!m.thread_ts && (m.reply_count ?? 0) > 0;
      const entry: any = {
        ts: m.ts,
        datetime: m.ts ? new Date(Number(m.ts) * 1000).toISOString() : null,
        user: nameOf(m),
        text: m.text ?? '',
      };
      // 부모 메시지면 답글 수를 항상 노출 — 확장이 꺼지거나 실패해도 "답글이 더 있다"는 신호는 남긴다.
      if (hasThread) entry.reply_count = m.reply_count;
      if (includeThreads && hasThread) {
        try {
          const rep = await slackApi<{ messages?: SlackMessage[] }>(
            'conversations.replies',
            { channel: channelId, ts: m.thread_ts, limit: 100 },
            'bot',
          );
          // replies[0] == 부모 메시지 → 제외
          entry.replies = (rep.messages ?? []).slice(1).map((r) => ({
            ts: r.ts,
            datetime: r.ts ? new Date(Number(r.ts) * 1000).toISOString() : null,
            user: nameOf(r),
            text: r.text ?? '',
          }));
        } catch {
          // 한 thread 실패가 채널 읽기 전체를 깨지 않게. 단 빈 []로 숨기지 않고 명시 —
          // rate-limit 등으로 답글을 못 가져온 경우 "답글 0개"로 오인되지 않게 신호를 남긴다.
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
