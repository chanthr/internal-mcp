/**
 * A language model this server can use for work it does itself: building the wiki, describing passages before
 * they are indexed. Until one is connected nothing here runs, and the server calls no model at all.
 *
 * Two kinds of connection:
 *   anthropic   Claude, through Anthropic's own API and its official SDK.
 *   openai      Any endpoint that speaks OpenAI's /chat/completions: OpenRouter, OpenAI, a local Ollama, vLLM, …
 *
 * Settings (env, written by the console):
 *   LLM_PROVIDER   anthropic | openai
 *   LLM_API_KEY    the key. May be empty for an endpoint on this machine.
 *   LLM_BASE_URL   openai: the API base (https://openrouter.ai/api/v1). anthropic: not used.
 *   LLM_MODEL      the model, as the provider names it. It is picked from the provider's own list: no model
 *                  name is made up here.
 *
 * What is sent: the text handed to `ask`, which for the wiki is the text of the person's documents. That is said
 * where a model is connected, and nothing is sent by merely connecting one (one short question checks the key).
 */
import Anthropic from '@anthropic-ai/sdk';

export type LlmKind = 'anthropic' | 'openai';

export interface LlmSettings {
  kind: LlmKind;
  /** openai kind only. */
  baseUrl?: string;
  apiKey?: string;
  model: string;
}

/** Where Anthropic's API is. Unset means the real one; a test points it at a fake. */
export const anthropicEndpoint: { baseURL?: string } = {};

const clean = (v: string | undefined): string | undefined => v?.trim() || undefined;

/** The connected model, or null. */
export function llmSettings(env: NodeJS.ProcessEnv = process.env): LlmSettings | null {
  const model = clean(env.LLM_MODEL);
  const kind = clean(env.LLM_PROVIDER);
  if (!model || (kind !== 'anthropic' && kind !== 'openai')) return null;
  if (kind === 'anthropic') return clean(env.LLM_API_KEY) ? { kind, apiKey: clean(env.LLM_API_KEY), model } : null;
  const baseUrl = clean(env.LLM_BASE_URL)?.replace(/\/+$/, '');
  return baseUrl ? { kind, baseUrl, apiKey: clean(env.LLM_API_KEY), model } : null;
}
export const llmConfigured = (): boolean => llmSettings() !== null;

/** Something a person can act on, said in a sentence. `retry`: trying again later may work. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly retry = false,
  ) {
    super(message);
  }
}

export interface LlmModel {
  id: string;
  name: string;
}
export interface LlmAnswer {
  text: string;
  /** The model that answered, as the provider reports it. */
  model: string;
  /** Tokens read and written. `cached`: read from the provider's cache, at a fraction of the price. */
  usage: { input: number; output: number; cached: number };
  /** The answer was cut off at the length limit. */
  cutOff: boolean;
}
export interface LlmRequest {
  /** Instructions that repeat from call to call (the wiki's rules). Cached by the provider where it can be. */
  system?: string;
  prompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

const CALL_TIMEOUT_MS = 5 * 60_000;
const host = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// ── Claude, through Anthropic's SDK ──

const claude = (s: Pick<LlmSettings, 'apiKey'>): Anthropic => new Anthropic({ apiKey: s.apiKey, ...(anthropicEndpoint.baseURL ? { baseURL: anthropicEndpoint.baseURL } : {}) });

/** What went wrong, from the SDK's own error classes, in words for the page. */
function claudeError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  if (e instanceof Anthropic.AuthenticationError) return new LlmError('Anthropic did not accept the API key.');
  if (e instanceof Anthropic.PermissionDeniedError) return new LlmError('This API key may not use that model.');
  if (e instanceof Anthropic.NotFoundError) return new LlmError('Anthropic does not know that model. Pick one from the list again.');
  if (e instanceof Anthropic.RateLimitError) return new LlmError('Anthropic is limiting requests for this key right now.', true);
  if (e instanceof Anthropic.APIConnectionError) return new LlmError('Anthropic could not be reached.', true);
  if (e instanceof Anthropic.APIError) return new LlmError(`Anthropic answered ${e.status ?? 'with an error'}: ${String(e.message).slice(0, 200)}`, (e.status ?? 0) >= 500);
  return new LlmError(e instanceof Error ? e.message : String(e));
}

/**
 * The models whose refusals Anthropic can hand to another model inside the same call. Asked for by default on
 * these: without it a declined request simply stops. (Anthropic's guidance for these models; other models take no
 * such parameter.)
 */
const HAS_FALLBACK = /^claude-(fable-5-[12]|opus-5(-5)?|sonnet-5-5)$/;

async function askClaude(s: LlmSettings, req: LlmRequest): Promise<LlmAnswer> {
  const client = claude(s);
  const base = {
    model: s.model,
    max_tokens: req.maxTokens ?? 16_000,
    // The instructions are the same from call to call. Marked so the provider keeps them: read again at a tenth
    // of the price. (Shorter than the provider's minimum they are simply not kept.)
    ...(req.system ? { system: [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }] } : {}),
    messages: [{ role: 'user' as const, content: req.prompt }],
  };
  try {
    // Thinking is left to the model's own default: every current model accepts that, whichever one was picked.
    const response = HAS_FALLBACK.test(s.model)
      ? await client.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as Parameters<typeof client.beta.messages.create>[0], { signal: req.signal, timeout: CALL_TIMEOUT_MS })
      : await client.messages.create(base, { signal: req.signal, timeout: CALL_TIMEOUT_MS });
    const message = response as Anthropic.Message;
    if (message.stop_reason === 'refusal') {
      const category = (message as { stop_details?: { category?: string | null } }).stop_details?.category;
      throw new LlmError(`The model declined this request${category ? ` (${category})` : ''}.`);
    }
    let text = '';
    for (const block of message.content) if (block.type === 'text') text += block.text;
    return {
      text,
      model: message.model,
      usage: { input: message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0), output: message.usage.output_tokens, cached: message.usage.cache_read_input_tokens ?? 0 },
      cutOff: message.stop_reason === 'max_tokens',
    };
  } catch (e) {
    throw claudeError(e);
  }
}

