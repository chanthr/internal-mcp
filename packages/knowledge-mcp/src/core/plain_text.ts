/**
 * What a command printed, as a page or a model reads it. Shared by the console's command runs (admin/terminal.ts)
 * and the tools it installs and signs in (admin/cli_runs.ts).
 */

/**
 * Output as a page shows it: no colour codes, and a line redrawn with \r (a progress bar) kept as its last state.
 * Line by line, so a long output without line breaks costs time in proportion to its length.
 */
export function plainOutput(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .split('\n')
    .map((line) => {
      const end = line.endsWith('\r') ? line.slice(0, -1) : line;
      return end.slice(end.lastIndexOf('\r') + 1);
    })
    .join('\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
