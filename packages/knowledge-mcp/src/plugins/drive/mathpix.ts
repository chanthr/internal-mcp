/**
 * Mathpix OCR: scanned PDF or image → markdown.
 *
 * Keys: MATHPIX_APP_ID / MATHPIX_APP_KEY.
 *
 * - PDF (scanned): v3/pdf (async), upload → poll → /pdf/{id}.md
 * - Image: v3/text (immediate)
 *
 * Formula and table structure is kept (Mathpix Markdown), so tables survive chunking and search quality improves.
 */
const MATHPIX_API = 'https://api.mathpix.com/v3';

/** OCR is used only when both keys are set (README: scanned PDFs and images are OCRed only when the keys exist). */
export function mathpixConfigured(): boolean {
  return !!process.env.MATHPIX_APP_ID && !!process.env.MATHPIX_APP_KEY;
}

function mathpixHeaders(): Record<string, string> {
  const appId = process.env.MATHPIX_APP_ID;
  const appKey = process.env.MATHPIX_APP_KEY;
  if (!appId || !appKey) throw new Error('[mathpix] MATHPIX_APP_ID / MATHPIX_APP_KEY is not set');
  return { app_id: appId, app_key: appKey };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch wrapped with a timeout and retries. Previously no fetch had either, so status polling hung until the deadline
 * when the network stalled, and one transient 5xx failed the whole OCR. AbortSignal.timeout plus a short retry on
 * 5xx/network errors makes it stable (OCR is on a path where the user is waiting).
 */
async function mpFetch(
  url: string,
  init: RequestInit,
  timeoutMs = 30_000,
  retries = 2,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (resp.status >= 500 && resp.status <= 599 && attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return resp;
    } catch (e) {
      // timeout (TimeoutError) or network error: retry, throw when retries run out
      if (attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new Error(
        `[mathpix] fetch failed (${url.split('/').slice(-1)[0]}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/** PDF (scanned) → markdown. Async upload + poll + .md download. */
export async function mathpixPdfToMarkdown(buffer: Buffer, maxWaitSec = 180): Promise<string> {
  const headers = mathpixHeaders();

  // 1. Upload
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), 'doc.pdf');
  form.append(
    'options_json',
    JSON.stringify({
      conversion_formats: { md: true },
      math_inline_delimiters: ['$', '$'],
      rm_spaces: false,
      enable_tables_fallback: true,
      include_diagram_text: true, // also OCR the text inside diagrams (figure URLs are included in the .md by default)
    }),
  );

  const upResp = await mpFetch(`${MATHPIX_API}/pdf`, { method: 'POST', headers, body: form }, 60_000);
  if (!upResp.ok) throw new Error(`[mathpix] upload failed HTTP ${upResp.status}: ${(await upResp.text()).slice(0, 200)}`);
  const { pdf_id } = (await upResp.json()) as { pdf_id?: string };
  if (!pdf_id) throw new Error('[mathpix] missing pdf_id');

  // 2. Poll (every 2s)
  const deadline = Date.now() + maxWaitSec * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const stResp = await mpFetch(`${MATHPIX_API}/pdf/${pdf_id}`, { headers });
    const stData = (await stResp.json()) as { status?: string };
    if (stData.status === 'completed') {
      // 3. Download the .md
      const mdResp = await mpFetch(`${MATHPIX_API}/pdf/${pdf_id}.md`, { headers });
      const md = await mdResp.text();
      if (!md.trim()) throw new Error('[mathpix] completed but empty markdown');
      return md;
    }
    if (stData.status === 'error') throw new Error('[mathpix] processing error');
  }
  throw new Error(`[mathpix] timeout ${maxWaitSec}s (pdf_id=${pdf_id})`);
}

/** Single image → markdown. v3/text (immediate). */
export async function mathpixImageToMarkdown(buffer: Buffer, mimeType: string): Promise<string> {
  const headers = { ...mathpixHeaders(), 'Content-Type': 'application/json' };
  const b64 = buffer.toString('base64');
  const resp = await mpFetch(`${MATHPIX_API}/text`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      src: `data:${mimeType};base64,${b64}`,
      formats: ['text', 'data'],
      math_inline_delimiters: ['$', '$'],
      rm_spaces: false,
    }),
  });
  if (!resp.ok) throw new Error(`[mathpix] image failed HTTP ${resp.status}`);
  const data = (await resp.json()) as { text?: string };
  return data.text ?? '';
}
