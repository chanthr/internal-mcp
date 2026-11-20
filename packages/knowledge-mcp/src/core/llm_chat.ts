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
import { asLlmError, CALL_TIMEOUT_MS, claude, claudeError, HAS_FALLBACK, host, LlmError, openaiError, type LlmSettings } from './llm.js';
import { chatgptResponses } from './chatgpt.js';

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
  /**
   * Most tokens one answer of the model may have (Claude and OpenAI-compatible endpoints). A model that writes on
   * and on is cut there instead of running until the time limit.
   */
  maxTokens?: number;
  /**
   * A tool that ends the conversation: once it has run without error, the model is not asked again. (A search
   * assistant hands in its result through a tool; asking it once more would only cost a turn.) In the last round
   * maxSteps allows it is the only tool offered, so that the work ends with it rather than being cut off.
   */
  endsWith?: string;
  /** Told when a round of tool calls starts, with its number (1, 2, …): a tool can say how many are left. */
  onRound?: (round: number) => void;
  /**
   * With endsWith: said to the model once when it stops without calling that tool, so that it does. A model that
   * writes its result as text instead of handing it in gets one more turn.
   */
  nudge?: string;
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
/** The tools offered for the next round: only the ending one in the last round there is. */
const lastRound = (req: ChatRequest, steps: number): boolean => !!req.endsWith && steps === (req.maxSteps ?? STEPS) - 1;
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
  let nudged = false;
  for (;;) {
    if (usage.steps >= (req.maxSteps ?? STEPS)) return { model, usage, note: `Stopped after ${usage.steps} rounds of tool calls.` };
    const body = {
      model: s.model,
      max_tokens: req.maxTokens ?? 16_000,
      // The same from message to message: kept by the provider and read again at a tenth of the price.
      system: [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }],
      tools: lastRound(req, usage.steps) ? tools.filter((t) => t.name === req.endsWith) : tools,
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
    if (uses.length === 0 && req.nudge && !nudged) {
      nudged = true;
      messages.push({ role: 'assistant', content: message.content }, { role: 'user', content: req.nudge });
      continue;
    }
    if (uses.length === 0) return { model, usage, note: null };
    usage.steps++;
    req.onRound?.(usage.steps);
    messages.push({ role: 'assistant', content: message.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    let ended = false;
    for (const u of uses) {
      const r = await callTool(req, u.id, u.name, objectOf(u.input));
      if (r.ok && u.name === req.endsWith) ended = true;
      results.push({ type: 'tool_result', tool_use_id: u.id, content: r.text, ...(r.ok ? {} : { is_error: true }) });
    }
    if (ended) return { model, usage, note: null };
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
  let nudged = false;
  for (;;) {
    if (usage.steps >= (req.maxSteps ?? STEPS)) return { model, usage, note: `Stopped after ${usage.steps} rounds of tool calls.` };
    const limit = AbortSignal.timeout(CALL_TIMEOUT_MS);
    let res: Response;
    const offered = lastRound(req, usage.steps) ? tools.filter((t) => t.function.name === req.endsWith) : tools;
    try {
      res = await fetch(`${s.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
        body: JSON.stringify({
          model: s.model,
          messages,
          ...(offered.length ? { tools: offered } : {}),
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
          stream: true,
          ...(withUsage ? { stream_options: { include_usage: true } } : {}),
        }),
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
    if (asked.length === 0 && req.nudge && !nudged) {
      nudged = true;
      messages.push({ role: 'assistant', content: rest || null }, { role: 'user', content: req.nudge });
      continue;
    }
    if (asked.length === 0) return { model, usage, note: null };
    usage.steps++;
    req.onRound?.(usage.steps);
    messages.push({ role: 'assistant', content: rest || null, tool_calls: asked.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) });
    let ended = false;
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
      if (r.ok && c.name === req.endsWith) ended = true;
      messages.push({ role: 'tool', tool_call_id: c.id, content: r.ok ? r.text : `Error: ${r.text}` });
    }
    if (ended) return { model, usage, note: null };
  }
}

// ── A ChatGPT plan: the Responses API, through OpenAI's sign-in ──

/** The namespace the server's tools are grouped in: the plan route takes function tools only inside one. */
const NAMESPACE = 'knowledge_mcp';

async function chatChatgpt(s: LlmSettings, req: ChatRequest): Promise<ChatEnd> {
  const toolsOf = (list: ChatTool[]) =>
    list.length
      ? [{ type: 'namespace', name: NAMESPACE, description: "This server's tools: documents, connected apps and data.", tools: list.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: schemaOf(t.inputSchema), strict: false })) }]
      : [];
  const all = toolsOf(req.tools);
  const ending = toolsOf(req.tools.filter((t) => t.name === req.endsWith));
  // Nothing is kept at OpenAI (store: false): every request carries the conversation so far.
  const input: Array<Record<string, unknown>> = [...req.history.map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: req.message }];
  const usage: ChatUsage = { input: 0, output: 0, cached: 0, steps: 0 };
  let model = s.model;
  let nudged = false;
  for (;;) {
    if (usage.steps >= (req.maxSteps ?? STEPS)) return { model, usage, note: `Stopped after ${usage.steps} rounds of tool calls.` };
    let text = '';
    const calls: Array<Record<string, unknown>> = [];
    try {
      const tools = lastRound(req, usage.steps) ? ending : all;
      for await (const e of chatgptResponses({ model: s.model, instructions: req.system, input, ...(tools.length ? { tools } : {}) }, req.signal)) {
        if (e.type === 'response.output_text.delta' && typeof e.delta === 'string') {
          text += e.delta;
          req.emit({ type: 'text', text: e.delta });
        } else if (e.type === 'response.reasoning_summary_text.delta' || e.type === 'response.reasoning_text.delta') {
          req.emit({ type: 'thinking' });
        } else if (e.type === 'response.output_item.done' && e.item?.type === 'function_call') {
          calls.push(e.item);
        } else if (e.type === 'response.completed') {
          model = e.response?.model ?? model;
          usage.input += e.response?.usage?.input_tokens ?? 0;
          usage.output += e.response?.usage?.output_tokens ?? 0;
          usage.cached += e.response?.usage?.input_tokens_details?.cached_tokens ?? 0;
        }
      }
    } catch (e) {
      if (req.signal.aborted) throw e;
      throw asLlmError(e);
    }
    if (calls.length === 0 && req.nudge && !nudged) {
      nudged = true;
      if (text) input.push({ role: 'assistant', content: text });
      input.push({ role: 'user', content: req.nudge });
      continue;
    }
    if (calls.length === 0) return { model, usage, note: null };
    usage.steps++;
    req.onRound?.(usage.steps);
    if (text) input.push({ role: 'assistant', content: text });
    let ended = false;
    for (const c of calls) {
      // The call goes back as it came, without its item ID: without stored reasoning, an ID would ask for it.
      const { id: _id, status: _status, ...call } = c;
      input.push(call);
      const name = String(c.name ?? '').replace(new RegExp(`^${NAMESPACE}[.:/_]{1,2}`), '');
      const callId = String(c.call_id ?? '');
      let args: Record<string, unknown> | null = null;
      try {
        args = objectOf(JSON.parse(String(c.arguments ?? '{}')));
      } catch {
        /* answered below */
      }
      const r = args ? await callTool(req, callId, name, args) : { ok: false, text: 'The arguments were not valid JSON. Call the tool again with a JSON object.' };
      if (r.ok && name === req.endsWith) ended = true;
      input.push({ type: 'function_call_output', call_id: callId, output: r.ok ? r.text : `Error: ${r.text}` });
    }
    if (ended) return { model, usage, note: null };
  }
}

/** One message of the conversation, answered with the tools, streamed through `emit`. */
export async function converse(req: ChatRequest, settings: LlmSettings): Promise<ChatEnd> {
  if (settings.kind === 'chatgpt') return chatChatgpt(settings, req);
  return settings.kind === 'anthropic' ? chatClaude(settings, req) : chatOpenai(settings, req);
}
