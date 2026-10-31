// @vitest-environment node
import { describe, it, expect } from 'vitest';
import headless from '@xterm/headless';
import { pasteBytes, composeInputs } from './compose.js';
import { shouldSend } from './inputFilter.js';

const { Terminal } = headless;
const ESC = '\x1b';

describe('pasteBytes', () => {
  it.each([
    ['single line', 'echo hi', false, 'echo hi'],
    ['LF', 'a\nb', false, 'a\rb'],
    ['CRLF', 'a\r\nb', false, 'a\rb'],
    ['lone CR', 'a\rb', false, 'a\rb'],
    ['blank line kept', 'a\n\nb', false, 'a\r\rb'],
    ['bracketed', 'a\nb', true, `${ESC}[200~a\rb${ESC}[201~`],
    ['ESC stripped, no early end', `x${ESC}[201~y`, true, `${ESC}[200~x[201~y${ESC}[201~`],
    ['trailing newline', 'a\n', false, 'a\r'],
    ['emoji', '\u{1F600} ok', false, '\u{1F600} ok'],
    ['slash command typed even when bracketed', '/clear', true, '/clear'],
    ['multi-line slash stays bracketed', '/a\nb', true, `${ESC}[200~/a\rb${ESC}[201~`],
    ['non-slash single line stays bracketed', 'clear', true, `${ESC}[200~clear${ESC}[201~`],
    ['slash with control char stays bracketed', '/a\tb', true, `${ESC}[200~/a\tb${ESC}[201~`],
    ['empty plain', '', false, ''],
    ['empty bracketed', '', true, ''],
  ])('%s', (_n, text, br, want) => expect(pasteBytes(text, br)).toBe(want));
});

describe('composeInputs', () => {
  it('paste then separate CR', () => {
    expect(composeInputs('claude', 'a\nb', true, true)).toEqual([
      { t: 'input', s: 'claude', d: `${ESC}[200~a\rb${ESC}[201~` },
      { t: 'input', s: 'claude', d: '\r' },
    ]);
    expect(composeInputs('claude', 'a\nb', true, false)).toEqual([
      { t: 'input', s: 'claude', d: 'a\rb' },
      { t: 'input', s: 'claude', d: '\r' },
    ]);
  });
  it('slash command with enter is typed text then CR', () => {
    expect(composeInputs('claude', '/clear', true, true)).toEqual([
      { t: 'input', s: 'claude', d: '/clear' },
      { t: 'input', s: 'claude', d: '\r' },
    ]);
  });
  it('empty + enter is a bare CR', () => {
    expect(composeInputs('s', '', true, true)).toEqual([{ t: 'input', s: 's', d: '\r' }]);
  });
  it('empty + no enter is nothing', () => {
    expect(composeInputs('s', '', false, true)).toEqual([]);
  });
  it('every emitted input passes shouldSend', () => {
    for (const br of [false, true])
      for (const m of composeInputs('s', 'hi\nthere', true, br)) expect(shouldSend(m.d)).toBe(true);
  });
});

describe('bracketedPasteMode getter', () => {
  it('follows DECSET 2004', async () => {
    const t = new Terminal({ allowProposedApi: false });
    expect(t.modes.bracketedPasteMode).toBe(false);
    await new Promise((r) => t.write(`${ESC}[?2004h`, r));
    expect(t.modes.bracketedPasteMode).toBe(true);
    await new Promise((r) => t.write(`${ESC}[?2004l`, r));
    expect(t.modes.bracketedPasteMode).toBe(false);
  });
});
