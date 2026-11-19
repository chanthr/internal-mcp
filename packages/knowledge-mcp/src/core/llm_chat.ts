/**
 * A conversation with the connected model in which it calls tools, streamed as it happens. The console's chat uses
 * it: the person asks, the model uses this server's tools the way an AI client would, and the page shows each call
 * and its result as it comes.
 *
 * Both kinds of connection (llm.ts):
 *   anthropic   the official SDK's message stream, tool use in a loop
 *   openai      /chat/completions with `tools` and `stream: true`: OpenRouter, OpenAI, Ollama, vLLM, …
 *
 * Nothing is kept here: the caller sends the conversation so far (the text of each turn) with every message.
 */
import Anthropic from '@anthropic-ai/sdk';
import { CALL_TIMEOUT_MS, claude, claudeError, HAS_FALLBACK, host, LlmError, openaiError, type LlmSettings } from './llm.js';

export interface ChatTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments, as an MCP client gets it. */
  inputSchema: Record<string, unknown>;
}
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}
export type ChatEvent =
  /** A piece of the answer. */
  | { type: 'text'; text: string }
  /** The model is reasoning before it answers (its reasoning is not shown). */
  | { type: 'thinking' }
  /** The model calls a tool. */
  | { type: 'tool'; id: string; name: string; input: unknown }
  /** What the tool gave back. */
  | { type: 'result'; id: string; ok: boolean; text: string; ms: number }
  | { type: 'done'; model: string; usage: ChatUsage; note: string | null }
  | { type: 'error'; message: string };
