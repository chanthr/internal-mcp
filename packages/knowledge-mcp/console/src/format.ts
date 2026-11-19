/**
 * How numbers, counts and addresses read on every page. One copy each: the pages used to carry their own.
 */

/** 1234 → "1,234" */
export const num = (n: number): string => n.toLocaleString('en-US');

/** (3, 'file') → "3 files", (1, 'file') → "1 file" */
export const plural = (count: number, word: string): string => `${num(count)} ${word}${count === 1 ? '' : 's'}`;

/** The host of an address, or the address itself when it is not one. */
export function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** An address on this computer: nothing sent to it leaves the machine. */
export const isLocal = (url: string | null | undefined): boolean => !!url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
