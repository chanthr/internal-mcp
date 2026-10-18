/**
 * slack_list_channels(enabledOnly?) — Slack 채널 지형(용도 매핑) 반환 + 자동 동기화.
 *
 * 데이터: 저장소 `slack_channels`(용도 매핑, single source — SQLite 파일 또는 Supabase)
 *         + Slack `conversations.list`(실시간 채널·멤버십) join.
 *
 * 자동 동기화 (호출 시 lazy — 변경분이 있을 때만 write):
 *   - 기존 채널 이름 변경  → channel_name 갱신 (channel_id 가 매칭 기준이라 이름이 바뀌어도 안 깨짐)
 *   - channel_id 미기록 행 → 이름으로 매칭해 channel_id backfill (최초 1회 정착)
 *   - 신규 채널           → enabled=false 로 추가 (사람이 `knowledge-mcp slack channel` 명령이나
 *                           Supabase 표에서 purpose 를 채우고 켜면 노출)
 * bot_can_read 판정도 channel_id 기준 — 이름 변경에 강건.
 *
 * 봇/챗봇은 Slack 관련 질문에서 이 툴을 먼저 호출해 "어느 채널이 무슨 용도인지,
 * 봇이 읽을 수 있는지(bot_can_read)" 를 파악한 뒤 slack_search(in:#채널) /
 * slack_read_channel 을 타겟팅한다. 두 도구 모두 봇이 멤버인 채널만 돌려준다.
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
    .describe('true(default) 면 활성 채널만. false 면 비활성(미분류 신규 포함) 포함.'),
});

export const slackListChannelsTool = defineTool({
  name: 'slack_list_channels',
  description:
    'Returns the Slack channel landscape — each channel purpose and whether the bot can read it (bot_can_read). ' +
    'Slack 관련 질문에서 가장 먼저 호출해 "어느 채널을 검색/읽을지" 판단하라. ' +
    'bot_can_read=true 면 slack_read_channel·slack_search 로 읽기 가능, false 면 봇을 그 채널에 초대해야 읽거나 검색할 수 있다. ' +
    '호출 시 Slack 실제 채널과 자동 동기화된다(이름 변경·신규 채널 반영). 용도 매핑은 서버 저장소의 slack_channels 에서 관리.',
  input: inputSchema,
  run: (args) => handleSlackListChannels(args),
});

// ── 응답 TTL 캐시 ──
// 이 도구는 매 호출마다 conversations.list(Slack) + 동기화 write + DB read 를 수행한다.
// 여러 사용자가 Slack 질문을 동시에 던지면 같은 작업이 중복되므로, 짧은 TTL 로 최종 응답을 캐시한다.
// (채널 추가/이름변경 반영 지연은 최대 TTL 초 — lazy 동기화 특성상 허용 범위)
const LIST_CACHE_TTL_MS = Number(process.env.SLACK_LIST_CACHE_TTL_MS ?? 60_000);
const _listCache = new Map<string, { text: string; expiresAt: number }>();

type ChannelRow = SlackChannelRow;

interface LiveChannel {
  id: string;
  name: string;
  is_member: boolean;
}

/**
 * conversations.list 결과로 slack_channels 동기화 (변경분만 write).
 * graceful — 실패해도 throw 하지 않고 0 카운트 반환 (read 는 계속 진행).
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
      // 이미 id 로 정착된 채널 — 이름이 바뀌었으면 갱신
      if (hit.channel_name !== c.name) toUpdate.push({ id: hit.id, patch: { channel_name: c.name } });
      continue;
    }
    const named = byName.get(c.name);
    if (named && !named.channel_id) {
      // 이름은 매칭되나 channel_id 미기록 — 최초 backfill
      toUpdate.push({ id: named.id, patch: { channel_id: c.id } });
      continue;
    }
    if (!named) {
      // DB 에 없는 신규 채널 — 비활성으로 추가 (사람이 purpose 채우면 노출)
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
    /* sync 실패해도 매핑 read 는 진행 */
  }
  return { inserted, renamed, linked };
}

export async function handleSlackListChannels(args: z.infer<typeof inputSchema>) {
  // 저장소 read 의 네트워크 throw 가 [fatal] 로 누수하지 않게 graceful 래핑. 입력은 registry 가 검증했다.
  try {
    return await _handleSlackListChannels(args);
  } catch (e: unknown) {
    return {
      content: [{ type: 'text' as const, text: `[error] 채널 목록 조회 일시 오류 (${e instanceof Error ? e.message : String(e)}).` }],
      isError: true,
    };
  }
}

async function _handleSlackListChannels(args: z.infer<typeof inputSchema>) {
  const auth = getAuth();
  const { enabledOnly } = args;
  const channelScope = allowedSlackChannels(auth);

  // 캐시 hit — Slack 호출·동기화·DB read 전부 skip. scope 있는 직원은 캐시 오염 방지 위해 skip.
  const cacheKey = enabledOnly ? 'enabled' : 'all';
  if (!channelScope) {
    const cached = _listCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { content: [{ type: 'text' as const, text: cached.text }] };
    }
  }

  const store = await getStore();

  // 1. 저장소의 현재 매핑 (sync 비교용 — enabled 무관 전체)
  let rows: ChannelRow[];
  try {
    rows = await store.listSlackChannels();
  } catch (e) {
    return {
      content: [{ type: 'text' as const, text: `[error] slack_channels 조회 실패: ${e instanceof Error ? e.message : String(e)}` }],
      isError: true,
    };
  }

  // 2. 실시간 채널 (Slack 안 되면 매핑만 반환 — graceful). cursor 로 끝까지 — Slack 은 limit 보다
  //    적게 주고 cursor 를 줄 수 있어, 첫 페이지만 보면 뒤 채널이 bot_can_read=false 로 잘못 나온다.
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
    /* slack 토큰/스코프 문제여도 매핑은 반환 */
  }

  // 3. 자동 동기화 (live 가 있을 때만 — 빈 응답으로 DB 를 망가뜨리지 않게)
  let synced = { inserted: 0, renamed: 0, linked: 0 };
  if (live.length > 0) {
    synced = await syncChannels(store, rows, live);
  }

  // 4. 동기화로 바뀐 게 있으면 반영본 재조회
  let outRows = rows;
  if (synced.inserted || synced.renamed || synced.linked) {
    outRows = await store.listSlackChannels().catch(() => rows);
  }
  if (enabledOnly) outRows = outRows.filter((r) => r.enabled);
  // 직원별 Slack 채널 scope (admin·미설정 = 전체). channel_id 기준.
  if (channelScope) outRows = outRows.filter((r) => r.channel_id && channelScope.has(r.channel_id));

  // 5. bot_can_read — channel_id 기준 (이름 변경에 강건), 미링크 행은 이름 fallback
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
      ? ` (동기화: 신규 ${synced.inserted}·이름갱신 ${synced.renamed}·id연결 ${synced.linked})`
      : '';

  const text = JSON.stringify(
    {
      count: channels.length,
      note: 'bot_can_read=true → slack_read_channel·slack_search 가능. false → 봇 초대 필요.' + syncNote,
      channels,
    },
    null,
    2,
  );
  // Slack 응답이 정상일 때만 캐시 (live 비었으면 일시 장애일 수 있어 캐시 안 함 → 다음 호출 재시도)
  if (live.length > 0 && !channelScope) {
    _listCache.set(cacheKey, { text, expiresAt: Date.now() + LIST_CACHE_TTL_MS });
  }

  return { content: [{ type: 'text' as const, text }] };
}
