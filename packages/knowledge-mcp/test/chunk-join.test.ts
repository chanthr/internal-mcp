/** Neighbouring chunks read as one text: the lead-in each repeats from the one before is said once. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinChunks, withoutLeadIn } from '../src/plugins/drive/chunk_join.js';

test('a chunk read after the one before it loses the lead-in it repeats, however many paragraphs that is', () => {
  const first = 'Intro paragraph.\n\nSecond paragraph ends here.';
  // The usual case: the lead-in is the end of the last paragraph.
  assert.equal(joinChunks([first, '…Second paragraph ends here.\n\nThird paragraph.']), 'Intro paragraph.\n\nSecond paragraph ends here.\n\nThird paragraph.');
  // A lead-in that holds a blank line itself. Cutting at the first blank line left "Second paragraph…" in twice.
  assert.equal(withoutLeadIn(first, '…paragraph.\n\nSecond paragraph ends here.\n\nOwn text.\n\nMore own text.'), 'Own text.\n\nMore own text.');
  // Three in a row: each lead-in is looked for in the chunk right before it, as that chunk is stored.
  const second = '…Second paragraph ends here.\n\nThird paragraph.';
  assert.equal(joinChunks([first, second, '…here.\n\nThird paragraph.\n\nFourth.']), 'Intro paragraph.\n\nSecond paragraph ends here.\n\nThird paragraph.\n\nFourth.');
});

test('a lead-in that cannot be found as written is cut at its first blank line; text without one is left alone', () => {
  assert.equal(withoutLeadIn('something else entirely', '…tail of another text\n\nbody\n\nmore'), 'body\n\nmore');
  assert.equal(withoutLeadIn('previous', 'No lead-in mark here.\n\nSecond.'), 'No lead-in mark here.\n\nSecond.');
  assert.equal(withoutLeadIn('previous', '…one paragraph and no blank line'), '…one paragraph and no blank line');
  assert.equal(joinChunks(['only one']), 'only one');
  assert.equal(joinChunks([]), '');
});
