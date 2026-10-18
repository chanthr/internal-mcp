/**
 * Slack Web API wrapper — read-only (대화 읽기 + 파일 다운로드).
 *
 * SDK(@slack/web-api) 없이 fetch 직접 호출 — 의존성 최소화.
 *
 * 토큰 (용도별 분기, 서로 대신 쓰지 않음):
 *   - SLACK_USER_TOKEN (xoxp-…)  → search.messages / search.files 전용. 결과는 "봇이 멤버인 채널"로 거른다.
 *   - SLACK_BOT_TOKEN  (xoxb-…)  → conversations.* / files.* / users.list (봇이 채널 멤버여야 history 조회 가능).
 *   - SLACK_TOKEN                → 접두사(xoxp-/xoxb-)로 용도를 판별해, 비어 있는 쪽에만 쓴다.
 * user token 을 bot 자리에 쓰지 않는 이유: "봇이 볼 수 있는 범위"가 토큰 주인의 DM·비공개 채널로 넓어져
 * 모든 MCP 사용자에게 열린다.
 *
 * 필요 OAuth scope (read-only):
 *   - User token : search:read
 *   - Bot token  : channels:history, groups:history, channels:read, groups:read, files:read, users:read
 *                  (DM 은 읽지 않으므로 im:history, mpim:history 는 필요 없다)
 */

const SLACK_API = 'https://slack.com/api';

export type SlackTokenKind = 'search' | 'bot';

export class SlackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackError';
  }
}

// 토큰 회전(rotation)을 켠 앱의 access token 은 "xoxe." 접두가 붙는다.
const USER_TOKEN_RE = /^(xoxe\.)?xoxp-/;
const BOT_TOKEN_RE = /^(xoxe\.)?xoxb-/;

function pickToken(explicit: string | undefined, re: RegExp): string | undefined {
  if (explicit) return re.test(explicit) ? explicit : undefined; // 잘못 넣은 토큰 종류는 쓰지 않는다
  const common = process.env.SLACK_TOKEN;
  return common && re.test(common) ? common : undefined;
}

/** search.* 용 user token (xoxp). 없으면 undefined. */
export function slackUserToken(): string | undefined {
  return pickToken(process.env.SLACK_USER_TOKEN, USER_TOKEN_RE);
}

/** conversations.* / files.* 용 bot token (xoxb). 없으면 undefined. */
export function slackBotToken(): string | undefined {
  return pickToken(process.env.SLACK_BOT_TOKEN, BOT_TOKEN_RE);
}