async function claudeModels(s: Pick<LlmSettings, 'apiKey'>): Promise<LlmModel[]> {
  const out: LlmModel[] = [];
  try {
    for await (const m of claude(s).models.list()) out.push({ id: m.id, name: m.display_name || m.id });
  } catch (e) {
    throw claudeError(e);
  }
  return out;
}

// ── Any endpoint that speaks OpenAI's chat completions ──

interface ChatBody {
  model?: string;
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string } | string;
}

async function openaiFetch(s: Pick<LlmSettings, 'baseUrl' | 'apiKey'>, path: string, init: RequestInit, signal?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `${s.baseUrl}${path}`;
  const limit = AbortSignal.timeout(CALL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    const cause = (e as { cause?: { code?: string } }).cause;
    throw new LlmError(`${host(url)} could not be reached (${cause?.code ?? (e instanceof Error ? e.message : String(e))}).`, true);
  }
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const said = (body: Record<string, unknown>): string => {
  const error = (body as ChatBody).error;
  return String((typeof error === 'string' ? error : error?.message) ?? '').slice(0, 200);
};

function openaiError(s: Pick<LlmSettings, 'baseUrl'>, status: number, body: Record<string, unknown>): LlmError {
  const where = host(s.baseUrl ?? '');
  if (status === 401 || status === 403) return new LlmError(`${where} did not accept the API key.`);
  if (status === 404) return new LlmError(`${where} does not know that model, or this is not the address of its API.`);
  if (status === 402) return new LlmError(`${where} says the account has no credit left.`);
  if (status === 429) return new LlmError(`${where} is limiting requests for this key right now.`, true);
  return new LlmError(`${where} answered ${status}${said(body) ? `: ${said(body)}` : ''}`, status >= 500);
}

async function askOpenai(s: LlmSettings, req: LlmRequest): Promise<LlmAnswer> {
  // No length limit is sent: the name of that field differs between servers, and the model's own limit is the
  // one wanted. A caller's limit is honoured where the server takes the common name.
  const payload = {
    model: s.model,
    messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content: req.prompt }],
  };
  const { status, body } = await openaiFetch(s, '/chat/completions', { method: 'POST', body: JSON.stringify(payload) }, req.signal);
  if (status !== 200) throw openaiError(s, status, body);
  const chat = body as ChatBody;
  const choice = chat.choices?.[0];
  const content = choice?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('') : '';
  if (!choice) throw new LlmError(`${host(s.baseUrl ?? '')} answered without an answer in it${said(body) ? `: ${said(body)}` : '.'}`);
  if (choice.finish_reason === 'content_filter') throw new LlmError('The model declined this request.');
  return {
    text,
    model: typeof chat.model === 'string' ? chat.model : s.model,
    usage: { input: chat.usage?.prompt_tokens ?? 0, output: chat.usage?.completion_tokens ?? 0, cached: chat.usage?.prompt_tokens_details?.cached_tokens ?? 0 },
    cutOff: choice.finish_reason === 'length',
  };
}

async function openaiModels(s: Pick<LlmSettings, 'baseUrl' | 'apiKey'>): Promise<LlmModel[]> {
  const { status, body } = await openaiFetch(s, '/models', { method: 'GET' });
  if (status !== 200) throw openaiError(s, status, body);
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new LlmError(`${host(s.baseUrl ?? '')} did not answer with a list of models. Is this the address of its API (it usually ends in /v1)?`);
  return data
    .filter((m): m is { id: string; name?: unknown } => !!m && typeof (m as { id?: unknown }).id === 'string')
    .map((m) => ({ id: m.id, name: typeof m.name === 'string' && m.name ? m.name : m.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ── What the rest of the server calls ──

/** The models the provider offers this key. */
export async function listLlmModels(s: Omit<LlmSettings, 'model'>): Promise<LlmModel[]> {
  return s.kind === 'anthropic' ? claudeModels(s) : openaiModels(s);
}

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

/**
 * Ask the model. One question, one answer: no conversation is kept. A limit or an outage is tried again a few
 * times, further apart each time; anything a person has to fix (the key, the model) is thrown at once.
 */
export async function ask(req: LlmRequest, settings: LlmSettings | null = llmSettings()): Promise<LlmAnswer> {
  if (!settings) throw new LlmError('No model is connected. Connect one in the console (Agent).');
  // The SDK retries by itself. The plain endpoint is retried here.
  if (settings.kind === 'anthropic') return askClaude(settings, req);
  for (let attempt = 0; ; attempt++) {
    try {
      return await askOpenai(settings, req);
    } catch (e) {
      if (!(e instanceof LlmError) || !e.retry || attempt >= 2) throw e;
      await pause(1500 * 2 ** attempt, req.signal);
    }
  }
}

/** Is the connection good? One short question, with the settings as given (before they are saved). */
export async function checkLlm(settings: LlmSettings): Promise<{ model: string }> {
  const answer = await ask({ prompt: 'Reply with the single word: ready', maxTokens: 2000 }, settings);
  if (!answer.text.trim() && !answer.cutOff) throw new LlmError(`${settings.model} answered with nothing. Pick another model.`);
  return { model: settings.model };
}
