/**
 * Slack Web API wrapper, read-only (reading conversations and downloading files).
 *
 * Calls fetch directly without the SDK (@slack/web-api), to keep dependencies minimal.
 *
 * Tokens (split by purpose, never substituted for each other):
 *   - SLACK_USER_TOKEN (xoxp-…)  → search.messages / search.files only. Results are filtered to bot-member channels.
 *   - SLACK_BOT_TOKEN  (xoxb-…)  → conversations.* / files.* / users.list (history needs the bot to be a channel member).
 *   - SLACK_TOKEN                → the prefix (xoxp-/xoxb-) decides its purpose, and it only fills the slot that is empty.
 * Why a user token is never used in the bot slot: "what the bot can see" would widen to the token owner's DMs and
 * private channels, and that would be open to every MCP user.
 *
 * Required OAuth scopes (read-only):
 *   - User token : search:read
 *   - Bot token  : channels:history, groups:history, channels:read, groups:read, files:read, users:read
 *                  (DMs are not read, so im:history and mpim:history are not needed)
 */

const SLACK_API = 'https://slack.com/api';

export type SlackTokenKind = 'search' | 'bot';

export class SlackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackError';
  }
}

// Access tokens of apps with token rotation enabled carry an "xoxe." prefix.
const USER_TOKEN_RE = /^(xoxe\.)?xoxp-/;
const BOT_TOKEN_RE = /^(xoxe\.)?xoxb-/;

function pickToken(explicit: string | undefined, re: RegExp): string | undefined {
  if (explicit) return re.test(explicit) ? explicit : undefined; // a token of the wrong kind is not used
  const common = process.env.SLACK_TOKEN;
  return common && re.test(common) ? common : undefined;
}

/** User token (xoxp) for search.*. undefined if absent. */
export function slackUserToken(): string | undefined {
  return pickToken(process.env.SLACK_USER_TOKEN, USER_TOKEN_RE);
}

/** Bot token (xoxb) for conversations.* / files.*. undefined if absent. */
export function slackBotToken(): string | undefined {
  return pickToken(process.env.SLACK_BOT_TOKEN, BOT_TOKEN_RE);
}

