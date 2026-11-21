/** An env value counts as set only when it has non-space content (an empty `FOO=` line in .env is unset). */
export function isSet(v: string | undefined): boolean {
  return !!v && v.trim().length > 0;
}

/**
 * The longest wait a timer takes, in whole minutes: 2^31 - 1 milliseconds, a little under 25 days. A longer one is
 * not waited at all: Node fires it after 1 ms (TimeoutOverflowWarning), so the job would run without pause.
 */
export const MAX_INTERVAL_MIN = Math.floor((2 ** 31 - 1) / 60_000);

/**
 * Minutes between two runs of a background job (KNOWLEDGE_SCAN_INTERVAL_MIN, DRIVE_SYNC_INTERVAL_MIN). A value that
 * is not a number of at least one minute is not used: read as a whole number, "0.5" became 0 and "abc" nothing, and
 * a timer of 0 runs the job again at once, without end. Such a value is said in the log, and the default is used.
 * One above MAX_INTERVAL_MIN ("40000", "1e5") is read as that, the longest a timer waits, and said as well: it meant
 * "rarely", which that is.
 */
export function intervalMinutes(name: string, fallback: number, log: (...a: unknown[]) => void = console.error): number {
  const raw = process.env[name];
  if (!isSet(raw)) return fallback;
  const minutes = Number.parseFloat(raw!);
  if (!Number.isFinite(minutes) || minutes < 1) {
    log(`${name}=${raw!.trim()} is not a number of minutes of at least 1: every ${fallback} minutes is used instead`);
    return fallback;
  }
  if (minutes > MAX_INTERVAL_MIN) {
    log(`${name}=${raw!.trim()} is longer than a timer can wait: every ${MAX_INTERVAL_MIN} minutes (about 25 days) is used instead`);
    return MAX_INTERVAL_MIN;
  }
  return minutes;
}