export interface ChatUsage {
  input: number;
  output: number;
  cached: number;
  steps: number;
}
export interface ChatRequest {
  system: string;
  history: ChatTurn[];
  message: string;
  tools: ChatTool[];
  /** Run one tool. Throws only for a failure of the server; a tool's own error comes back as ok: false. */
  run: (name: string, input: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
  emit: (e: ChatEvent) => void;
  signal: AbortSignal;
  /** Rounds of tool calls before the model is stopped. */
  maxSteps?: number;
}
export interface ChatEnd {
  model: string;
  usage: ChatUsage;
  /** Why it ended early, in a sentence, or null. */
  note: string | null;
}

const STEPS = 12;
/** A tool result goes back to the model shortened to this: a search returns a few thousand characters. */
const RESULT_CHARS = 30_000;
const shorten = (text: string): string => (text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}\n… [${text.length - RESULT_CHARS} more characters left out]` : text);
const objectOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** A JSON Schema as both APIs take it: an object schema, without the draft marker. */
function schemaOf(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _drop, ...rest } = schema;
  return { ...rest, type: 'object', properties: objectOf(rest.properties) };
}

async function callTool(req: ChatRequest, id: string, name: string, input: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  req.emit({ type: 'tool', id, name, input });
  const started = Date.now();
  const known = req.tools.some((t) => t.name === name);
  const r = known ? await req.run(name, input) : { ok: false, text: `There is no tool named ${name} here.` };
  req.emit({ type: 'result', id, ok: r.ok, text: r.text, ms: Date.now() - started });
  return { ok: r.ok, text: shorten(r.text) };
}

// ── Claude ──

async function chatClaude(s: LlmSettings, req: ChatRequest): Promise<ChatEnd> {
  const client = claude(s);
  // Inputs stream as the model writes them; the registry checks each against the tool's schema before it runs.
  const tools: Anthropic.Tool[] = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: schemaOf(t.inputSchema) as Anthropic.Tool.InputSchema, eager_input_streaming: true }));
  const messages: Anthropic.MessageParam[] = [...req.history.map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: req.message }];
  const usage: ChatUsage = { input: 0, output: 0, cached: 0, steps: 0 };
  let model = s.model;
  let unreadable = 0;
  for (;;) {
    if (usage.steps >= (req.maxSteps ?? STEPS)) return { model, usage, note: `Stopped after ${usage.steps} rounds of tool calls.` };
    const body = {
      model: s.model,
      max_tokens: 16_000,
      // The same from message to message: kept by the provider and read again at a tenth of the price.
      system: [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }],
      tools,
      messages,
    };
    const options = { signal: req.signal, timeout: CALL_TIMEOUT_MS };
    const onText = (delta: string) => req.emit({ type: 'text', text: delta });
    // The two streams are the same but for their types: each is listened to as it is.
    const final = (): Promise<unknown> => {
      if (HAS_FALLBACK.test(s.model)) {
        const beta = client.beta.messages.stream({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as unknown as Parameters<typeof client.beta.messages.stream>[0], options);
        beta.on('text', onText);
        return beta.finalMessage();
      }
      const plain = client.messages.stream(body, options);
      plain.on('text', onText);
      return plain.finalMessage();
    };
    let message: Anthropic.Message;
    try {
      message = (await final()) as Anthropic.Message;
      unreadable = 0;
    } catch (e) {
      if (req.signal.aborted) throw e;
      // A tool input that could not be read at all is asked for again, twice at most. Anything else is the API's.
      if (e instanceof Anthropic.APIError || unreadable++ >= 2) throw claudeError(e);
      continue;
    }
    model = message.model;
    usage.input += message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0);
    usage.output += message.usage.output_tokens;
    usage.cached += message.usage.cache_read_input_tokens ?? 0;
    if (message.stop_reason === 'refusal') throw new LlmError('The model declined this request.');
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }
    const uses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    // A tool input cut off at the length limit may still read as an object: it is not run.
    if (message.stop_reason === 'max_tokens') return { model, usage, note: 'The answer was cut off at the length limit.' };
    if (uses.length === 0) return { model, usage, note: null };
    usage.steps++;
    messages.push({ role: 'assistant', content: message.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      const r = await callTool(req, u.id, u.name, objectOf(u.input));
      results.push({ type: 'tool_result', tool_use_id: u.id, content: r.text, ...(r.ok ? {} : { is_error: true }) });
    }
    messages.push({ role: 'user', content: results });
  }
}

// ── Any endpoint that speaks OpenAI's chat completions ──

interface Delta {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
}
interface Chunk {
  model?: string;
  choices?: Array<{ delta?: Delta; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  error?: { message?: string } | string;
}

/**
 * The part of an answer to show: some models write their reasoning into the answer inside <think>…</think>. While
 * it streams, a tag that is not finished yet is held back, so that nothing shown has to be taken back.
 */
export function visibleText(text: string, final: boolean): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
  const open = out.indexOf('<think>');
  if (open >= 0) out = out.slice(0, open);
  if (!final) {
    for (let n = Math.min(7, out.length); n > 0; n--) {
      if ('<think>'.startsWith(out.slice(-n))) {
        out = out.slice(0, -n);
        break;
      }
    }
  }
  return out;
}

/** The server-sent events of a streamed answer, one parsed chunk at a time. */
async function* chunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Chunk> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const part of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data) as Chunk;
      } catch {
        /* a keep-alive or a line that is not JSON */
      }
    }
  }
}

type OpenaiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

async function chatOpenai(s: LlmSettings, req: ChatRequest): Promise<ChatEnd> {
  const tools = req.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: schemaOf(t.inputSchema) } }));
  const messages: OpenaiMessage[] = [{ role: 'system', content: req.system }, ...req.history.map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: req.message }];
  const usage: ChatUsage = { input: 0, output: 0, cached: 0, steps: 0 };
  let model = s.model;
  let withUsage = true;
  for (;;) {
    if (usage.steps >= (req.maxSteps ?? STEPS)) return { model, usage, note: `Stopped after ${usage.steps} rounds of tool calls.` };
    const limit = AbortSignal.timeout(CALL_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${s.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
        body: JSON.stringify({ model: s.model, messages, ...(tools.length ? { tools } : {}), stream: true, ...(withUsage ? { stream_options: { include_usage: true } } : {}) }),
        signal: AbortSignal.any([req.signal, limit]),
      });
    } catch (e) {
      if (req.signal.aborted) throw e;
      const cause = (e as { cause?: { code?: string } }).cause;
      throw new LlmError(`${host(s.baseUrl ?? '')} could not be reached (${cause?.code ?? (e instanceof Error ? e.message : String(e))}).`, true);
    }
    if (res.status !== 200 || !res.body) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      // A server that does not know stream_options says so once; it is asked again without.
      if (withUsage && res.status === 400 && /stream_options|include_usage/i.test(JSON.stringify(body))) {
        withUsage = false;
        continue;
      }
      throw openaiError(s, res.status, body);
    }

    let text = '';
    let shown = '';
    let thinking = false;
    let finish: string | null = null;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const chunk of chunks(res.body)) {
      if (chunk.error) throw new LlmError(`${host(s.baseUrl ?? '')}: ${String(typeof chunk.error === 'string' ? chunk.error : chunk.error.message ?? 'error').slice(0, 200)}`);
      if (typeof chunk.model === 'string') model = chunk.model;
      if (chunk.usage) {
        usage.input += chunk.usage.prompt_tokens ?? 0;
        usage.output += chunk.usage.completion_tokens ?? 0;
        usage.cached += chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const d = choice.delta ?? {};
      if ((d.reasoning || d.reasoning_content) && !thinking) {
        thinking = true;
        req.emit({ type: 'thinking' });
      }
      if (typeof d.content === 'string' && d.content) {
        text += d.content;
        const now = visibleText(text, false);
        if (now.length > shown.length && now.startsWith(shown)) {
          req.emit({ type: 'text', text: now.slice(shown.length) });
          shown = now;
        }
      }
      for (const [n, t] of (d.tool_calls ?? []).entries()) {
        const index = typeof t.index === 'number' ? t.index : n;
        const call = calls.get(index) ?? { id: '', name: '', args: '' };
        if (t.id) call.id = t.id;
        if (t.function?.name) call.name += t.function.name;
        if (t.function?.arguments) call.args += t.function.arguments;
        calls.set(index, call);
      }
    }
    const rest = visibleText(text, true);
    if (rest.length > shown.length && rest.startsWith(shown)) req.emit({ type: 'text', text: rest.slice(shown.length) });
    if (finish === 'content_filter') throw new LlmError('The model declined this request.');
    const asked = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => ({ ...c, id: c.id || `call_${usage.steps}_${n}` }));
    if (finish === 'length') return { model, usage, note: 'The answer was cut off at the length limit.' };
    if (asked.length === 0) return { model, usage, note: null };
    usage.steps++;
    messages.push({ role: 'assistant', content: rest || null, tool_calls: asked.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) });
    for (const c of asked) {
      let input: Record<string, unknown> | null = null;
      try {
        input = objectOf(JSON.parse(c.args || '{}'));
      } catch {
        /* answered below */
      }
      const r = input
        ? await callTool(req, c.id, c.name, input)
        : (req.emit({ type: 'tool', id: c.id, name: c.name, input: c.args }), req.emit({ type: 'result', id: c.id, ok: false, text: 'The arguments were not valid JSON.', ms: 0 }), { ok: false, text: 'The arguments were not valid JSON. Call the tool again with a JSON object.' });
      messages.push({ role: 'tool', tool_call_id: c.id, content: r.ok ? r.text : `Error: ${r.text}` });
    }
  }
}

/** One message of the conversation, answered with the tools, streamed through `emit`. */
export async function converse(req: ChatRequest, settings: LlmSettings): Promise<ChatEnd> {
  return settings.kind === 'anthropic' ? chatClaude(settings, req) : chatOpenai(settings, req);
}
