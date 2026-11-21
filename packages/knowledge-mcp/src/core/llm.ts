/**
 * A language model this server can use for work it does itself (building the wiki, writing questions to measure
 * search with) and for the console's chat (llm_chat.ts). Until one is connected nothing here runs, and the server
 * calls no model at all.
 *
 * Three kinds of connection:
 *   anthropic   Claude, through Anthropic's own API and its official SDK.
 *   openai      Any endpoint that speaks OpenAI's /chat/completions: OpenRouter, OpenAI, a local Ollama, vLLM, …
 *   chatgpt     The person's own ChatGPT Plus or Pro plan, through OpenAI's sign-in (chatgpt.ts). No key.
 *
 * A Claude Pro or Max plan cannot be used this way: Anthropic does not allow other apps to use a Claude
 * subscription's sign-in. Claude is used with an API key.
 *
 * Settings (env, written by the console):
 *   LLM_PROVIDER   anthropic | openai
 *   LLM_API_KEY    the key. May be empty for an endpoint on this machine.
 *   LLM_BASE_URL   openai: the API base (https://openrouter.ai/api/v1). anthropic: not used.
 *   LLM_MODEL      the model, as the provider names it. It is picked from the provider's own list: no model
 *                  name is made up here.
 *
 * The search assistant (plugins/knowledge/agent_search.ts) may use another model than the rest, set the same way
 * under SEARCH_LLM_PROVIDER, SEARCH_LLM_API_KEY, SEARCH_LLM_BASE_URL and SEARCH_LLM_MODEL: a small fast one on
 * this machine while the chat uses a large one, for instance. Unset, it uses the model above.
 *
 * What is sent: the text handed to `ask`, which for the wiki is the text of the person's documents. That is said
 * where a model is connected, and nothing is sent by merely connecting one (one short question checks the key).
 */
import Anthropic from '@anthropic-ai/sdk';
import { ChatgptError, chatgptModels, chatgptResponses, chatgptSignedIn } from './chatgpt.js';

export type LlmKind = 'anthropic' | 'openai' | 'chatgpt';

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

/** The connected model, or null. `prefix`: the settings of another use (SEARCH_LLM_ for the search assistant). */
export function llmSettings(env: NodeJS.ProcessEnv = process.env, prefix = 'LLM_'): LlmSettings | null {
  const model = clean(env[`${prefix}MODEL`]);
  const kind = clean(env[`${prefix}PROVIDER`]);
  if (!model || (kind !== 'anthropic' && kind !== 'openai' && kind !== 'chatgpt')) return null;
  // The plan is used through the sign-in kept by chatgpt.ts: the setting holds only the model.
  if (kind === 'chatgpt') return chatgptSignedIn() ? { kind, model } : null;
  const baseUrl = kind === 'openai' ? clean(env[`${prefix}BASE_URL`])?.replace(/\/+$/, '') : undefined;
  // The search assistant on the same provider and address as the language model uses its key: the key goes to the
  // address it was given for, and is kept once.
  const sameAsMain = prefix !== 'LLM_' && clean(env.LLM_PROVIDER) === kind && (kind === 'anthropic' || clean(env.LLM_BASE_URL)?.replace(/\/+$/, '') === baseUrl);
  const apiKey = clean(env[`${prefix}API_KEY`]) ?? (sameAsMain ? clean(env.LLM_API_KEY) : undefined);
  if (kind === 'anthropic') return apiKey ? { kind, apiKey, model } : null;
  return baseUrl ? { kind, baseUrl, apiKey, model } : null;
}
export const llmConfigured = (): boolean => llmSettings() !== null;

/** The model the search assistant uses: its own when one is set, otherwise the language model. */
export function searchLlmSettings(env: NodeJS.ProcessEnv = process.env): LlmSettings | null {
  return llmSettings(env, 'SEARCH_LLM_') ?? llmSettings(env);
}
/** A model of its own is set for the search assistant (and works). */
export const searchLlmOwn = (env: NodeJS.ProcessEnv = process.env): boolean => llmSettings(env, 'SEARCH_LLM_') !== null;

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

export const CALL_TIMEOUT_MS = 5 * 60_000;
export const host = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// ── Claude, through Anthropic's SDK ──

/** Anthropic's own API: where a key saved for Claude goes, and nowhere else. */
export const ANTHROPIC_API = 'https://api.anthropic.com';