/** Picks the token for the given purpose. A token of another kind is never used as a substitute. */
export function getSlackToken(kind: SlackTokenKind): string {
  if (kind === 'search') {
    const t = slackUserToken();
    if (!t) {
      throw new SlackError('Search requires a User token. Set SLACK_USER_TOKEN (xoxp-…).');
    }
    return t;
  }
  const t = slackBotToken();
  if (!t) {
    throw new SlackError('Bot token is missing. Set SLACK_BOT_TOKEN (xoxb-…).');
  }
  return t;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls the Slack Web API. Throws SlackError when the response has `ok=false`.
 * params are sent as application/x-www-form-urlencoded (recommended by Slack, works with every method).
 * 429 (rate limit) and transient timeouts are retried, honoring `Retry-After` (2 retries by default). search is Tier 2,
 * so 429s are frequent and parallel calls (mapLimit) trigger them. Without backoff, thread expansion was silently
 * mislabeled as "unavailable". Retrying makes it reliable.
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
      clearTimeout(timeoutId); // fetch finished: keep the timer from firing while waiting to retry
      // 429: wait Retry-After (seconds), then retry (capped at 30s)
      if (resp.status === 429) {
        if (attempt < retries) {
          const ra = Math.min(Number(resp.headers.get('retry-after')) || 1, 30);
          await sleep(ra * 1000);
          continue;
        }
        throw new SlackError(`${method} failed: rate limited (429)`);
      }
      const json = (await resp.json()) as any;
      if (!json.ok) {
        // Also retry on a ratelimited error in the body (rare)
        if (json.error === 'ratelimited' && attempt < retries) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        const detail = json.error ?? `HTTP ${resp.status}`;
        const needed = json.needed ? ` (needed scope: ${json.needed})` : '';
        throw new SlackError(`${method} failed: ${detail}${needed}`);
      }
      return json as T;
    } catch (e) {
      if (e instanceof SlackError) throw e;
      if (e instanceof Error && e.name === 'AbortError') {
        // Transient timeout: wait briefly and retry, error once retries run out
        if (attempt < retries) {
          await sleep(500);
          continue;
        }
        throw new SlackError(`${method} timeout 15s`);
      }
      throw new SlackError(`${method} fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export { mapLimit } from '../../core/concurrency.js'; // moved to the shared core/concurrency.ts. Tools import it from here

// Cache of user ID → display name (rarely changes within minutes), shared by several tools.
let _userMapCache: { map: Record<string, string>; expiresAt: number } | null = null;
const USER_MAP_TTL_MS = Number(process.env.SLACK_USERMAP_TTL_MS ?? 300_000); // 5 minutes

/** Loads the ID→name map with users.list (TTL cache). Never throws on failure (without a name, the ID is shown as is). */
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
    /* Without the users:read scope the ID is shown as is. Not fatal */
  }
  if (Object.keys(map).length > 0) _userMapCache = { map, expiresAt: now + USER_MAP_TTL_MS };
  return map;
}

// Cache of the IDs of channels the bot is a member of. Bot invites and removals are rare, so a TTL cache is enough.
// Shared by the search trust boundary (bot member = permitted channel) and the check for whether a thread can be expanded.
let _botMemberCache: { ids: Set<string>; expiresAt: number } | null = null;
const BOT_MEMBER_TTL_MS = Number(process.env.SLACK_BOT_MEMBER_TTL_MS ?? 300_000); // 5 minutes

/**
 * IDs of the (public + private) channels the bot is a member of. DMs and group DMs never appear in conversations.list,
 * so they are excluded naturally. On failure, returns the previous cache if there is one, otherwise an empty set
 * (fail-closed: if it cannot be read, nothing is exposed).
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
    // On failure keep the previous cache (even if expired), so a transient outage does not block search entirely.
    // With no cache, return an empty set.
    if (_botMemberCache) return _botMemberCache.ids;
    return ids;
  }
  _botMemberCache = { ids, expiresAt: now + BOT_MEMBER_TTL_MS };
  return ids;
}

// Cache of channel name → {id,name}. Removes the repeated conversations.list paging when resolving a channel by name.
// (slack_read_channel used to fetch up to 10 pages sequentially on every call. After warmup that is 0 calls.)
let _channelNameCache: { byName: Map<string, { id: string; name: string }>; expiresAt: number } | null = null;

/** name→{id,name} map of the (public + private) channels the bot can see (TTL cache). On failure: previous cache or empty map. */
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
    if (_channelNameCache) return _channelNameCache.byName; // transient outage: fall back to the previous cache
  }
  if (byName.size > 0) _channelNameCache = { byName, expiresAt: now + BOT_MEMBER_TTL_MS };
  return byName;
}

/** Whether the mimetype is shown inline as text (anything else gets metadata + URL only). */
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
 * Downloads the content of a Slack file. url_private_download requires Bearer auth.
 * Returns a string for text, and only the byte length for binary (limit of the MCP text channel).
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
      throw new SlackError(`File download failed: HTTP ${resp.status}`);
    }
    // Read only up to maxBytes, then stop. This used to load the whole file into memory before truncating, so one large .log
    // could fill the server's memory.
    const declared = Number(resp.headers.get('content-length') ?? NaN);
    if (!opts.asText) {
      await resp.body?.cancel().catch(() => undefined);
      return { bytes: Number.isFinite(declared) ? declared : 0, truncated: false };
    }
    const chunks: Buffer[] = [];
    let read = 0;
    let truncated = false;
    const reader = resp.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      read += value.byteLength;
      if (read > maxBytes) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    const buf = Buffer.concat(chunks).subarray(0, maxBytes);
    return { text: buf.toString('utf-8'), bytes: Number.isFinite(declared) ? declared : read, truncated };
  } catch (e) {
    if (e instanceof SlackError) throw e;
    if (e instanceof Error && e.name === 'AbortError') {
      throw new SlackError('File download timeout 15s');
    }
    throw new SlackError(`File download failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timeoutId);
  }
}
