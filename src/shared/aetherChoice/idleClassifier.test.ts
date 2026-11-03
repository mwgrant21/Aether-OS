import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classifyScreen, extractClaudeVersion, TESTED_VERSIONS } from './idleClassifier';
import type { IdleReading } from './types';

const DIR = path.join(__dirname, '__fixtures__', 'screens');
const V = TESTED_VERSIONS[0];
const load = (name: string): string[] => {
  const rows = fs.readFileSync(path.join(DIR, `${name}.txt`), 'utf8').split('\n').map((r) => r.replace(/\r$/, ''));
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop();
  return rows;
};
const read = (rows: string[], claudeVersion: string | null = V): IdleReading => classifyScreen({ rows, coverage: 'full', claudeVersion });

const EXPECTED: Array<[string, IdleReading]> = [
  ['idle-empty', 'idle'],
  ['idle-empty2', 'idle'],
  ['draft-text', 'draft'],
  ['draft-text2', 'draft'],
  ['generating', 'generating'],
  ['generating2', 'generating'],
  ['model-picker', 'picker'],
  ['model-picker2', 'picker'],
  ['switch-model-modal', 'switch-model-modal'],
  ['switch-model-modal2', 'switch-model-modal'],
  ['permission-prompt', 'modal'],
  ['usage-pane', 'modal'],
  ['shell-prompt', 'shell'],
  ['shell-prompt2', 'shell'],
  ['banner-version', 'unknown'],
  ['banner-version2', 'unknown'],
];
const IDLE = load('idle-empty');
const IDLE2 = load('idle-empty2');
const ENUM: IdleReading[] = ['idle', 'generating', 'busy', 'picker', 'modal', 'switch-model-modal', 'draft', 'shell', 'unknown'];

/** Index of the input row (last row starting with the marker). */
const inputAt = (rows: string[]): number => rows.map((r) => r.startsWith('>')).lastIndexOf(true);

describe('idleClassifier: fixtures', () => {
  for (const [name, want] of EXPECTED) {
    it(`${name} -> ${want}`, () => expect(read(load(name))).toBe(want));
  }

  it('reads the banner version, null when absent', () => {
    expect(extractClaudeVersion(load('banner-version'))).toBe('2.1.317');
    expect(extractClaudeVersion(IDLE)).toBeNull();
  });

  it('does not depend on the rotating placeholder, footer suffix, or model/ctx numbers', () => {
    const rows = IDLE.map((r) => r.replace(' · ← 1 agent', '').replace('Ctx: 0', 'Ctx: 87.1k').replace('Sonnet 5.5', 'Haiku 5.5'));
    expect(read(rows)).toBe('idle');
    expect(read(IDLE2)).toBe('idle');
  });

  it('a lone marker with no placeholder is idle', () => {
    const rows = [...IDLE];
    rows[inputAt(rows)] = '>';
    expect(read(rows)).toBe('idle');
  });

  it('spinner verb and counters do not matter', () => {
    const rows = load('generating').map((r) => r.replace('Stewing… (running UserPromptSubmit hooks… 3/4 · 2s)', 'Brewing… (41s · ↓ 9 tokens)'));
    expect(read(rows)).toBe('generating');
  });

  it('tolerates a wrong transcribed glyph in the footer or check mark', () => {
    expect(read(IDLE.map((r) => r.replace('⏵⏵', '>>')))).toBe('idle');
    expect(read(load('model-picker').map((r) => r.replace('✓', '√')))).toBe('picker');
  });

  it('garbled lines far above the live UI do not change the reading', () => {
    expect(read(['Nokactive', 'Completed:oNo', ...IDLE])).toBe('idle');
  });
});

