import { describe, expect, it } from 'vitest';
import {
  BOARD_LIMITS,
  TERMINAL_BOARD_STALE_MS,
  buildBoardSnapshot,
  classifyBoardText,
  emptyBoardEntry,
  isBoardEntryStale,
  parseBoardEntry,
} from './terminalBoard';

const NOW = 1_700_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    terminal: 'alpha',
    updatedAt: iso(NOW),
    task: { title: 'Build S3', project: 'aether-os', status: 'working' },
    claims: [
      { kind: 'pr', ref: '#155', since: iso(NOW) },
      { kind: 'branch', ref: 'feat/x', since: iso(NOW), note: 'wip' },
      { kind: 'worktree', ref: '.worktrees/x', since: iso(NOW) },
      { kind: 'file', ref: 'src/a.ts', since: iso(NOW) },
    ],
    blockedBy: [{ ref: 'PR 155', owner: 'beta' }],
    ...over,
  };
}
const reasonOf = (raw: unknown, t: 'alpha' | 'beta' = 'alpha') => {
  const r = parseBoardEntry(raw, t);
  return r.ok ? 'ok' : r.reason;
};
const claimWith = (ref: string) => entry({ claims: [{ kind: 'file', ref, since: iso(NOW) }] });

describe('parseBoardEntry', () => {
  it('parses a full valid entry to an equal entry', () => {
    const raw = entry();
    const r = parseBoardEntry(raw, 'alpha');
    expect(r).toEqual({ ok: true, entry: raw });
  });

  it('round-trips an empty entry', () => {
    const e = emptyBoardEntry('beta', NOW);
    expect(e.task).toBeNull();
    expect(e.claims).toEqual([]);
    expect(e.blockedBy).toEqual([]);
    expect(e.terminal).toBe('beta');
    expect(e.updatedAt).toBe(iso(NOW));
    expect(parseBoardEntry(JSON.parse(JSON.stringify(e)), 'beta')).toEqual({ ok: true, entry: e });
  });

  it('rejects a wrong or missing schemaVersion', () => {
    expect(reasonOf(entry({ schemaVersion: 2 }))).toBe('schema-version');
    const noVersion = entry();
    delete noVersion.schemaVersion;
    expect(reasonOf(noVersion)).toBe('schema-version');
  });

  it('rejects a terminal that does not match the expected file', () => {
    expect(reasonOf(entry({ terminal: 'beta' }), 'alpha')).toBe('terminal-mismatch');
  });

  it('rejects unknown enum values', () => {
    expect(reasonOf(entry({ task: { title: 't', project: 'p', status: 'sleeping' } }))).toBe('task');
    expect(reasonOf(entry({ claims: [{ kind: 'secret', ref: 'x', since: iso(NOW) }] }))).toBe('claim');
    expect(reasonOf(entry({ blockedBy: [{ ref: 'x', owner: 'codex' }] }))).toBe('blocked-by');
  });

  it('rejects over-limit strings and arrays, accepts exactly at the limit', () => {
    const task = (title: string) => entry({ task: { title, project: 'p', status: 'idle' } });
    expect(reasonOf(task('a'.repeat(BOARD_LIMITS.title)))).toBe('ok');
    expect(reasonOf(task('a'.repeat(BOARD_LIMITS.title + 1)))).toBe('task');
    expect(reasonOf(claimWith('a'.repeat(BOARD_LIMITS.ref)))).toBe('ok');
    expect(reasonOf(claimWith('a'.repeat(BOARD_LIMITS.ref + 1)))).toBe('claim');
    const note = (n: string) => entry({ claims: [{ kind: 'file', ref: 'a', since: iso(NOW), note: n }] });
    expect(reasonOf(note('n'.repeat(BOARD_LIMITS.note)))).toBe('ok');
    expect(reasonOf(note('n'.repeat(BOARD_LIMITS.note + 1)))).toBe('claim');
    const claims = (n: number) =>
      entry({ claims: Array.from({ length: n }, () => ({ kind: 'file', ref: 'a', since: iso(NOW) })) });
    expect(reasonOf(claims(BOARD_LIMITS.claims))).toBe('ok');
    expect(reasonOf(claims(BOARD_LIMITS.claims + 1))).toBe('too-many-claims');
  });

  it('rejects absolute-path refs and accepts branch, PR and relative refs', () => {
    const bad = [String.raw`C:\Users\x\f.ts`, 'D:/x', '/etc/passwd', String.raw`\\server\share`, '~/x', 'C:foo', '//host/x', '~user/x'];
    for (const ref of bad) {
      expect(reasonOf(claimWith(ref)), ref).toBe('claim');
      expect(reasonOf(entry({ blockedBy: [{ ref, owner: 'beta' }] })), ref).toBe('blocked-by');
    }
    for (const ref of ['feat/x', 'release/1.2', '#155', 'PR 155', 'src/a.ts', String.raw`src\a.ts`]) {
      expect(reasonOf(claimWith(ref)), ref).toBe('ok');
      expect(reasonOf(entry({ blockedBy: [{ ref, owner: 'beta' }] })), ref).toBe('ok');
    }
  });

  it('rejects control characters in title, ref and note', () => {
    expect(reasonOf(entry({ task: { title: 'a\nb', project: 'p', status: 'idle' } }))).toBe('task');
    expect(reasonOf(entry({ task: { title: 'a\u0000b', project: 'p', status: 'idle' } }))).toBe('task');
    expect(reasonOf(claimWith('a\nb'))).toBe('claim');
    expect(reasonOf(claimWith('a\u0000b'))).toBe('claim');
    expect(reasonOf(entry({ claims: [{ kind: 'file', ref: 'a', since: iso(NOW), note: 'x\ny' }] }))).toBe('claim');
  });

  it('drops unknown keys and is not polluted by a __proto__ key', () => {
    const raw = JSON.parse(
      '{"schemaVersion":1,"terminal":"alpha","updatedAt":"2023-11-14T22:13:20.000Z","task":null,"claims":[],"blockedBy":[],"extra":1,"__proto__":{"polluted":true}}',
    );
    const r = parseBoardEntry(raw, 'alpha');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.entry).sort()).toEqual(['blockedBy', 'claims', 'schemaVersion', 'task', 'terminal', 'updatedAt']);
      expect((r.entry as unknown as Record<string, unknown>).polluted).toBeUndefined();
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects an invalid updatedAt', () => {
    expect(reasonOf(entry({ updatedAt: 'nope' }))).toBe('updated-at');
    expect(reasonOf(entry({ updatedAt: 12345 }))).toBe('updated-at');
  });
});

