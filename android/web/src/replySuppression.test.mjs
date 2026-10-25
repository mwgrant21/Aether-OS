// @vitest-environment node
import { describe, it, expect } from 'vitest';
import headless from '@xterm/headless';
import { installReplySuppression, applySnap, applySize, SUPPRESSORS } from './replySuppression.js';

const { Terminal } = headless;
const ESC = '\x1b';

function make(opts = {}) {
  const term = new Terminal({
    allowProposedApi: true,
    cols: 80,
    rows: 24,
    disableStdin: false,
    // headless gates window reports behind this option, so a liveness check needs it on
    windowOptions: { getWinSizeChars: true, getWinSizePixels: true, getCellSizePixels: true },
    ...opts,
  });
  const replies = [];
  term.onData((d) => replies.push(d));
  term.onBinary((d) => replies.push(d));
  return { term, replies };
}

const feed = (term, s) => new Promise((resolve) => term.write(s, resolve));

// One query per reply class: [label, bytes, owning suppressor, probe, replies in headless 6.0.0].
// The probe is a handler registered BEFORE the suppressors (so it runs after them): it is reached
// only when no suppressor consumed the sequence. It stands in for onData where headless 6.0.0
// never replies (DA3, XTVERSION, OSC colour queries: the browser core answers colour queries
// through its onColor wiring, headless has none), so those classes are still provable.
const csi = (prefix, intermediates, final) => ['csi', { prefix, intermediates, final }];
const QUERIES = [
  ['DA1', `${ESC}[c`, 'DA', csi('', '', 'c'), true],
  ['DA2', `${ESC}[>c`, 'DA', csi('>', '', 'c'), true],
  ['DA3', `${ESC}[=c`, 'DA', csi('=', '', 'c'), false],
  ['DSR status', `${ESC}[5n`, 'DSR', csi('', '', 'n'), true],
  ['CPR', `${ESC}[6n`, 'DSR', csi('', '', 'n'), true],
  ['DEC CPR', `${ESC}[?6n`, 'DSR', csi('?', '', 'n'), true],
  ['window report 18t', `${ESC}[18t`, 'WINOPS', csi('', '', 't'), true],
  ['XTVERSION', `${ESC}[>q`, 'XTVERSION', csi('>', '', 'q'), false],
  ['DECRQM ANSI', `${ESC}[4$p`, 'DECRQM-ANSI', csi('', '$', 'p'), true],
  ['DECRQM DEC', `${ESC}[?25$p`, 'DECRQM-DEC', csi('?', '$', 'p'), true],
  ['OSC 11 query', `${ESC}]11;?\x07`, 'OSC-colour-query', ['osc', 11], false],
  ['OSC 4 query', `${ESC}]4;1;?\x07`, 'OSC-colour-query', ['osc', 4], false],
  ['OSC 10 query', `${ESC}]10;?\x07`, 'OSC-colour-query', ['osc', 10], false],
  ['OSC 12 query', `${ESC}]12;?\x07`, 'OSC-colour-query', ['osc', 12], false],
  ['OSC 104 query', `${ESC}]104;?\x07`, 'OSC-colour-query', ['osc', 104], false],
  ['OSC 112 query', `${ESC}]112;?\x07`, 'OSC-colour-query', ['osc', 112], false],
  ['DECRQSS', `${ESC}P$qm${ESC}\\`,'DECRQSS', ['dcs', { intermediates: '$', final: 'q' }], true],
];

// Runs seq on a terminal with only `only` suppressors installed; reports what leaked.
async function leak(seq, probe, only) {
  const { term, replies } = make();
  let reached = false;
  const hit = () => ((reached = true), false); // false = let xterm continue to its default
  if (probe[0] === 'csi') term.parser.registerCsiHandler(probe[1], hit);
  else if (probe[0] === 'osc') term.parser.registerOscHandler(probe[1], hit);
  else term.parser.registerDcsHandler(probe[1], hit);
  installReplySuppression(term, only);
  await feed(term, seq);
  return { replies, reached };
}
const without = (name) => SUPPRESSORS.filter((s) => s.name !== name);
const leaked = (r) => r.reached || r.replies.length > 0;

