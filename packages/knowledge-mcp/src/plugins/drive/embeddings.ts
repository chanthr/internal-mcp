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
// Read when used, like the key: an endpoint set after this module loaded (a test, a setup step) is picked up.
const baseUrl = () => (process.env.EMBEDDING_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');

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

// Inputs per batch (OpenAI accepts an array input). A conservative 128 leaves headroom under the token limit.
const BATCH_SIZE = Number(process.env.EMBED_BATCH ?? 128);

// ── Two retry policies (one per path) ──
// Indexing (batch) path, patient: absorbs large chunk volumes and transient 429/5xx as far as possible (it runs in
// the background, so a long tail is fine). Query (interactive search) path, fail-fast: the user is waiting, so the
// tail is kept short. If both paths shared one policy, a single search could hang about 80s in the worst case
// (5×10s + backoff) on OpenAI latency or 429, so they are separate.
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
  if (!key && baseUrl() === DEFAULT_BASE_URL) throw new Error('[embeddings] set OPENAI_API_KEY (or EMBEDDING_API_KEY)');
  return key || undefined;
}

/** Whether the error is retryable (429 rate limit, or 5xx/timeout). */
function parseRetryable(status: number | null, msg: string): boolean {
  const is429 = status === 429 || /rate limit|quota|too many requests/i.test(msg);
  const is5xx =
    (typeof status === 'number' && status >= 500 && status <= 599) ||
    /\b(500|502|503|504)\b|timeout|deadline|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg);
  return is429 || is5xx;
}

// Guards against lone surrogates: half of a broken emoji causes a 400. Empty input also causes a 400, so it falls
// back to a space.
function sanitize(text: string): string {
  const s = text.replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    '',
  );
  return s.length > 0 ? s : ' ';
}

/** Input array → embedding array (one batch call + retry). Order is preserved. policy sets retry and timeout per path. */
async function embedBatch(texts: string[], policy: EmbedPolicy): Promise<number[][]> {
  const apiKey = getApiKey();
  const inputs = texts.map(sanitize);

  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await withTimeout(
        fetch(`${baseUrl()}/embeddings`, {
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
      // Sort by index and keep only the vectors (OpenAI usually returns them in order, this is defensive)
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
 * Several texts → embedding vectors (input order preserved).
 * Calls in batches of BATCH_SIZE. The default policy is the indexing one (patient). Queries use fail-fast via embedQuery.
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

/** Single query → vector. This is the interactive search path, so it uses the fail-fast policy (QUERY_POLICY). */
export async function embedQuery(query: string, prefix = ''): Promise<number[]> {
  // Some embedding models are trained with a prefix on the question ("query: …", an instruction): without it they
  // find less. Which one goes with the vectors in the index is the caller's to say (qdrant.ts vectorForm).
  const [vec] = await embedTexts([`${prefix}${query}`], QUERY_POLICY);
  return vec;
}
