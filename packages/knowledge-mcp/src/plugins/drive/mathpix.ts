/**
 * Mathpix OCR — 스캔 PDF / 이미지 → markdown.
 *
 * 키: MATHPIX_APP_ID / MATHPIX_APP_KEY.
 *
 * - PDF (스캔본): v3/pdf (async) — upload → poll → /pdf/{id}.md
 * - 이미지: v3/text (즉시)
 *
 * 수식·표 구조 보존 (Mathpix Markdown) → chunk 시 표 안 깨짐 → 검색 품질 ↑.
 */
const MATHPIX_API = 'https://api.mathpix.com/v3';

/** OCR 은 두 키가 모두 있을 때만 쓴다(README: 스캔 PDF·이미지는 키가 있을 때만 OCR). */
export function mathpixConfigured(): boolean {
  return !!process.env.MATHPIX_APP_ID && !!process.env.MATHPIX_APP_KEY;
}

function mathpixHeaders(): Record<string, string> {
  const appId = process.env.MATHPIX_APP_ID;
  const appKey = process.env.MATHPIX_APP_KEY;
  if (!appId || !appKey) throw new Error('[mathpix] MATHPIX_APP_ID / MATHPIX_APP_KEY 미설정');
  return { app_id: appId, app_key: appKey };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * timeout·재시도 감싼 fetch. 예전엔 어떤 fetch 도 timeout·재시도가 없어, status 폴링이 네트워크
 * 정체 시 deadline 까지 매달리고 일시 5xx 에 전체 OCR 이 실패했다. AbortSignal.timeout + 5xx/네트워크
 * 짧은 재시도로 안정화(OCR 은 유저 대기 경로).
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
      // timeout(TimeoutError)·네트워크 오류 — 재시도, 소진 시 throw
      if (attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new Error(
        `[mathpix] fetch 실패(${url.split('/').slice(-1)[0]}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/** PDF (스캔본) → markdown. async upload + poll + .md 다운로드. */
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
      include_diagram_text: true, // 다이어그램 내부 텍스트도 OCR (figure URL 은 .md 에 기본 포함)
    }),
  );

  const upResp = await mpFetch(`${MATHPIX_API}/pdf`, { method: 'POST', headers, body: form }, 60_000);
  if (!upResp.ok) throw new Error(`[mathpix] upload 실패 HTTP ${upResp.status}: ${(await upResp.text()).slice(0, 200)}`);
  const { pdf_id } = (await upResp.json()) as { pdf_id?: string };
  if (!pdf_id) throw new Error('[mathpix] pdf_id 없음');

  // 2. Poll (2s 간격)
  const deadline = Date.now() + maxWaitSec * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const stResp = await mpFetch(`${MATHPIX_API}/pdf/${pdf_id}`, { headers });
    const stData = (await stResp.json()) as { status?: string };
    if (stData.status === 'completed') {
      // 3. .md 다운로드
      const mdResp = await mpFetch(`${MATHPIX_API}/pdf/${pdf_id}.md`, { headers });
      const md = await mdResp.text();
      if (!md.trim()) throw new Error('[mathpix] completed but empty markdown');
      return md;
    }
    if (stData.status === 'error') throw new Error('[mathpix] 처리 error');
  }
  throw new Error(`[mathpix] timeout ${maxWaitSec}s (pdf_id=${pdf_id})`);
}

/** 단일 이미지 → markdown. v3/text (즉시). */
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
  if (!resp.ok) throw new Error(`[mathpix] image 실패 HTTP ${resp.status}`);
  const data = (await resp.json()) as { text?: string };
  return data.text ?? '';
}
