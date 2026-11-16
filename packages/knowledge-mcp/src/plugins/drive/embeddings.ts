/**
 * Embeddings — any OpenAI-compatible `/embeddings` endpoint. Default: OpenAI `text-embedding-3-small` (1536d).
 *
 * Settings (env):
 *   EMBEDDING_BASE_URL   API base, default https://api.openai.com/v1. Point it at a compatible server to use
 *                        another provider or a local model (Ollama, vLLM, LM Studio, text-embeddings-inference, …).
 *   EMBEDDING_MODEL      model name, default text-embedding-3-small.
 *   EMBEDDING_DIM        vector size the model returns, default 1536. The Qdrant collection is created with it.
 *   EMBEDDING_API_KEY    bearer token. Falls back to OPENAI_API_KEY. May be empty for a local server.
 *
 * Vectors from different models are not comparable: after changing the model, run a full reindex into a new
 * collection (`knowledge-mcp drive reindex --recreate`, or a new QDRANT_COLLECTION).
 *
 * The API takes an `input` array, so one call embeds many chunks. 429 and 5xx are retried with exponential
 * backoff and jitter, and every call has a timeout.
 */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const BASE_URL = (process.env.EMBEDDING_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
const EMBEDDINGS_URL = `${BASE_URL}/embeddings`;

export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL?.trim() || 'text-embedding-3-small';
export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 1536);
if (!Number.isInteger(EMBEDDING_DIM) || EMBEDDING_DIM <= 0) {
  throw new Error(`[embeddings] EMBEDDING_DIM must be a positive integer, got "${process.env.EMBEDDING_DIM}"`);
}
// `dimensions` is an OpenAI text-embedding-3 option. Other servers may reject an unknown field.
const SEND_DIMENSIONS = /^text-embedding-3/.test(EMBEDDING_MODEL);

/** Is an embedding endpoint usable? A key, or a custom endpoint (which may need no key). */
export function embeddingsConfigured(): boolean {
  return !!(process.env.EMBEDDING_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || process.env.EMBEDDING_BASE_URL?.trim());
}

// 한 batch 당 input 수 (OpenAI 는 배열 input 지원). 토큰 한도 여유 위해 보수적 128.
const BATCH_SIZE = Number(process.env.EMBED_BATCH ?? 128);

// ── 재시도 정책 2종 (경로별 분리) ──
// 색인(배치) 경로 — patient: 대량 청크·일시 429/5xx 를 최대한 흡수(백그라운드라 tail 길어도 무방).
// 쿼리(인터랙티브 검색) 경로 — fail-fast: 사용자가 대기하므로 tail 을 짧게. 두 경로가 같은 정책을
// 쓰면 OpenAI 지연·429 시 검색 한 번이 최악 ~80s(5×10s+백오프) 매달릴 수 있어 분리한다.
interface EmbedPolicy {
  maxRetries: number;
  timeoutMs: number;
}
const INDEX_POLICY: EmbedPolicy = {
  maxRetries: Number(process.env.EMBED_INDEX_RETRIES ?? 5),
  timeoutMs: Number(process.env.EMBED_TIMEOUT_MS ?? 10_000),
};
const QUERY_POLICY: EmbedPolicy = {
  maxRetries: Number(process.env.EMBED_QUERY_RETRIES ?? 2),
  timeoutMs: Number(process.env.EMBED_QUERY_TIMEOUT_MS ?? 5_000),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timer = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label}: 504 deadline (timeout ${ms}ms)`)), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t)) as Promise<T>;
}

function getApiKey(): string | undefined {
  const key = process.env.EMBEDDING_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!key && BASE_URL === DEFAULT_BASE_URL) throw new Error('[embeddings] set OPENAI_API_KEY (or EMBEDDING_API_KEY)');
  return key || undefined;
}

/** 재시도 가능 여부 (429 rate limit 또는 5xx/timeout). */
function parseRetryable(status: number | null, msg: string): boolean {
  const is429 = status === 429 || /rate limit|quota|too many requests/i.test(msg);
  const is5xx =
    (typeof status === 'number' && status >= 500 && status <= 599) ||
    /\b(500|502|503|504)\b|timeout|deadline|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
  return is429 || is5xx;
}

// lone surrogate 방어 — 깨진 이모지 반쪽이 들어오면 400. 빈 입력도 400 → 공백 fallback.
function sanitize(text: string): string {
  const s = text.replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    '',
  );
  return s.length > 0 ? s : ' ';
}

/** input 배열 → 임베딩 배열 (batch 1회 호출 + retry). 순서 보장. policy 로 재시도·timeout 경로별 분리. */
async function embedBatch(texts: string[], policy: EmbedPolicy): Promise<number[][]> {
  const apiKey = getApiKey();
  const inputs = texts.map(sanitize);

  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await withTimeout(
        fetch(EMBEDDINGS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs, ...(SEND_DIMENSIONS ? { dimensions: EMBEDDING_DIM } : {}) }),
        }),
        policy.timeoutMs,
        '[embeddings] request',
      );

      if (!resp.ok) {
        const body = await resp.text();
        const retryable = parseRetryable(resp.status, body);
        if (!retryable || attempt >= policy.maxRetries) {
          throw new Error(`embeddings ${resp.status} (${EMBEDDING_MODEL}): ${body.slice(0, 200)}`);
        }
        const m = body.match(/try again in ([\d.]+)s/i);
        const base = m ? Math.ceil(parseFloat(m[1]) * 1000) : Math.min(60_000, 1000 * 2 ** attempt);
        const wait = Math.round(base + base * 0.3 * Math.random());
        console.error(`[embeddings] ${resp.status} retry ${attempt + 1}/${policy.maxRetries} — waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }

      const j = (await resp.json()) as { data: Array<{ index: number; embedding: number[] }> };
      // index 순 정렬 후 벡터만 (OpenAI 는 보통 정렬돼 오지만 방어)
      const sorted = [...j.data].sort((a, b) => a.index - b.index);
      const vecs = sorted.map((d) => d.embedding);
      if (vecs.length !== inputs.length || vecs[0]?.length !== EMBEDDING_DIM) {
        throw new Error(
          `[embeddings] response mismatch — vectors ${vecs.length}/${inputs.length}, size ${vecs[0]?.length} but EMBEDDING_DIM is ${EMBEDDING_DIM} (model ${EMBEDDING_MODEL})`,
        );
      }
      return vecs;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= policy.maxRetries || !parseRetryable(null, msg)) throw err;
      const base = Math.min(60_000, 1000 * 2 ** attempt);
      const wait = Math.round(base + base * 0.3 * Math.random());
      console.error(`[embeddings] exception retry ${attempt + 1}/${policy.maxRetries} — waiting ${wait}ms (${msg.slice(0, 80)})`);
      await sleep(wait);
    }
  }
}

/**
 * 여러 텍스트 → embedding 벡터들 (input 순서 보장).
 * BATCH_SIZE 씩 묶어 batch 호출. policy 기본 = 색인용(patient). 쿼리는 embedQuery 가 fail-fast 사용.
 */
export async function embedTexts(
  texts: string[],
  policy: EmbedPolicy = INDEX_POLICY,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const slice = texts.slice(i, i + BATCH_SIZE);
    const embeds = await embedBatch(slice, policy);
    results.push(...embeds);
  }
  return results;
}

/** 단일 query → 벡터. 인터랙티브 검색 경로라 fail-fast 정책(QUERY_POLICY) 사용. */
export async function embedQuery(query: string): Promise<number[]> {
  const [vec] = await embedTexts([query], QUERY_POLICY);
  return vec;
}
