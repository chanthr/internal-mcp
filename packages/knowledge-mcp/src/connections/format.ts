/**
 * Shapes what a database or an API returned into what the model reads: rows as objects, long values cut, the whole
 * answer kept under a size that fits a conversation, and a plain note whenever something was left out.
 */

/** Rows as a database adapter returns them. */
export interface Table {
  columns: string[];
  rows: unknown[][];
  /** More rows exist than were fetched. */
  truncated: boolean;
  /** Rows changed by a statement that writes. */
  changes?: number;
}

export const MAX_CELL_CHARS = 4000;
const MAX_RESULT_CHARS = 200_000;

const CUT_MARK = /… \[\d+ more characters\]$/;

/** Text cut at `max` characters, saying how much was left out. Text that was cut already is left alone. */
function cutText(text: string, max: number): string {
  if (text.length <= max || (text.length <= max + 40 && CUT_MARK.test(text))) return text;
  return `${text.slice(0, max)}… [${text.length - max} more characters]`;
}

/**
 * A value as it can be shown: dates as ISO text, binary data as a size, long text cut. An array or a JSON value
 * (Postgres) stays as it is when small; a large one becomes its JSON text, cut like any long text.
 */
export function cell(v: unknown, max = MAX_CELL_CHARS): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v instanceof Uint8Array) return `[binary, ${v.length} bytes]`;
  if (typeof v === 'string') return cutText(v, max);
  if (typeof v === 'object') {
    const json = JSON.stringify(v);
    return json.length > max ? cutText(json, max) : v;
  }
  return v;
}

/** Column names made unique (a join can return two columns called "id"): id, id_2, id_3. */
export function uniqueColumns(columns: string[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((c) => {
    const name = c || 'column';
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name}_${n}`;
  });
}

/** The answer of a SQL tool. */
export function tableResult(t: Table, maxRows: number): Record<string, unknown> {
  const columns = uniqueColumns(t.columns);
  let rows = t.rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, cell(r[i])])));
  let cut = t.truncated;
  // Keep the whole answer under the size limit by dropping rows from the end.
  let size = JSON.stringify(rows).length;
  if (size > MAX_RESULT_CHARS) {
    let kept = rows.length;
    while (kept > 1 && size > MAX_RESULT_CHARS) {
      kept = Math.max(1, Math.floor(kept * (MAX_RESULT_CHARS / size) * 0.95));
      size = JSON.stringify(rows.slice(0, kept)).length;
    }
    rows = rows.slice(0, kept);
    cut = true;
    // One row can be too large by itself (many long columns). Its values are cut further until it fits.
    for (let max = Math.floor(MAX_CELL_CHARS / 4); rows.length === 1 && JSON.stringify(rows).length > MAX_RESULT_CHARS && max >= 16; max = Math.floor(max / 4)) {
      rows = [Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, cell(v, max)]))];
    }
  }
  const out: Record<string, unknown> = { rowCount: rows.length };
  if (t.changes !== undefined) out.rowsChanged = t.changes;
  if (cut) {
    out.truncated = true;
    out.note = `Only the first ${rows.length} rows are shown${t.truncated ? ` (the limit is ${maxRows})` : ' (the answer was too large)'}. Narrow the question to see the rest; do not treat these rows as the complete answer.`;
  }
  if (columns.length) out.rows = rows;
  return out;
}

/** Text cut at a length, saying how much was left out. */
export function clip(text: string, max = MAX_RESULT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters were left out]` : text;
}
