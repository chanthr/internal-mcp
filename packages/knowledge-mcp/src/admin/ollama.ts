/**
 * Ollama on this computer, for the models the console offers to read scans with: which ones are there, and
 * fetching one that is not (Ollama's own /api/pull, the same as `ollama pull <model>`).
 *
 * Only an Ollama on this computer is asked: the address must be localhost. The model name is checked by the route.
 */

/** The Ollama API base for an OpenAI-style address on this computer (http://localhost:11434/v1), or null. */
export function ollamaBase(openaiBase: string): string | null {
  try {
    const u = new URL(openaiBase);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** The models Ollama has here, or null when it does not answer (not installed, not running). */
export async function ollamaModels(openaiBase: string): Promise<string[] | null> {
  const base = ollamaBase(openaiBase);
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((m) => String(m.name ?? '')).filter(Boolean);
  } catch {
    return null;
  }
}

export interface PullState {
  model: string;
  running: boolean;
  /** What Ollama says it is doing ("pulling manifest", "downloading", "success"). */
  status: string;
  completed: number;
  total: number;
  error: string | null;
}
let pull: PullState | null = null;
export const pullState = (): PullState | null => (pull ? { ...pull } : null);

/** Fetch a model into Ollama. Returns at once; the page reads how far it is. One at a time. */
export function pullOllamaModel(openaiBase: string, model: string): PullState {
  if (pull?.running) return { ...pull };
  const base = ollamaBase(openaiBase);
  const state: PullState = { model, running: true, status: 'starting', completed: 0, total: 0, error: null };
  pull = state;
  if (!base) {
    Object.assign(state, { running: false, error: 'Models are fetched only into an Ollama on this computer.' });
    return { ...state };
  }
  void (async () => {
    try {
      const res = await fetch(`${base}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
      if (!res.ok || !res.body) throw new Error(`Ollama answered ${res.status}.`);
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(part, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          const e = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
          if (e.error) throw new Error(e.error);
          if (e.status) state.status = e.status;
          if (typeof e.total === 'number' && e.total > 0) {
            state.total = e.total;
            state.completed = e.completed ?? 0;
          }
        }
      }
      if (state.status !== 'success') throw new Error(`Ollama stopped at "${state.status}".`);
    } catch (e) {
      state.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    } finally {
      state.running = false;
    }
  })();
  return { ...state };
}