/** 용도에 맞는 토큰 선택. 다른 종류 토큰으로 대신하지 않는다. */
export function getSlackToken(kind: SlackTokenKind): string {
  if (kind === 'search') {
    const t = slackUserToken();
    if (!t) {
      throw new SlackError('검색에는 User token 이 필요합니다. SLACK_USER_TOKEN (xoxp-…) 설정.');
    }
    return t;
  }
  const t = slackBotToken();
  if (!t) {
    throw new SlackError('Bot token 이 없습니다. SLACK_BOT_TOKEN (xoxb-…) 설정.');
  }
  return t;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Slack Web API 호출. 응답 `ok=false` 면 SlackError throw.
 * params 는 application/x-www-form-urlencoded 로 전송 (Slack 권장 — 모든 메서드 호환).
 * 429(rate limit)·일시 timeout 은 `Retry-After` 존중해 재시도(기본 2회). search 는 Tier2 라 429 가
 * 잦고 병렬(mapLimit)이 이를 유발하는데, 백오프가 없으면 thread 확장이 조용히 "unavailable" 로
 * 오표기됐다 → 재시도로 신뢰성 확보.
 */
export async function slackApi<T = any>(
  method: string,
  params: Record<string, string | number | boolean | undefined>,
  kind: SlackTokenKind,
  retries = 2,
): Promise<T> {
  const token = getSlackToken(kind);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) body.set(k, String(v));
  }

  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const resp = await fetch(`${SLACK_API}/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: body.toString(),
        signal: ctrl.signal,
      });
      clearTimeout(timeoutId); // fetch 완료 — 재시도 대기 중 타이머 오작동 방지
      // 429: Retry-After(초) 만큼 대기 후 재시도 (상한 30s)
      if (resp.status === 429) {
        if (attempt < retries) {
          const ra = Math.min(Number(resp.headers.get('retry-after')) || 1, 30);
          await sleep(ra * 1000);
          continue;
        }
        throw new SlackError(`${method} 실패: rate limited (429)`);
      }
      const json = (await resp.json()) as any;
      if (!json.ok) {
        // 본문 ratelimited(드묾) 도 재시도
        if (json.error === 'ratelimited' && attempt < retries) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        const detail = json.error ?? `HTTP ${resp.status}`;
        const needed = json.needed ? ` (needed scope: ${json.needed})` : '';
        throw new SlackError(`${method} 실패: ${detail}${needed}`);
      }
      return json as T;
    } catch (e) {
      if (e instanceof SlackError) throw e;
      if (e instanceof Error && e.name === 'AbortError') {
        // 일시 timeout — 짧게 대기 후 재시도, 소진 시 에러
        if (attempt < retries) {
          await sleep(500);
          continue;
        }
        throw new SlackError(`${method} timeout 15s`);
      }
      throw new SlackError(`${method} fetch 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/** 동시성 제한 병렬 map — Slack rate limit 을 보호하며 순차 N+1 을 제거. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 0 }, worker));
  return out;
}

// 사용자 ID → 표시명 캐시 (분 단위로 거의 안 변함) — 여러 도구가 공유.
let _userMapCache: { map: Record<string, string>; expiresAt: number } | null = null;
const USER_MAP_TTL_MS = Number(process.env.SLACK_USERMAP_TTL_MS ?? 300_000); // 5분

/** users.list 로 ID→이름 맵 로드 (TTL 캐시). 실패해도 throw 안 함(이름 없으면 ID 그대로). */
export async function loadSlackUserMap(): Promise<Record<string, string>> {
  const now = Date.now();
  if (_userMapCache && _userMapCache.expiresAt > now) return _userMapCache.map;
  const map: Record<string, string> = {};
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await slackApi<{
        members?: { id: string; real_name?: string; name?: string }[];
        response_metadata?: { next_cursor?: string };
      }>('users.list', { limit: 200, cursor }, 'bot');
      for (const m of res.members ?? []) map[m.id] = m.real_name || m.name || m.id;
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  } catch {
    /* users:read scope 없으면 ID 그대로 — 치명적 아님 */
  }
  if (Object.keys(map).length > 0) _userMapCache = { map, expiresAt: now + USER_MAP_TTL_MS };
  return map;
}

// 봇이 멤버인 채널 id 집합 캐시 — 봇 초대/탈퇴는 드물어 TTL 캐시.
// search 의 신뢰 경계(봇 멤버 = 허가된 채널)와 thread 확장 가능 여부 판정에 공유.
let _botMemberCache: { ids: Set<string>; expiresAt: number } | null = null;
const BOT_MEMBER_TTL_MS = Number(process.env.SLACK_BOT_MEMBER_TTL_MS ?? 300_000); // 5분

/**
 * 봇이 멤버인 (공개+비공개) 채널 id 집합. DM·그룹DM 은 conversations.list 에 안 잡혀 자연 제외.
 * 실패 시 직전 캐시가 있으면 그대로, 없으면 빈 집합(fail-closed — 못 읽으면 노출 안 함).
 */
