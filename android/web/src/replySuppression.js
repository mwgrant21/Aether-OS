// Terminal-originated reply suppression (design D7). The page mirrors the PTY's screen
// for display only: the real terminal on titan already answers the program's queries, so a
// second answer from this xterm would reach the program as stray input. Each suppressor
// below consumes (returns true) one family of query sequences so xterm never replies.
//
// Not covered on purpose (V3 interface item): focus-event mode (DECSET 1004) and the mouse
// report modes. They only produce onData when stdin is on, and V2 keeps stdin disabled.

const hasQuery = (data) => typeof data === 'string' && data.includes('?');
const consume = () => true;

// CSI queries: [name, prefixes, intermediates, final]. Prefix '' means none.
const CSI_QUERIES = [
  ['DA', ['', '>', '=', '?', '<'], '', 'c'], // DA1 / DA2 / DA3
  ['DSR', ['', '?', '>', '=', '<'], '', 'n'], // DSR / CPR (and DEC variants)
  ['WINOPS', ['', '?', '>', '=', '<'], '', 't'], // window reports
  ['XTVERSION', ['>'], '', 'q'], // CSI > q
  ['DECRQM-ANSI', [''], '$', 'p'], // CSI Ps $ p
  ['DECRQM-DEC', ['?'], '$', 'p'], // CSI ? Ps $ p
];

const OSC_QUERY_IDS = [4, 10, 11, 12, 104, 105, 106, 107, 108, 109, 110, 111, 112];

export const SUPPRESSORS = [
  ...CSI_QUERIES.map(([name, prefixes, intermediates, final]) => ({
    name,
    install(term) {
      return prefixes.map((prefix) =>
        term.parser.registerCsiHandler({ prefix, intermediates, final }, consume),
      );
    },
  })),
  {
    name: 'OSC-colour-query',
    install(term) {
      return OSC_QUERY_IDS.map((id) => term.parser.registerOscHandler(id, hasQuery));
    },
  },
  {
    name: 'DECRQSS',
    install(term) {
      return [term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, consume)];
    },
  },
];

// `only` exists so the test can drop one suppressor and prove its sequence then leaks.
export function installReplySuppression(term, only = SUPPRESSORS) {
  return only.flatMap((s) => s.install(term));
}

// Snapshot and size changes must land BEHIND bytes xterm has already accepted but not yet
// parsed: reset() and resize() act immediately and do not clear the write queue, so an
// unordered reset would parse stale `out` chunks after it, at the new size. An empty write
// queues the change in order. `after` runs once the change has been applied.
export function applySnap(term, cols, rows, data, after = () => {}) {
  term.write('', () => {
    term.reset();
    term.resize(cols, rows);
    after();
  });
  term.write(data);
}

export function applySize(term, cols, rows, after = () => {}) {
  term.write('', () => {
    term.resize(cols, rows);
    after();
  });
}