describe('idleClassifier: fail closed (never idle)', () => {
  it('partial coverage -> unknown', () => {
    expect(classifyScreen({ rows: IDLE, coverage: 'partial', claudeVersion: V })).toBe('unknown');
  });

  it('untested or missing version -> unknown', () => {
    expect(read(IDLE, '2.1.318')).toBe('unknown');
    expect(read(IDLE, null)).toBe('unknown');
    const bumped = load('banner-version').map((r) => r.replace('v2.1.317', 'v9.9.9'));
    expect(extractClaudeVersion(bumped)).toBe('9.9.9');
    expect(read(IDLE, extractClaudeVersion(bumped))).toBe('unknown');
  });

  it('blank, empty and one-row screens -> unknown', () => {
    expect(read([])).toBe('unknown');
    expect(read(['', '', ''])).toBe('unknown');
    expect(read(['> '])).toBe('unknown');
  });

  it('truncated screens (live UI cut at every point) are never idle', () => {
    for (let n = 0; n < IDLE.length; n++) expect(read(IDLE.slice(0, n)), `cut at ${n}`).not.toBe('idle');
  });

  it('a half-typed word at the empty prompt is draft, never idle', () => {
    for (const set of [IDLE, IDLE2]) {
      const rows = [...set];
      rows[inputAt(rows)] = '> wha';
      expect(read(rows)).toBe('draft');
    }
  });

  it('typed text appended after the placeholder is not idle', () => {
    const rows = [...IDLE];
    rows[inputAt(rows)] += ' hello';
    expect(read(rows)).not.toBe('idle');
  });

  it('a signature line deleted (input row, either rule, footer) -> unknown', () => {
    const i = inputAt(IDLE);
    for (const drop of [i, i - 1, i + 1, IDLE.length - 1]) {
      expect(read(IDLE.filter((_, k) => k !== drop)), `drop ${drop}`).toBe('unknown');
    }
  });

  it('an extra indent on the input row or the live block -> not idle', () => {
    const i = inputAt(IDLE);
    const row = [...IDLE];
    row[i] = ` ${row[i]}`;
    expect(read(row)).not.toBe('idle');
    const block = IDLE.map((r, k) => (k >= i - 1 ? `  ${r}` : r));
    expect(read(block)).not.toBe('idle');
  });

  it('garbled text injected between the rules, over the footer, or after it -> not idle', () => {
    const i = inputAt(IDLE);
    const mid = [...IDLE];
    mid.splice(i, 0, 'Nokactive Vie--model.');
    expect(read(mid)).not.toBe('idle');
    const foot = [...IDLE];
    foot[foot.length - 1] = '  Acces·as to usc this session only';
    expect(read(foot)).not.toBe('idle');
    expect(read([...IDLE, 'Completed:oNo'])).not.toBe('idle');
  });

  it('a spinner above an empty prompt is generating, not idle', () => {
    const rows = [...IDLE];
    rows[inputAt(rows)] = '>';
    rows.splice(inputAt(rows) - 1, 0, '✻ Stewing… (running UserPromptSubmit hooks… 3/4 · 2s)');
    expect(read(rows)).toBe('generating');
  });


  it('a spinner is found through a task list and in looser shapes -> not idle', () => {
    const empty = (): string[] => {
      const r = [...IDLE];
      r[inputAt(r)] = '>';
      return r;
    };
    const put = (...lines: string[]): string[] => {
      const r = empty();
      r.splice(inputAt(r) - 1, 0, ...lines);
      return r;
    };
    const tasks = ['  ⎿ ◼ a', '    ◻ b', '    ◻ c', '    ◻ d'];
    expect(read(put('✻ Stewing… (2s)', ...tasks))).toBe('generating');
    expect(read(put('✻ Stewing…'))).toBe('generating');
    expect(read(put('✻ Stewing… (esc to interrupt)'))).toBe('generating');
    expect(read(put('✻ Stewing (esc to interrupt)'))).toBe('generating');
    for (const tail of ['(↓ 9 tokens)', '(thinking)', '(1h 2m)']) expect(read(put('✻ Stewing… ' + tail))).toBe('generating');
  });


  it('a spinner is found above any number of task rows, blank-separated or not', () => {
    const base = [...IDLE];
    base[inputAt(base)] = '>';
    for (const n of [14, 15, 20, 200]) {
      for (const sep of ['', ' ']) {
        const tasks = Array.from({ length: n }, (_, k) => '  ⎿ ◻ task ' + k);
        const rows = [...base];
        rows.splice(inputAt(rows) - 1, 0, '✻ Stewing… (running UserPromptSubmit hooks… 3/4 · 2s)', ...tasks.flatMap((t) => (sep ? [t, sep] : [t])));
        expect(read(rows), n + ' tasks sep=' + JSON.stringify(sep)).toBe('generating');
      }
    }
  });

  it('looser spinner shapes -> generating; finished-turn lines stay idle', () => {
    const put = (line: string): string[] => {
      const r = [...IDLE];
      r[inputAt(r)] = '>';
      r.splice(inputAt(r) - 1, 0, line);
      return r;
    };
    for (const l of ['✻ Stewing (2s)', '✻ Stewing (12s · ↓ 9 tokens)', '✻ Stewing...', '✻ Compacting conversation…', '✻ Running tools… 3s']) {
      expect(read(put(l)), l).not.toBe('idle');
    }
    for (const l of ['✻ Worked for 1m 3s', '✻ Cogitated for 12s', '  ⎿ … +42 lines (ctrl+o to expand)', 'Read 12 lines (ctrl+o to expand)', 'foo(…)']) {
      expect(read(put(l)), l).toBe('idle');
    }
  });

  it('every idle fixture still reads idle after the spinner widening', () => {
    for (const name of ['idle-empty', 'idle-empty2']) expect(read(load(name)), name).toBe('idle');
  });

  it('modal footers with their body deleted -> unknown', () => {
    expect(read(load('model-picker2').filter((r) => !/Select model/.test(r)))).toBe('unknown');
    expect(read(load('permission-prompt').filter((r) => !/Do you want to proceed/.test(r)))).toBe('unknown');
  });

  it('a shell prompt under live Claude chrome is not shell', () => {
    expect(read([...IDLE, 'PS C:' + String.fromCharCode(92) + 'Temp>'])).not.toBe('shell');
  });

  it('shell prompt needs full coverage but not a Claude version', () => {
    expect(read(load('shell-prompt'), null)).toBe('shell');
    expect(classifyScreen({ rows: load('shell-prompt'), coverage: 'partial', claudeVersion: null })).toBe('unknown');
  });

  it('always returns an enum member for fuzzed rows, and never throws', () => {
    let seed = 12345;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pool = [...IDLE, ...load('generating'), ...load('model-picker'), ...load('permission-prompt'), '>', '> x', '', '─'.repeat(20), 'PS C:>'];
    for (let n = 0; n < 500; n++) {
      const rows = Array.from({ length: Math.floor(rnd() * 30) }, () => pool[Math.floor(rnd() * pool.length)]);
      expect(ENUM).toContain(read(rows));
    }
    expect(() => read([null as unknown as string, 5 as unknown as string])).not.toThrow();
  });
});
