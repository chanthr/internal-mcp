/**
 * slack_read_channel(channel, limit?, oldest?, includeThreads?) — 채널 대화 읽기.
 *
 * conversations.history 로 최근 메시지, 옵션으로 thread replies 까지.
 * channel 은 이름(#dev / dev) 또는 ID(C…) 모두 허용 — 이름이면 conversations.list 로 resolve.
 * Bot token 사용 (봇이 해당 채널 멤버여야 조회 가능).
 * Role: 모든 role 허용.
 */
import { z } from 'zod';
import { getAuth } from '../lib/context.js';
import { allowedSlackChannels } from '../lib/scope.js';
import { slackApi, SlackError, loadSlackUserMap, loadChannelNameMap, mapLimit } from '../integrations/slack.js';

export const slackReadChannelTool = {
  name: 'slack_read_channel',
  description:
    'Slack 채널의 최근 대화를 읽는다. channel 은 이름(#dev) 또는 ID(C…). ' +
    '**기본으로 각 메시지의 thread 답글까지 함께 가져온다(includeThreads=true 기본).** ' +
    'Slack discussions and decisions often live in thread replies, so ' +
    '윗줄(부모 메시지)만 보면 맥락이 통째로 누락된다 — 답글까지 읽어야 실제 결론이 보인다. ' +
    '윗줄만 빠르게 훑고 싶을 때만 includeThreads=false 로 끈다. ' +
    '봇이 해당 채널 멤버여야 조회 가능 (비공개 채널은 초대 필요).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      channel: { type: 'string', description: '채널 이름(#dev 또는 dev) 또는 ID(C…).' },
      limit: { type: 'number', description: '메시지 수 (1-200). default 50.' },
      oldest: {
        type: 'string',
        description: '선택. 이 시점 이후만 (YYYY-MM-DD 또는 Unix ts).',
      },
      includeThreads: {
        type: 'boolean',
        description:
          'thread 답글 포함 여부. **default true** — 답글에 실제 논의가 담겨 있어 기본 포함. ' +
          '부모 메시지만 빠르게 보려면 false.',
      },
    },
    required: ['channel'],
  },
};

const inputSchema = z.object({
  channel: z.string().min(1),
  limit: z.number().int().min(1).max(200).default(50),
  oldest: z.string().optional(),
  includeThreads: z.boolean().default(true),
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
  // 이미 ID 형태 (C/G/D + 영숫자)
  if (/^[CGD][A-Z0-9]{6,}$/.test(input)) return { id: input, name: null };
  const cleaned = input.replace(/^#/, '');
  // 공용 채널명 캐시(TTL) 조회 — 매 호출 conversations.list 순차 순회를 warmup 후 0콜로.
  const byName = await loadChannelNameMap();
  const found = byName.get(cleaned);
  if (found) return { id: found.id, name: found.name };
  throw new SlackError(`채널 "${input}" 을 찾을 수 없음 (봇이 멤버가 아니거나 이름 오타).`);
}

// user-map·mapLimit 은 slack.ts 공용 버전(loadSlackUserMap·mapLimit) 사용 — 도구별 중복 구현·캐시
// 분절을 제거해, search 가 데운 캐시를 read_channel 이 재사용(반대도)하고 users.list 왕복이 실질 제거.

export async function handleSlackReadChannel(args: unknown) {
  const auth = getAuth();
  const { channel, limit, oldest, includeThreads } = inputSchema.parse(args);

  try {
    const { id: channelId, name: channelName } = await resolveChannelId(channel);
    // 직원별 Slack 채널 scope 체크 (admin·미설정 = 전체)
    const channelScope = allowedSlackChannels(auth);
    if (channelScope && !channelScope.has(channelId)) {
      return {
        content: [
          { type: 'text' as const, text: `[forbidden] 채널 '${channel}' 은 현재 직원 권한으로 접근 불가입니다.` },
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
