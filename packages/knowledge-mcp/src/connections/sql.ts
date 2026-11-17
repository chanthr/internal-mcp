/**
 * Reads a SQL query written with named parameters (`:email`) so it can be run with bound values.
 *
 * Values are never pasted into the SQL text. Each `:name` becomes a placeholder the database fills in itself, so
 * whatever a caller passes is data, never SQL. This module only finds the names; it does not understand SQL.
 *
 * What is skipped while looking for names: string literals ('it''s'), quoted identifiers ("a:b"), comments and the
 * cast operator (::text). The two databases differ, so the text is read the way its database reads it:
 *   postgres   slash-star comments nest, $tag$ ... $tag$ is a string
 *   sqlite     slash-star comments do not nest, [name] and `name` are quoted identifiers, no dollar strings
 *
 * This reading is for finding parameters and for early, friendly errors. It is not what keeps a read-only query
 * from writing: a reader and a database can always disagree somewhere. That is enforced by the database (see
 * postgres.ts and sqlite.ts).
 */

export type SqlDialect = 'postgres' | 'sqlite';

export interface ParsedSql {
  /** The query as written, without the semicolon that ends it (a comment after it stays). */
  text: string;
  /** The same query with every `:name` replaced by $1, $2, … (one number per name). */
  positional: string;
  /** Parameter names in order of first use. `positional` numbers them in this order. */
  names: string[];
  /** First word of the statement, lowercase ("select", "with", "insert", …). Empty for an empty query. */
  firstKeyword: string;
  /** Statements found (separated by semicolons). Only 1 can be run. */
  statements: number;
}

const isNameStart = (c: string) => /[A-Za-z_]/.test(c);
const isNameChar = (c: string) => /[A-Za-z0-9_]/.test(c);

export function parseSql(sql: string, dialect: SqlDialect = 'postgres'): ParsedSql {
  const names: string[] = [];
  let positional = '';
  let text = ''; // the query without statement-ending semicolons
  let firstKeyword = '';
  let statements = 0;
  let inStatement = false; // has the current statement any content yet?
  const n = sql.length;
  let i = 0;

  /** Copy sql[i..end) unchanged. */
  const copyTo = (end: number) => {
    positional += sql.slice(i, end);
    text += sql.slice(i, end);
    i = end;
  };
  const content = () => {
    if (!inStatement) {
      inStatement = true;
      statements++;
    }
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      copyTo(end === -1 ? n : end);
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (dialect === 'postgres' && sql[j] === '/' && sql[j + 1] === '*') {
          depth++; // only Postgres nests comments
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      copyTo(j);
      continue;
    }
    if (c === "'" || c === '"') {
      content();
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2; // doubled quote = one quote character
          else break;
        } else j++;
      }
      copyTo(Math.min(n, j + 1));
      continue;
    }
    if (dialect === 'sqlite' && (c === '[' || c === '`')) {
      // [name] and `name` quote an identifier in SQLite. A quote character inside is not a string.
      content();
      const close = sql.indexOf(c === '[' ? ']' : '`', i + 1);
      copyTo(close === -1 ? n : close + 1);
      continue;
    }
    if (c === '$' && dialect === 'postgres') {
      // $tag$ ... $tag$ (the tag may be empty). `$1` is not a dollar quote.
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 70));
      if (m) {
        content();
        const close = sql.indexOf(m[0], i + m[0].length);
        copyTo(close === -1 ? n : close + m[0].length);
        continue;
      }
    }
    if (c === ':' && next === ':') {
      copyTo(i + 2); // a cast, not a parameter
      continue;
    }
    if (c === ':' && next !== undefined && isNameStart(next) && (i === 0 || !isNameChar(sql[i - 1]))) {
      content();
      let j = i + 1;
      while (j < n && isNameChar(sql[j])) j++;
      const name = sql.slice(i + 1, j);
      let idx = names.indexOf(name);
      if (idx === -1) idx = names.push(name) - 1;
      positional += `$${idx + 1}`;
      text += sql.slice(i, j);
      i = j;
      continue;
    }
    if (c === ';') {
      // Not copied: a single statement is run without its ending semicolon, so it can be wrapped (… limit n)
      // even when a comment follows the semicolon.
      inStatement = false;
      i++;
      continue;
    }
    if (!/\s/.test(c)) {
      if (!firstKeyword && isNameStart(c)) {
        let j = i;
        while (j < n && isNameChar(sql[j])) j++;
        firstKeyword = sql.slice(i, j).toLowerCase();
      }
      content();
    }
    copyTo(i + 1);
  }

  // With several statements nothing is run, and the text is kept as written for the error message.
  const single = statements <= 1;
  return {
    text: single ? text.trimEnd() : sql,
    positional: single ? positional.trimEnd() : sql,
    names,
    firstKeyword,
    statements,
  };
}

/** Statements that only read. A read-only tool must start with one of these. */
const READ_KEYWORDS = new Set(['select', 'with', 'values', 'table']);

/**
 * Why this query cannot be a tool, or null when it can. `readOnly` adds the rule that it must start with a reading
 * statement. The database enforces read-only on its own as well (a read-only transaction or connection); this
 * check is what stops statements that are not reads or writes of rows, such as ATTACH or PRAGMA.
 */
export function sqlProblem(parsed: ParsedSql, readOnly: boolean): string | null {
  if (parsed.statements === 0) return 'the query is empty';
  if (parsed.statements > 1) return 'only one statement can be run; remove everything after the first semicolon';
  if (readOnly && !READ_KEYWORDS.has(parsed.firstKeyword)) {
    return `a read-only query must start with SELECT, WITH, VALUES or TABLE (this one starts with ${parsed.firstKeyword ? parsed.firstKeyword.toUpperCase() : 'something else'})`;
  }
  return null;
}
