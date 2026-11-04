// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createScreenWatcher, type ObservableSlot, type ScreenMirror, type ScreenWatcher } from './screenWatcher';
import type { SlotEvent } from '../terminalHub';
import type { IdleReading } from '../../src/shared/aetherChoice/types';
import type { ScreenInput } from '../../src/shared/aetherChoice/idleClassifier';
import { TESTED_VERSIONS } from '../../src/shared/aetherChoice/idleClassifier';

const V = TESTED_VERSIONS[0];
const BANNER = [`Claude Code v${V}`, ''];
const FIXTURES = path.join(__dirname, '..', '..', 'src', 'shared', 'aetherChoice', '__fixtures__', 'screens');
const load = (name: string): string[] => {
  const rows = fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf8').split('\n').map((r) => r.replace(/\r$/, ''));
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop();
  return rows;
};

type State = 'not-started' | 'running' | 'exited';
function fakeSlot(init: { state?: State; cols?: number; rows?: number } = {}) {
  const listeners = new Set<(e: SlotEvent) => void>();
  const unsub = vi.fn();
  const st = { state: init.state ?? 'not-started', cols: init.cols ?? 0, rows: init.rows ?? 0 };
  const slot: ObservableSlot = {
    observe: (l) => { listeners.add(l); return () => { unsub(); listeners.delete(l); }; },
    info: () => ({ s: 'claude', label: 'x', state: st.state, cols: st.cols, rows: st.rows, q: 0 }),
  };
  return {
    slot, unsub, listeners,
    emit: (e: SlotEvent) => { for (const l of [...listeners]) l(e); },
    start: (cols = 100, rows = 30) => { for (const l of [...listeners]) l({ kind: 'start', q: 0, cols, rows }); },
  };
}

type Deferred = { resolve: (rows: string[]) => void; reject: (e: unknown) => void };
function fakeMirror(o: { manual?: boolean; rows?: string[] } = {}) {
  const pending: Deferred[] = [];
  const m = {
    writes: [] as string[], resizes: [] as Array<[number, number]>, disposed: 0, views: 0,
    throwOnWrite: false, rejectView: false,
    write: vi.fn((d: string) => { if (m.throwOnWrite) throw new Error('boom'); m.writes.push(d); }),
    resize: vi.fn((c: number, r: number) => { m.resizes.push([c, r]); }),
    dispose: vi.fn(() => { m.disposed++; }),
    viewportText: vi.fn((): Promise<string[]> => {
      m.views++;
      if (m.rejectView) return Promise.reject(new Error('nope'));
      if (!o.manual) return Promise.resolve(o.rows ?? []);
      return new Promise<string[]>((resolve, reject) => { pending.push({ resolve, reject }); });
    }),
    pending,
  };
  return m;
}
type FakeMirror = ReturnType<typeof fakeMirror>;
const asMirror = (m: FakeMirror): ScreenMirror => m;

