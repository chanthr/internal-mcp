/**
 * Reading scanned documents: PDF pages with no text layer, and images.
 *
 * Two kinds of OCR:
 *   model    A vision model behind an OpenAI-compatible /chat/completions. A model on this computer through
 *            Ollama (glm-ocr, deepseek-ocr, qwen3-vl, …, most of them published on Hugging Face), Hugging Face's
 *            Inference Providers (https://router.huggingface.co/v1), OpenRouter, or any such endpoint.
 *   mathpix  Mathpix's OCR service, as before (MATHPIX_APP_ID, MATHPIX_APP_KEY).
 *
 * Settings (env, written by the console):
 *   OCR_PROVIDER  model | mathpix. Left out with the Mathpix keys set, it is mathpix (as before this setting).
 *   OCR_BASE_URL  model: the API base, e.g. http://localhost:11434/v1
 *   OCR_API_KEY   model: the key, when the endpoint needs one
 *   OCR_MODEL     model: the model, as the endpoint names it
 *   OCR_PROMPT    model: what the model is asked with each page. Left out, the one its card gives (glm-ocr,
 *                 deepseek-ocr), or a plain request to write out the text.
 *
 * A PDF is drawn page by page (pdf-parse, which the index already uses) and each page is sent as an image. Pages
 * are read one at a time: a model on this computer does one thing at a time anyway.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../../core/paths.js';

export interface OcrSettings {
  kind: 'model' | 'mathpix';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  prompt: string;
}

/** The request each model was trained to read a page with, from its model card. */
const KNOWN_PROMPTS: Array<{ model: RegExp; prompt: string }> = [
  { model: /glm-ocr/i, prompt: 'Text Recognition:' },
  { model: /deepseek-ocr/i, prompt: 'Free OCR.' },
];
const GENERIC_PROMPT = 'Transcribe all the text in this image exactly as written, in reading order. Keep headings, lists and tables. Output only the text, with no comments.';
export function ocrPrompt(model: string | undefined): string {
  return KNOWN_PROMPTS.find((k) => model && k.model.test(model))?.prompt ?? GENERIC_PROMPT;
}

const clean = (v: string | undefined): string | undefined => v?.trim() || undefined;

/** The OCR in use, or null. */
export function ocrSettings(env: NodeJS.ProcessEnv = process.env): OcrSettings | null {
  const kind = clean(env.OCR_PROVIDER)?.toLowerCase();
  const mathpix = !!clean(env.MATHPIX_APP_ID) && !!clean(env.MATHPIX_APP_KEY);
  if (kind === 'model') {
    const baseUrl = clean(env.OCR_BASE_URL)?.replace(/\/+$/, '');
    const model = clean(env.OCR_MODEL);
    if (!baseUrl || !model) return null;
    return { kind: 'model', baseUrl, apiKey: clean(env.OCR_API_KEY), model, prompt: clean(env.OCR_PROMPT)?.replace(/\\n/g, '\n') ?? ocrPrompt(model) };
  }
  if (kind === 'mathpix' || (!kind && mathpix)) return mathpix ? { kind: 'mathpix', prompt: '' } : null;
  return null;
}
export const ocrConfigured = (): boolean => ocrSettings() !== null;

/** Does the OCR run on this computer (nothing leaves it, nothing is billed)? */
export function ocrIsLocal(s: OcrSettings | null = ocrSettings()): boolean {
  if (!s || s.kind !== 'model' || !s.baseUrl) return false;
  try {
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(s.baseUrl).hostname);
  } catch {
    return false;
  }
}

const host = (url: string | undefined): string => {
  try {
    return new URL(url ?? '').host;
  } catch {
    return url ?? '';
  }
};

/** Reasoning some models write before the answer, and a fence around the whole answer, are not text of the page. */
function pageText(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t);
  if (fenced) t = fenced[1];
  return t.trim();
}

/**
 * The OCR could not be used at all: not reached, too slow, broken for a moment (5xx), or set up wrong (a key it
 * does not take, a model it does not have). Not a fault of the file being read: a file that failed this way is
 * not given up on (ocr_run.ts).
 */
const unavailable = (message: string): Error => Object.assign(new Error(message), { ocrUnavailable: true });
export const ocrUnavailable = (e: unknown): boolean => !!(e as { ocrUnavailable?: boolean } | null)?.ocrUnavailable;

