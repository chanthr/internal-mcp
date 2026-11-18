/**
 * The answer of a SQL tool is a compact table: the column names once, then one array per row. Tests that ask
 * "what is in row 0, column n" read it back as rows of objects through here.
 */
export function readTable(text: string): any {
  const answer = JSON.parse(text);
  if (!Array.isArray(answer?.columns) || !Array.isArray(answer?.rows)) return answer;
  const columns: string[] = answer.columns;
  return { ...answer, rows: answer.rows.map((row: unknown[]) => Object.fromEntries(columns.map((c, i) => [c, row[i]]))) };
}