/** Watcher over fake slots; each createMirror call returns the next queued fake (or a fresh one). */
function setup(opts: { claude?: Parameters<typeof fakeSlot>[0]; classify?: (i: ScreenInput) => IdleReading; mirrors?: FakeMirror[] } = {}) {
  const claude = fakeSlot(opts.claude);
  const terminal2 = fakeSlot();
  const mirrors = opts.mirrors ?? [];
  const created: Array<{ cols: number; rows: number; scrollback: number }> = [];
  const made: FakeMirror[] = [];
  const createMirror = vi.fn((o: { cols: number; rows: number; scrollback: number }) => {
    created.push(o);
    const m = mirrors.shift() ?? fakeMirror();
    made.push(m);
    return asMirror(m);
  });
  const classify = vi.fn(opts.classify ?? ((): IdleReading => 'idle'));
  const w: ScreenWatcher = createScreenWatcher({ slots: { claude: claude.slot, terminal2: terminal2.slot }, createMirror, classify });
  return { w, claude, terminal2, createMirror, created, made, classify };
}
const out = (d: string): SlotEvent => ({ kind: 'out', q: 1, d });
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('screenWatcher', () => {
  it('start -> out -> read feeds the mirror and returns exactly what classify returned', async () => {
    const rows = [...BANNER, 'row'];
    const m = fakeMirror({ rows });
    const { w, claude, classify } = setup({ mirrors: [m], classify: () => 'draft' });
    claude.start(100, 30);
    claude.emit(out('hello'));
    await flush();
    expect(m.writes).toEqual(['hello']);
    expect(await w.read('claude')).toBe('draft');
    expect(classify).toHaveBeenCalledTimes(2);
    expect(classify).toHaveBeenLastCalledWith({ rows, coverage: 'full', claudeVersion: V });
  });

  it('exit clears: mirror disposed, read is unknown without touching mirror or classify, version null', async () => {
    const m = fakeMirror({ rows: BANNER });
    const { w, claude, classify } = setup({ mirrors: [m] });
    claude.start();
    claude.emit(out('x'));
    await flush();
    expect(w.version('claude')).toBe(V);
    m.viewportText.mockClear();
    classify.mockClear();
    claude.emit({ kind: 'state', state: 'exited' });
    expect(m.disposed).toBe(1);
    expect(await w.read('claude')).toBe('unknown');
    expect(m.viewportText).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(w.version('claude')).toBeNull();
  });

  it('a replacement start without an exit retires the old mirror and a straddling read is unknown', async () => {
    const old = fakeMirror({ manual: true });
    const fresh = fakeMirror();
    const { w, claude, created, classify } = setup({ mirrors: [old, fresh] });
    claude.start(100, 30);
    const reading = w.read('claude');
    claude.start(120, 40);
    expect(old.disposed).toBe(1);
    expect(created[1]).toEqual({ cols: 120, rows: 40, scrollback: 0 });
    expect(w.version('claude')).toBeNull();
    old.pending[0].resolve(['> ', 'idle looking']);
    expect(await reading).toBe('unknown');
    expect(classify).not.toHaveBeenCalled();
  });

  it('a slot already running at construction is partial until the next start makes it full', async () => {
    const first = fakeMirror({ rows: ['a'] });
    const second = fakeMirror({ rows: ['b'] });
    const { w, claude, classify, created } = setup({ claude: { state: 'running', cols: 90, rows: 20 }, mirrors: [first, second] });
    expect(created[0]).toEqual({ cols: 90, rows: 20, scrollback: 0 });
    await w.read('claude');
    expect(classify.mock.calls[0][0].coverage).toBe('partial');
    claude.start(90, 20);
    await w.read('claude');
    expect(classify.mock.calls[1][0].coverage).toBe('full');
  });

  it('size reaches resize, invalid start dims give no mirror, scrollback is 0', async () => {
    const m = fakeMirror();
    const { w, claude, created, createMirror } = setup({ mirrors: [m] });
    claude.start(100, 30);
    claude.emit({ kind: 'size', cols: 80, rows: 24 });
    expect(m.resizes).toEqual([[80, 24]]);
    expect(created[0].scrollback).toBe(0);
    claude.start(0, 0);
    expect(createMirror).toHaveBeenCalledTimes(1);
    expect(await w.read('claude')).toBe('unknown');
  });

  it('a throwing mirror never throws out of the listener, a rejecting view reads unknown, next start recovers', async () => {
    const bad = fakeMirror({ rows: ['x'] });
    bad.throwOnWrite = true;
    const good = fakeMirror({ rows: ['y'] });
    const { w, claude } = setup({ mirrors: [bad, good] });
    claude.start();
    expect(() => claude.emit(out('d'))).not.toThrow();
    expect(await w.read('claude')).toBe('unknown');
    claude.start();
    expect(await w.read('claude')).toBe('idle');
    good.rejectView = true;
    expect(await w.read('claude')).toBe('unknown');
  });

  it('latches the version from a probe when the banner has scrolled out before any read', async () => {
    const m = fakeMirror({ manual: true });
    const { w, claude, classify } = setup({ mirrors: [m] });
    claude.start();
    claude.emit(out('banner'));
    m.pending[0].resolve(BANNER);
    await flush();
    expect(w.version('claude')).toBe(V);
    const reading = w.read('claude');
    m.pending[1].resolve(['no banner here']);
    await reading;
    expect(classify.mock.lastCall?.[0].claudeVersion).toBe(V);
  });

  it('refreshes the latch from a new banner, clears it on shell, start and exit', async () => {
    const m = fakeMirror({ manual: true });
    const next = fakeMirror();
    let reading: IdleReading = 'idle';
    const { w, claude } = setup({ mirrors: [m, next], classify: () => reading });
    claude.start();
    let r = w.read('claude');
    m.pending[0].resolve([BANNER[0]]);
    await r;
    expect(w.version('claude')).toBe(V);
    r = w.read('claude');
    m.pending[1].resolve(['Claude Code v9.9.9']);
    await r;
    expect(w.version('claude')).toBe('9.9.9');
    reading = 'shell';
    r = w.read('claude');
    m.pending[2].resolve(['$ ']);
    expect(await r).toBe('shell');
    expect(w.version('claude')).toBeNull();
    reading = 'idle';
    r = w.read('claude');
    m.pending[3].resolve([BANNER[0]]);
    await r;
    expect(w.version('claude')).toBe(V);
    claude.start();
    expect(w.version('claude')).toBeNull();
    r = w.read('claude');
    await flush();
    claude.emit({ kind: 'state', state: 'exited' });
    await r;
    expect(w.version('claude')).toBeNull();
  });

  it('probing is bounded to one in flight plus one follow-up, and stops once latched', async () => {
    const m = fakeMirror({ manual: true });
    const { claude } = setup({ mirrors: [m] });
    claude.start();
    for (let i = 0; i < 50; i++) claude.emit(out('x'));
    expect(m.views).toBe(1);
    m.pending[0].resolve(['nothing']);
    await flush();
    expect(m.views).toBe(2);
    m.pending[1].resolve(BANNER);
    await flush();
    expect(m.views).toBe(2);
    claude.emit(out('more'));
    expect(m.views).toBe(2);
  });

  it('dispose unsubscribes both slots, disposes mirrors, reads unknown, and is idempotent', async () => {
    const m = fakeMirror();
    const { w, claude, terminal2 } = setup({ mirrors: [m] });
    claude.start();
    w.dispose();
    expect(claude.unsub).toHaveBeenCalledTimes(1);
    expect(terminal2.unsub).toHaveBeenCalledTimes(1);
    expect(m.disposed).toBe(1);
    expect(await w.read('claude')).toBe('unknown');
    expect(() => w.dispose()).not.toThrow();
    expect(claude.unsub).toHaveBeenCalledTimes(1);
  });

  it('an unwatched slot reads unknown', async () => {
    const { w } = setup();
    expect(await w.read('codex' as never)).toBe('unknown');
    expect(w.version('codex' as never)).toBeNull();
  });

  it('classifies real fixtures through a real headless mirror and clears the version on shell', async () => {
    const join = (rows: string[]): string => rows.join('\r\n');
    const claude = fakeSlot();
    const w = createScreenWatcher({ slots: { claude: claude.slot, terminal2: fakeSlot().slot } });
    try {
      const cases: Array<[string, IdleReading]> = [['idle-empty', 'idle'], ['draft-text', 'draft'], ['shell-prompt2', 'shell']];
      for (const [name, want] of cases) {
        claude.start(130, 40);
        claude.emit(out(join(load('banner-version'))));
        expect(await w.read('claude')).toBe('unknown');
        expect(w.version('claude')).toBe(V);
        claude.emit(out(`\x1b[2J\x1b[H${join(load(name))}`));
        expect(await w.read('claude')).toBe(want);
        if (want === 'shell') expect(w.version('claude')).toBeNull();
      }
    } finally {
      w.dispose();
    }
  });

  it('a shell reading clears the version and the stale banner row on screen does not relatch it', async () => {
    const claude = fakeSlot();
    const w = createScreenWatcher({ slots: { claude: claude.slot, terminal2: fakeSlot().slot } });
    try {
      claude.start(130, 60);
      claude.emit(out([...load('banner-version'), ...load('shell-prompt2')].join('\r\n')));
      expect(await w.read('claude')).toBe('shell');
      expect(w.version('claude')).toBeNull();
      claude.emit(out('[?25h'));
      await flush();
      await new Promise((r) => setTimeout(r, 50));
      expect(w.version('claude')).toBeNull();
    } finally {
      w.dispose();
    }
  });

  it('a new banner below an old visible one latches the new version', async () => {
    const claude = fakeSlot();
    const w = createScreenWatcher({ slots: { claude: claude.slot, terminal2: fakeSlot().slot } });
    try {
      claude.start(130, 40);
      claude.emit(out(`Claude Code v${V}\r\n\r\nClaude Code v9.9.9`));
      await new Promise((r) => setTimeout(r, 50));
      expect(w.version('claude')).toBe('9.9.9');
      await w.read('claude');
      expect(w.version('claude')).toBe('9.9.9');
    } finally {
      w.dispose();
    }
  });

  it('a probe that resolves after a replacement start does not latch', async () => {
    const old = fakeMirror({ manual: true });
    const { w, claude } = setup({ mirrors: [old, fakeMirror({ manual: true })] });
    claude.start();
    claude.emit(out('x'));
    claude.start();
    old.pending[0].resolve(BANNER);
    await flush();
    expect(w.version('claude')).toBeNull();
  });

  it('source scan: no logging or timers, only the mirror is written, no pty/electron/fs imports', () => {
    const src = fs.readFileSync(path.join(__dirname, 'screenWatcher.ts'), 'utf8');
    for (const word of ['console', 'diag', 'logger', 'setTimeout', 'setInterval', 'writePort']) expect(src).not.toContain(word);
    const receivers = [...src.matchAll(/([\w.]+)\.write\(/g)].map((m) => m[1]);
    expect(receivers.length).toBeGreaterThan(0);
    for (const r of receivers) expect(r).toMatch(/mirror$/);
    const specs = [...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gms)].map((m) => ({ isType: m[1] !== undefined, spec: m[2] }));
    for (const { isType, spec } of specs) {
      if (/terminalHub/.test(spec)) expect(isType).toBe(true);
      else expect(spec).not.toMatch(/ptyManager|ptyLifecycle|node-pty|electron|node:fs/);
    }
    expect(specs.filter((s) => /terminalHub/.test(s.spec))).toHaveLength(1);
  });
});
