/** An env value counts as set only when it has non-space content (an empty `FOO=` line in .env is unset). */
export function isSet(v: string | undefined): boolean {
  return !!v && v.trim().length > 0;
}

/**
 * Minutes between two runs of a background job (KNOWLEDGE_SCAN_INTERVAL_MIN, DRIVE_SYNC_INTERVAL_MIN). A value that
 * is not a number of at least one minute is not used: read as a whole number, "0.5" became 0 and "abc" nothing, and
 * a timer of 0 runs the job again at once, without end. Such a value is said in the log, and the default is used.
 */
export function intervalMinutes(name: string, fallback: number, log: (...a: unknown[]) => void = console.error): number {
  const raw = process.env[name];
  if (!isSet(raw)) return fallback;
  const minutes = Number.parseFloat(raw!);
  if (Number.isFinite(minutes) && minutes >= 1) return minutes;
  log(`${name}=${raw!.trim()} is not a number of minutes of at least 1: every ${fallback} minutes is used instead`);
  return fallback;
}