export async function loadBotMemberChannelIds(): Promise<Set<string>> {
  const now = Date.now();
  if (_botMemberCache && _botMemberCache.expiresAt > now) return _botMemberCache.ids;
  const ids = new Set<string>();
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await slackApi<{
        channels?: { id: string; is_member?: boolean }[];
        response_metadata?: { next_cursor?: string };
      }>(
        'conversations.list',
        { types: 'public_channel,private_channel', limit: 1000, exclude_archived: true, cursor },
        'bot',
      );
      for (const c of res.channels ?? []) if (c.id && c.is_member) ids.add(c.id);
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  } catch {
    // 실패 시 직전 캐시 유지(만료됐어도) — 일시 장애로 검색을 통째 막지 않게. 캐시 없으면 빈 집합.
    if (_botMemberCache) return _botMemberCache.ids;
    return ids;
  }
  _botMemberCache = { ids, expiresAt: now + BOT_MEMBER_TTL_MS };
  return ids;
}

// 채널 이름 → {id,name} 캐시 — 이름으로 채널 resolve 시 반복 conversations.list 순회 제거.
// (slack_read_channel 이 매 호출 최대 10페이지 순차 조회하던 지연을 warmup 후 0콜로.)
let _channelNameCache: { byName: Map<string, { id: string; name: string }>; expiresAt: number } | null = null;

/** 봇이 보는 (공개+비공개) 채널의 name→{id,name} 맵 (TTL 캐시). 실패 시 직전 캐시 유지 or 빈 맵. */
export async function loadChannelNameMap(): Promise<Map<string, { id: string; name: string }>> {
  const now = Date.now();
  if (_channelNameCache && _channelNameCache.expiresAt > now) return _channelNameCache.byName;
  const byName = new Map<string, { id: string; name: string }>();
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 15; page++) {
      const res = await slackApi<{
        channels?: { id: string; name: string }[];
        response_metadata?: { next_cursor?: string };
      }>(
        'conversations.list',
        { types: 'public_channel,private_channel', limit: 1000, exclude_archived: true, cursor },
        'bot',
      );
      for (const c of res.channels ?? []) if (c.id && c.name) byName.set(c.name, { id: c.id, name: c.name });
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  } catch {
    if (_channelNameCache) return _channelNameCache.byName; // 일시 장애 — 직전 캐시로 버팀
  }
  if (byName.size > 0) _channelNameCache = { byName, expiresAt: now + BOT_MEMBER_TTL_MS };
  return byName;
}

/** 텍스트로 인라인 표시할 mimetype 인지 (그 외는 메타+URL 만). */
export function isTextualMime(mimetype: string | undefined, filetype: string | undefined): boolean {
  const m = (mimetype ?? '').toLowerCase();
  if (m.startsWith('text/')) return true;
  if (m === 'application/json' || m === 'application/xml') return true;
  const textFiletypes = new Set([
    'text', 'markdown', 'md', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml',
    'javascript', 'typescript', 'python', 'java', 'go', 'rust', 'c', 'cpp',
    'html', 'css', 'sql', 'shell', 'bash', 'log', 'diff', 'patch',
  ]);
  return textFiletypes.has((filetype ?? '').toLowerCase());
}

/**
 * Slack 파일 본문 다운로드. url_private_download 에 Bearer 인증 필요.
 * 텍스트면 string, 바이너리면 byte 길이만 반환 (MCP text 채널 한계).
 */
export async function downloadSlackFile(
  urlPrivate: string,
  opts: { asText: boolean; maxBytes?: number },
): Promise<{ text?: string; bytes: number; truncated: boolean }> {
  const token = getSlackToken('bot');
  const maxBytes = opts.maxBytes ?? 200_000;

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const resp = await fetch(urlPrivate, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      throw new SlackError(`파일 다운로드 실패: HTTP ${resp.status}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const truncated = buf.length > maxBytes;
    if (opts.asText) {
      const slice = truncated ? buf.subarray(0, maxBytes) : buf;
      return { text: slice.toString('utf-8'), bytes: buf.length, truncated };
    }
    return { bytes: buf.length, truncated: false };
  } catch (e) {
    if (e instanceof SlackError) throw e;
    if (e instanceof Error && e.name === 'AbortError') {
      throw new SlackError('파일 다운로드 timeout 15s');
    }
    throw new SlackError(`파일 다운로드 실패: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timeoutId);
  }
}
