// @vitest-environment node
import { describe, it, expect } from 'vitest';
import headless from '@xterm/headless';
import { shouldSend, applyStdin } from './inputFilter.js';

const { Terminal } = headless;
const ESC = '\x1b';

describe('shouldSend', () => {
  it.each([
    ['X10 mouse', `${ESC}[M !!`],
    ['X10 mouse wheel', `${ESC}[M\`!!`],
    ['SGR mouse press', `${ESC}[<0;12;5M`],
    ['SGR mouse release', `${ESC}[<0;12;5m`],
    ['SGR wheel', `${ESC}[<64;1;1M`],
    ['urxvt mouse', `${ESC}[32;10;4M`],
    ['focus in', `${ESC}[I`],
    ['focus out', `${ESC}[O`],
    ['empty string', ''],
  ])('drops %s', (_n, d) => expect(shouldSend(d)).toBe(false));

  it.each([
    ['letter', 'a'],
    ['text', 'hello'],
    ['ESC', ESC],
    ['arrow up', `${ESC}[A`],
    ['ctrl-c', '\x03'],
    ['CR', '\r'],
    ['DEL', '\x7f'],
    ['bracketed paste', `${ESC}[200~echo hi${ESC}[201~`],
    ['text containing I', 'I'],
  ])('passes %s', (_n, d) => expect(shouldSend(d)).toBe(true));
});

describe('applyStdin', () => {
  const terms = () => [new Terminal({ disableStdin: true }), new Terminal({ disableStdin: true })];
  it('turns stdin on and off for every terminal', () => {
    const t = terms();
    expect(applyStdin(t, true, false)).toBe(true);
    expect(t.every((x) => x.options.disableStdin === false)).toBe(true);
    expect(applyStdin(t, false, true)).toBe(false);
    expect(t.every((x) => x.options.disableStdin === true)).toBe(true);
  });
  it('ignores non-boolean values', () => {
    const t = terms();
    for (const v of ['true', 1, null, undefined, {}]) expect(applyStdin(t, v, false)).toBe(false);
    expect(t.every((x) => x.options.disableStdin === true)).toBe(true);
  });
});

describe('reports never reach send (page wiring with headless terminal)', () => {
  it('mouse + focus modes on: only key and paste produce input', async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24, disableStdin: true });
    const sent = [];
    const raw = [];
    term.onData((d) => {
      raw.push(d);
      if (shouldSend(d)) sent.push(d);
    });
    applyStdin([term], true, false);
    await new Promise((r) => term.write(`${ESC}[?1000h${ESC}[?1006h${ESC}[?1004h`, r));
    const core = term._core;
    // synthesized mouse press + release (SGR) and focus in/out through xterm's own services
    core.coreMouseService.triggerMouseEvent({ col: 3, row: 2, x: 10, y: 10, button: 0, action: 1, ctrl: false, alt: false, shift: false });
    core.coreMouseService.triggerMouseEvent({ col: 3, row: 2, x: 10, y: 10, button: 0, action: 0, ctrl: false, alt: false, shift: false });
    core.coreService.triggerDataEvent(`${ESC}[I`, true);
    core.coreService.triggerDataEvent(`${ESC}[O`, true);
    expect(raw.length).toBeGreaterThan(0); // xterm did emit reports; the filter is what stops them
    expect(sent).toEqual([]);
    term.input('x');
    core.coreService.triggerDataEvent(`${ESC}[200~hi${ESC}[201~`, true); // what paste() emits
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(['x', `${ESC}[200~hi${ESC}[201~`]);
  });
});