/** One image to text through the model. */
export async function ocrImageWithModel(image: Buffer, mime: string, s: OcrSettings, signal?: AbortSignal): Promise<string> {
  const limit = AbortSignal.timeout(5 * 60_000);
  let res: Response;
  try {
    res = await fetch(`${s.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
      body: JSON.stringify({
        model: s.model,
        temperature: 0,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } }, { type: 'text', text: s.prompt }] }],
      }),
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    const cause = (e as { cause?: { code?: string } }).cause;
    throw unavailable(`${host(s.baseUrl)} could not be reached (${cause?.code ?? (e instanceof Error ? e.message : String(e))}).`);
  }
  const body = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: string } | string };
  if (res.status !== 200) {
    const said = String((typeof body.error === 'string' ? body.error : body.error?.message) ?? '').slice(0, 200);
    if (res.status === 401 || res.status === 403) throw unavailable(`${host(s.baseUrl)} did not accept the key.`);
    if (res.status === 404) throw unavailable(`${host(s.baseUrl)} does not know the model ${s.model}${said ? ` (${said})` : ''}.`);
    const why = `${host(s.baseUrl)} answered ${res.status}${said ? `: ${said}` : ''}`;
    throw res.status >= 500 || res.status === 408 || res.status === 429 ? unavailable(why) : new Error(why);
  }
  const content = body.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('') : '';
  return pageText(text);
}

/** The width pages are drawn at: enough for small print, small enough to send quickly. */
const PAGE_WIDTH = 1400;

/**
 * A PDF's pages to text, one page at a time. `maxPages` caps a long scan (the rest is left out, and said so in the
 * text). Mathpix reads the whole file in one job.
 */
export async function ocrPdf(
  buffer: Buffer,
  s: OcrSettings,
  opts: { maxPages?: number; signal?: AbortSignal; onPage?: (done: number, total: number) => void } = {},
): Promise<{ text: string; pages: number; read: number }> {
  if (s.kind === 'mathpix') {
    const { mathpixPdfToMarkdown } = await import('./mathpix.js');
    return { text: await mathpixPdfToMarkdown(buffer), pages: 0, read: 0 };
  }
  const { PDFParse } = (await import('pdf-parse')) as unknown as { PDFParse: new (o: { data: Uint8Array }) => { getInfo(): Promise<{ total?: number }>; getScreenshot(p: object): Promise<{ pages: Array<{ data: Uint8Array }> }>; destroy(): Promise<void> } };
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const total = (await parser.getInfo()).total ?? 1;
    const read = Math.min(total, opts.maxPages ?? total);
    const parts: string[] = [];
    for (let n = 1; n <= read; n++) {
      if (opts.signal?.aborted) throw new Error('Stopped.');
      opts.onPage?.(n - 1, read);
      const shot = await parser.getScreenshot({ partial: [n], desiredWidth: PAGE_WIDTH, imageDataUrl: false });
      const png = shot.pages[0]?.data;
      if (!png) continue;
      const text = await ocrImageWithModel(Buffer.from(png), 'image/png', s, opts.signal);
      if (text) parts.push(text);
    }
    opts.onPage?.(read, read);
    const rest = total - read;
    return { text: parts.join('\n\n') + (rest > 0 ? `\n\n[${rest} more page${rest === 1 ? '' : 's'} not read]` : ''), pages: total, read };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/** An image to text, with whichever OCR is set. */
export async function ocrImage(image: Buffer, mime: string, s: OcrSettings, signal?: AbortSignal): Promise<string> {
  if (s.kind === 'mathpix') {
    const { mathpixImageToMarkdown } = await import('./mathpix.js');
    return mathpixImageToMarkdown(image, mime);
  }
  return ocrImageWithModel(image, mime, s, signal);
}

// ── What was read, kept: reading a scan again costs minutes, or money ──

interface Kept {
  /** The file as it was when read: its size and modified time. A changed file is read again. */
  stamp: string;
  /** Which OCR read it. */
  by: string;
  text: string;
  pages: number;
}
const keptPath = (key: string) => join(dataDir(), 'ocr', `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
export const ocrBy = (s: OcrSettings): string => (s.kind === 'mathpix' ? 'mathpix' : `${s.model}@${host(s.baseUrl)}`);

/** The text read from this file before, while the file is unchanged. Any OCR's reading is used. */
export function keptOcr(key: string, stamp: string): Kept | null {
  try {
    const k = JSON.parse(readFileSync(keptPath(key), 'utf8')) as Kept;
    return k.stamp === stamp && typeof k.text === 'string' ? k : null;
  } catch {
    return null;
  }
}
export function keepOcr(key: string, value: Kept): void {
  mkdirSync(join(dataDir(), 'ocr'), { recursive: true, mode: 0o700 });
  writeFileSync(keptPath(key), JSON.stringify(value), { mode: 0o600 });
}

// ── Checking a connection before it is saved ──

/**
 * A one-page PDF with a known line on it, drawn the way a scan is: the check sends it to the model and looks for
 * the line in what comes back. Written by hand so the check needs nothing but the PDF reader the index has.
 */
export function checkPdf(line: string): Buffer {
  const stream = `BT /F1 36 Tf 60 400 Td (${line.replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Is this OCR good to use? One drawn page is read; the line on it must come back. */
export async function checkOcr(s: OcrSettings): Promise<{ seconds: number }> {
  const started = Date.now();
  if (s.kind === 'mathpix') {
    // A Mathpix check would be billed: the keys are taken as they are, and the first scan tells.
    return { seconds: 0 };
  }
  const code = String(Math.floor(1000 + Math.random() * 9000));
  const r = await ocrPdf(checkPdf(`Knowledge MCP check ${code}`), s, { maxPages: 1 });
  if (!r.text.includes(code)) {
    throw new Error(`${s.model} answered, but did not read the test page (it wrote: "${r.text.replace(/\s+/g, ' ').slice(0, 80)}"). Pick a model that reads images.`);
  }
  return { seconds: Math.round((Date.now() - started) / 100) / 10 };
}