describe('isBoardEntryStale', () => {
  const at = (ms: number) => emptyBoardEntry('alpha', ms);
  it('is stale only strictly past the window; a future updatedAt is not stale', () => {
    expect(isBoardEntryStale(at(NOW - TERMINAL_BOARD_STALE_MS), NOW)).toBe(false);
    expect(isBoardEntryStale(at(NOW - TERMINAL_BOARD_STALE_MS - 1), NOW)).toBe(true);
    expect(isBoardEntryStale(at(NOW + 60_000), NOW)).toBe(false);
  });

  it('pins the 4 h default', () => {
    expect(TERMINAL_BOARD_STALE_MS).toBe(14_400_000);
  });
});

describe('classifyBoardText', () => {
  it('reports a null text as missing', () => {
    expect(classifyBoardText('alpha', null, NOW)).toEqual({ terminal: 'alpha', source: 'missing', entry: null, stale: false });
  });

  it('reports non-JSON and wrong-shape text as invalid without throwing', () => {
    for (const text of ['{not json', 'null', '[]', '"x"', '']) {
      const v = classifyBoardText('alpha', text, NOW);
      expect(v.source, text).toBe('invalid');
      expect(v.entry).toBeNull();
      expect(v.stale).toBe(false);
      expect(v.reason).toBeTruthy();
    }
  });

  it('keeps a stale file entry and marks it stale; a fresh one is not', () => {
    const old = JSON.stringify(entry({ updatedAt: iso(NOW - TERMINAL_BOARD_STALE_MS - 1) }));
    const v = classifyBoardText('alpha', old, NOW);
    expect(v.source).toBe('file');
    expect(v.stale).toBe(true);
    expect(v.entry).not.toBeNull();
    expect(classifyBoardText('alpha', JSON.stringify(entry()), NOW).stale).toBe(false);
  });
});

describe('buildBoardSnapshot', () => {
  it('treats terminals independently and stamps at', () => {
    const s = buildBoardSnapshot({ alpha: JSON.stringify(entry()), beta: null }, NOW);
    expect(s.terminals.alpha.source).toBe('file');
    expect(s.terminals.beta.source).toBe('missing');
    expect(s.at).toBe(iso(NOW));
  });
});