describe('reply suppression', () => {
  // (a) liveness control: without it a green (b) could just mean the transcript is inert.
  it.each(QUERIES)('(a) unsuppressed terminal handles %s', async (_n, seq, _o, probe, live) => {
    const r = await leak(seq, probe, []);
    expect(r.reached).toBe(true);
    expect(r.replies.length > 0).toBe(live);
  });

  // (b) only sees onData; DA3/XTVERSION/OSC never reply in headless, their coverage is (a) + (d) via the probes.
  it('(b) the whole transcript yields zero onData bytes when suppressed', async () => {
    const { term, replies } = make();
    installReplySuppression(term);
    await feed(term, QUERIES.map((q) => q[1]).join(''));
    expect(replies).toEqual([]);
  });

  it('(c) non-query sequences still take effect', async () => {
    const { term, replies } = make();
    let osc11 = null;
    term.parser.registerOscHandler(11, (d) => ((osc11 = d), true)); // registered first = runs last: reached only if the suppressor passes the set through
    const seen = [];
    term.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, () => (seen.push('decscusr'), true));
    term.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => (seen.push('decstr'), true));
    installReplySuppression(term);
    await feed(term, `${ESC}[31mred${ESC}[0m hi${ESC}[5 q${ESC}[!p${ESC}]11;rgb:00/00/00\x07`);
    const line = term.buffer.active.getLine(0);
    expect(line.translateToString(true)).toBe('red hi');
    expect(line.getCell(0).getFgColor()).toBe(1); // SGR 31 applied
    expect(seen).toEqual(['decscusr', 'decstr']); // DECSCUSR and DECSTR not claimed
    expect(osc11).toBe('rgb:00/00/00'); // colour set not consumed
    expect(replies).toEqual([]);
  });

  // (d) table-driven red-proof: drop one suppressor, its sequences must leak, the rest must not.
  it.each(SUPPRESSORS.map((s) => s.name))('(d) without %s its class leaks and others do not', async (name) => {
    const owned = QUERIES.filter((q) => q[2] === name);
    expect(owned.length).toBeGreaterThan(0);
    for (const [label, seq, , probe] of owned) {
      expect(leaked(await leak(seq, probe, without(name))), `${label} should leak`).toBe(true);
    }
    for (const [label, seq, owner, probe] of QUERIES) {
      if (owner === name) continue;
      expect(leaked(await leak(seq, probe, without(name))), `${label} should stay suppressed`).toBe(false);
    }
  });

  it('every suppressor owns at least one query in the table', () => {
    for (const s of SUPPRESSORS) expect(QUERIES.some((q) => q[2] === s.name), s.name).toBe(true);
  });

  // Ordering: reset/resize act immediately but do not clear xterm's write queue, so snap and
  // size must be queued behind pending output or stale bytes land after the reset.
  const screen = (term) =>
    Array.from({ length: term.rows }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) ?? '')
      .join('|')
      .split('|')
      .filter(Boolean)
      .join('|');

  it('applySnap: output queued before a snapshot never appears after it', async () => {
    const { term } = make();
    term.write('OLDPENDING-A');
    term.write('OLDPENDING-B');
    applySnap(term, 40, 10, 'SNAP');
    await feed(term, '');
    expect(term.cols).toBe(40);
    expect(term.rows).toBe(10);
    expect(screen(term)).toBe('SNAP');
  });

  it('applySize: pending output is parsed at the old size, then the size changes', async () => {
    const { term } = make();
    term.write(`${ESC}[1;70HZ`); // cursor to column 70, valid only at the old 80-column width
    applySize(term, 40, 10);
    await feed(term, '');
    expect([term.cols, term.rows]).toEqual([40, 10]);
    // Z went to column 70 of an 80-column row, which the shrink then truncates. Resized first, the cursor would clamp and Z would survive at column 40.
    expect(screen(term)).toBe('');
  });
});