/**
 * The headers ANTHROPIC_CUSTOM_HEADERS asks the SDK to add ("Name: value", one per line), each set to null, which the
 * SDK takes as "do not send".
 */
function inheritedHeadersOff(): Record<string, null> {
  const names = (process.env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n').map((line) => (line.includes(':') ? line.slice(0, line.indexOf(':')).trim() : ''));
  return Object.fromEntries(names.filter(Boolean).map((name) => [name, null]));
}

/**
 * A client for Claude that talks to Anthropic's own address and to nothing else. Left to itself the SDK takes the
 * address from ANTHROPIC_BASE_URL and extra headers from ANTHROPIC_CUSTOM_HEADERS, and a stdio server inherits the
 * environment of the client that starts it: Claude Code used through a company gateway sets both for itself. The key
 * saved here was given for Anthropic, so it must not go to that gateway, and the gateway's headers are not ours to send.
 */
export const claude = (s: Pick<LlmSettings, 'apiKey'>): Anthropic =>
  new Anthropic({ apiKey: s.apiKey, baseURL: anthropicEndpoint.baseURL ?? ANTHROPIC_API, defaultHeaders: inheritedHeadersOff() });

/** What went wrong, from the SDK's own error classes, in words for the page. */
export function claudeError(e: unknown): LlmError {
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
export const HAS_FALLBACK = /^claude-(fable-5-[12]|opus-5(-5)?|sonnet-5-5)$/;

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

export function openaiError(s: Pick<LlmSettings, 'baseUrl'>, status: number, body: Record<string, unknown>): LlmError {
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

// ── A ChatGPT plan, through OpenAI's sign-in (chatgpt.ts) ──

/** ChatgptError, as the error everything else here throws. */
export function asLlmError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  if (e instanceof ChatgptError) return new LlmError(e.message, e.retry);
  return new LlmError(e instanceof Error ? e.message : String(e));
}

async function askChatgpt(s: LlmSettings, req: LlmRequest): Promise<LlmAnswer> {
  // The plan route takes the instructions as `instructions` (a system message in the input is refused) and no
  // output limit: the model's own limit applies.
  const body = { model: s.model, ...(req.system ? { instructions: req.system } : {}), input: [{ role: 'user', content: req.prompt }] };
  let text = '';
  let model = s.model;
  const usage = { input: 0, output: 0, cached: 0 };
  try {
    for await (const e of chatgptResponses(body, req.signal ?? new AbortController().signal)) {
      if (e.type === 'response.output_text.delta' && typeof e.delta === 'string') text += e.delta;
      if (e.type === 'response.completed') {
        model = e.response?.model ?? model;
        usage.input = e.response?.usage?.input_tokens ?? 0;
        usage.output = e.response?.usage?.output_tokens ?? 0;
        usage.cached = e.response?.usage?.input_tokens_details?.cached_tokens ?? 0;
      }
    }
  } catch (e) {
    throw asLlmError(e);
  }
  return { text, model, usage, cutOff: false };
}

// ── What the rest of the server calls ──

/** The models the provider offers this key. */
export async function listLlmModels(s: Omit<LlmSettings, 'model'>): Promise<LlmModel[]> {
  if (s.kind === 'chatgpt') return chatgptModels().catch((e) => Promise.reject(asLlmError(e)));
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
  // The SDK retries by itself. A plain endpoint and a ChatGPT plan are retried here, the same way: a failure that
  // passes (a limit, a provider that is busy) is asked again twice, after a pause that doubles. LLM_RETRY_MS sets
  // the first pause (1500 ms).
  if (settings.kind === 'anthropic') return askClaude(settings, req);
  const first = Number(process.env.LLM_RETRY_MS) || 1500;
  for (let attempt = 0; ; attempt++) {
    try {
      return settings.kind === 'chatgpt' ? await askChatgpt(settings, req) : await askOpenai(settings, req);
    } catch (e) {
      if (!(e instanceof LlmError) || !e.retry || attempt >= 2) throw e;
      await pause(first * 2 ** attempt, req.signal);
    }
  }
}

/** Is the connection good? One short question, with the settings as given (before they are saved). */
export async function checkLlm(settings: LlmSettings): Promise<{ model: string }> {
  const answer = await ask({ prompt: 'Reply with the single word: ready', maxTokens: 2000 }, settings);
  if (!answer.text.trim() && !answer.cutOff) throw new LlmError(`${settings.model} answered with nothing. Pick another model.`);
  return { model: settings.model };
}
