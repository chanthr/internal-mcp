/**
 * slack_search(query, count?) — Slack 워크스페이스 메시지 검색.
 *
 * search.messages API 사용 → User token (xoxp-…, search:read scope) 필수.
 * 권한 그룹: slack. 결과는 봇이 멤버인 채널과 직원 채널 범위로 거른다.
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
 * 검색 표면 = "봇이 멤버인 채널" — read_channel 과 동일한 신뢰 경계.
 *
 * search.messages 는 User token(xoxp) 권한이라 토큰 소유자의 개인 DM·비공개 채널까지 보인다.
 * 그대로 노출하면 토큰 소유자의 사적 대화가 새므로, "봇이 초대된 채널"로만 한정한다
 * (봇 초대 = 어시스턴트가 읽어도 된다고 팀이 허가한 채널). 채널이 대부분 비공개라,
 * 과거의 'public만' 필터는 사실상 전부를 막아 검색이 0건이었다.
 *   - DM(D…)·그룹DM(mpim): conversations.list 에 안 잡혀 botMemberIds 에 자연 부재 → 제외.
 *   - 봇 미초대 비공개 채널: 허가되지 않음 → 제외(read_channel 로도 못 읽음).
 */
function isAllowedSearchMatch(m: SlackSearchMatch, botMemberIds: Set<string>): boolean {
  const c = m.channel;
  if (!c?.id) return false;
  if (c.is_im || c.is_mpim) return false; // 이중 방어 — DM 은 절대 검색 표면에 안 올림
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

    // 1) 봇이 멤버인 채널만 (DM·봇 미초대 비공개 채널 제외 — User token 의 개인 가시범위 차단)
    // 2) 직원별 Slack 채널 scope (admin·미설정 = 전체). 결과 메시지를 허용 채널로 필터.
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

    // search.messages 는 단일 메시지만 반환 — 매칭이 thread 안이면 주변 답글 맥락이 누락된다.
    // 봇이 멤버인 채널은 conversations.replies(ts=매칭ts)로 thread 전체를 가져와 붙인다.
    // (Slack 은 thread 내 아무 메시지 ts 로도 thread 전체를 돌려준다 — 부모/답글 무관)
    // 봇 미참여 채널은 not_in_channel 등으로 실패 → thread_unavailable 로만 표기(평면 결과 유지).
    if (expandThreads && results.length > 0) {
      const userMap = await loadSlackUserMap();
      const nameOf = (t: ThreadMsg) =>
        t.user ? (userMap[t.user] ?? t.user) : t.bot_id ? `bot:${t.bot_id}` : null;
      const seenThreads = new Set<string>(); // channelId:rootTs — 같은 thread 중복 확장 방지

      await mapLimit(results, 6, async (r) => {
        if (!r.channelId || !r.ts) return;
        try {
          const rep = await slackApi<{ messages?: ThreadMsg[] }>(
            'conversations.replies',
            { channel: r.channelId, ts: r.ts, limit: 100 },
            'bot',
          );
          const msgs = rep.messages ?? [];
          if (msgs.length <= 1) return; // thread 아님(단일 메시지) — 붙일 맥락 없음
          const rootTs = msgs[0]?.ts ?? r.ts;
          const key = `${r.channelId}:${rootTs}`;
          if (seenThreads.has(key)) {
            (r as any).thread_root_ts = rootTs; // 이미 다른 매칭에서 확장한 thread
            return;
          }
          seenThreads.add(key);
          (r as any).thread = msgs.map((t) => ({
            ts: t.ts,
            user: nameOf(t),
            text: t.text ?? '',
            is_match: t.ts === r.ts, // 검색에 걸린 바로 그 메시지 표시
          }));
        } catch {
          // 봇이 채널 멤버가 아님(not_in_channel) 등 → 답글이 더 있을 수 있으나 못 읽음
          (r as any).thread_unavailable = true;
        }
      });
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            // total(Slack 원본 건수)은 싣지 않는다 — DM·권한 밖 채널의 일치 건수까지 드러난다.
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
