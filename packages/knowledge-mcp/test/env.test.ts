/**
 * How often the folders are scanned and Drive is synced (KNOWLEDGE_SCAN_INTERVAL_MIN, DRIVE_SYNC_INTERVAL_MIN): a
 * value that is not a number of at least one minute is said and the default is used, instead of a timer of 0 that
 * runs the job again at once, without end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { intervalMinutes } = await import('../src/core/env.js');

test('an interval in minutes: fractions above one are kept, anything shorter or not a number falls back and is said', () => {
  const read = (value: string | undefined) => {
    const said: string[] = [];
    if (value === undefined) delete process.env.KNOWLEDGE_SCAN_INTERVAL_MIN;
    else process.env.KNOWLEDGE_SCAN_INTERVAL_MIN = value;
    try {
      return { minutes: intervalMinutes('KNOWLEDGE_SCAN_INTERVAL_MIN', 10, (...a) => said.push(a.join(' '))), said };
    } finally {
      delete process.env.KNOWLEDGE_SCAN_INTERVAL_MIN;
    }
  };
  // Meant as "every 30 seconds": read as a whole number it was 0, and the folders were scanned without pause.
  const half = read('0.5');
  assert.equal(half.minutes, 10);
  assert.match(half.said[0], /^KNOWLEDGE_SCAN_INTERVAL_MIN=0\.5 is not a number of minutes of at least 1: every 10 minutes is used instead$/);
  for (const bad of ['0', '-5', 'abc', 'Infinity', 'NaN']) {
    const r = read(bad);
    assert.deepEqual([r.minutes, r.said.length], [10, 1], bad);
  }
  for (const [value, minutes] of [[undefined, 10], ['', 10], ['  ', 10], ['15', 15], [' 1.5 ', 1.5], ['1', 1]] as const) {
    const r = read(value);
    assert.deepEqual([r.minutes, r.said], [minutes, []], String(value));
  }
});
