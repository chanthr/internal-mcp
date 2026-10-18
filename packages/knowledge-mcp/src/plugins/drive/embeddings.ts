/**
 * Embedding 헬퍼 — OpenAI `text-embedding-3-small` (2026-05-28 비용 전환).
 *
 * 기존 Gemini `gemini-embedding-2` → OpenAI 3-small 전환 이유:
 *   - 비용 ~1/10 ($0.02/1M vs Gemini ~$0.20/1M)
 *   - 429 rate limit 여유 (Gemini free tier 한도 잦은 429 → drive-sync 에러 로그)
 *   - backend 가 이미 3-small 사용(한국어 KG 임베딩 검증됨)
 *   - 1536 dim 동일 → Qdrant collection 차원 유지 (벡터 공간만 다름 → 전환 시 전체 재색인 필수)
 *   - input 한도 8191 토큰 → Gemini 대비 큰 청크 Bad Request 완화
 *
 * 호출 패턴:
 *   OpenAI embeddings API 는 `input` 배열 batch 지원 → 한 호출에 여러 청크 (Gemini individual call 대비 빠르고 rate limit ↓).
 *   429/5xx → exponential backoff + jitter retry. timeout 방어(무응답 hang).
 */
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;
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

// taskType: OpenAI 3-small 은 query/doc 비대칭 미지원 → 시그니처만 유지(호출부 호환), 동작 영향 없음.
export type EmbedTaskType =
  | 'RETRIEVAL_DOCUMENT'
  | 'RETRIEVAL_QUERY'
  | 'SEMANTIC_SIMILARITY'
  | 'CLASSIFICATION'
  | 'CLUSTERING';

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('[embeddings] OPENAI_API_KEY env missing');
  return key;
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
        fetch(OPENAI_EMBEDDINGS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs, dimensions: EMBEDDING_DIM }),
        }),
        policy.timeoutMs,
        '[embeddings] openai',
      );

      if (!resp.ok) {
        const body = await resp.text();
        const retryable = parseRetryable(resp.status, body);
        if (!retryable || attempt >= policy.maxRetries) {
          throw new Error(`OpenAI embeddings ${resp.status}: ${body.slice(0, 200)}`);
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
          `[embeddings] response mismatch — vecs=${vecs.length}/${inputs.length}, dim=${vecs[0]?.length}/${EMBEDDING_DIM}`,
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
  _taskType: EmbedTaskType = 'RETRIEVAL_DOCUMENT',
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
  const [vec] = await embedTexts([query], 'RETRIEVAL_QUERY', QUERY_POLICY);
  return vec;
}
