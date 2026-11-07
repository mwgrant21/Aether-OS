import { describe, expect, it } from 'vitest';
import { classifyStop } from './alertClassifier';

const rows: ReadonlyArray<[string | null, string]> = [
  [null, 'input'],
  ['', 'input'],
  ['   \n ', 'input'],
  ['All tests pass.', 'finished'],
  ['Done. I committed the change to feat/x!', 'finished'],
  ['Refactored the parser.\n\nAll 12 tests pass.', 'finished'],
  ['Which option do you prefer?', 'question'],
  ['Shall I continue?)', 'question'],
  ['Want me to push?"', 'question'],
  ['Should I delete the worktrees? Y/N?', 'question'],
  ['Continue (y/n)', 'question'],
  ['Proceed [Y/n]', 'question'],
  ['Reply yes or no', 'question'],
  ['Done. Want me to open a PR?', 'question'],
  ['Is it ready? I think so.', 'finished'],
  ['Options:\n- a\n- b', 'input'],
  ['Here is the diff:\n```\nx\n```', 'input'],
  ['I need the API key:', 'input'],
  ['working on it', 'input'],
  // phrase cues alone do not make a question
  ['Should I continue.', 'finished'],
  ['Let me know when ready', 'input'],
  ['Looked in C:\\Users\\Matt\\.ssh\\id_rsa - what next?', 'question'],
  ['token=ghp_ABC123 done.', 'finished'],
];

describe('classifyStop', () => {
  it.each(rows)('%j -> %s', (text, kind) => {
    const out = classifyStop(text);
    expect(['finished', 'question', 'input']).toContain(out);
    expect(out).toBe(kind);
  });

  it('truncated text is always input', () => {
    expect(classifyStop('All tests pass.', true)).toBe('input');
    expect(classifyStop('Want me to push?', true)).toBe('input');
    expect(classifyStop('All tests pass.', false)).toBe('finished');
  });
});
