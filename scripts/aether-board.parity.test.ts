// @vitest-environment node
// Pins the CLI's hand-carried copies (constants, validator, classifier, empty entry, format)
// against src/shared/terminalBoard.ts. Relative imports and node builtins only: the collector
// vitest config also collects this file.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  TERMINAL_BOARD_STALE_MS,
  classifyBoardText,
  emptyBoardEntry,
  parseBoardEntry,
} from '../src/shared/terminalBoard';

const scriptPath = fileURLToPath(new URL('./aether-board.mjs', import.meta.url));
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;
const newHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'aether-board-parity-'));
  homes.push(h);
  return h;
};
function run(home: string, terminal: string | undefined, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.AETHER_TERMINAL;
  if (terminal !== undefined) env.AETHER_TERMINAL = terminal;
  return spawnSync('node', [scriptPath, ...args], { encoding: 'utf8', env });
}
const dirOf = (home: string) => join(home, '.aether-os', 'terminal-board');
const fileOf = (home: string, t: string) => join(dirOf(home), `${t}.json`);
const writeRaw = (home: string, t: string, text: string) => {
  mkdirSync(dirOf(home), { recursive: true });
  writeFileSync(fileOf(home, t), text);
};
const entryFor = (terminal: string, over: Record<string, unknown> = {}, ageMs = 0) => ({
  schemaVersion: 1,
  terminal,
  updatedAt: new Date(Date.now() - ageMs).toISOString(),
  task: null,
  claims: [],
  blockedBy: [],
  ...over,
});
const goodClaim = (ref: string) => ({ kind: 'pr', ref, since: '2026-01-01T00:00:00.000Z' });

const scriptText = readFileSync(scriptPath, 'utf8');

describe('aether-board parity: constants', () => {
  it('carries the shared staleness window, as a value and as the literal expression', () => {
    const home = newHome();
    const out = JSON.parse(run(home, undefined, 'status', '--json').stdout);
    expect(out.staleAfterMs).toBe(TERMINAL_BOARD_STALE_MS);
    expect(scriptText).toContain('TERMINAL_BOARD_STALE_MS = 4 * 60 * 60 * 1000;');
    expect(scriptText.match(/\* 60 \* 60 \* 1000/g)).toHaveLength(1);
  });
});

describe('aether-board parity: output validity', () => {
  it.each(['alpha', 'beta'] as const)('every step as %s leaves a file the shared validator accepts', (me) => {
    const other = me === 'alpha' ? 'beta' : 'alpha';
    const home = newHome();
    writeRaw(home, other, JSON.stringify(entryFor(other, { claims: [goodClaim('#155')] }), null, 2));
    const steps = [
      ['task', 'T', '--project', 'p', '--status', 'working'],
      ['claim', 'branch', 'feat/a', '--note', 'n'],
      ['claim', 'file', 'src/a.ts'],
      ['blocked', '155'],
      ['release', 'feat/a'],
      ['clear'],
    ];
    for (const step of steps) {
      expect(run(home, me, ...step).status).toBe(0);
      const parsed = parseBoardEntry(JSON.parse(readFileSync(fileOf(home, me), 'utf8')), me);
      expect(parsed.ok).toBe(true);
    }
  });
});

describe('aether-board parity: classification', () => {
  const fixtures: [string, string | null][] = [
    ['valid', JSON.stringify(entryFor('beta', { task: { title: 'T', project: '', status: 'idle' } }))],
    ['stale by 4 h + 60 s', JSON.stringify(entryFor('beta', {}, 4 * HOUR + 60_000))],
    ['4 h - 60 s old', JSON.stringify(entryFor('beta', {}, 4 * HOUR - 60_000))],
    ['bad json', '{nope'],
    ['wrong schemaVersion', JSON.stringify(entryFor('beta', { schemaVersion: 2 }))],
    ['wrong terminal', JSON.stringify(entryFor('alpha'))],
    ['bad status', JSON.stringify(entryFor('beta', { task: { title: 'T', project: '', status: 'nope' } }))],
    ['absolute ref', JSON.stringify(entryFor('beta', { claims: [goodClaim('C:\\x')] }))],
    ['file: ref', JSON.stringify(entryFor('beta', { claims: [goodClaim('file:x')] }))],
    ['.. ref', JSON.stringify(entryFor('beta', { claims: [goodClaim('a/../b')] }))],
    ['51 claims', JSON.stringify(entryFor('beta', { claims: Array.from({ length: 51 }, (_, i) => goodClaim(`r${i}`)) }))],
    ['future updatedAt', JSON.stringify(entryFor('beta', {}, -5 * HOUR))],
    ['missing', null],
  ];
  it.each(fixtures)('beta view matches classifyBoardText: %s', (_name, text) => {
    const home = newHome();
    if (text !== null) writeRaw(home, 'beta', text);
    const out = JSON.parse(run(home, undefined, 'status', '--json').stdout);
    const expected = JSON.parse(JSON.stringify(classifyBoardText('beta', text, Date.parse(out.at))));
    expect(out.terminals.beta).toEqual(expected);
  });
});

describe('aether-board parity: rejection', () => {
  const rejectRefs = [
    'C:\\x', 'c:/x', '/etc/x', '\\\\srv\\s', '~/x', 'file:///x', 'FILE:x', '..', 'a/../b', 'a\\..\\b', ' ..',
    'a/ .. /b', '', '   ', 'a\tb', 'x'.repeat(201),
  ];
  const acceptRefs = ['.worktrees/x', '..foo', 'a..b', '#155', 'feat/terminal-cli', 'x'.repeat(200)];

  it.each(rejectRefs)('both reject ref %j', (ref) => {
    expect(parseBoardEntry(entryFor('alpha', { claims: [goodClaim(ref)] }), 'alpha').ok).toBe(false);
    const home = newHome();
    expect(run(home, 'alpha', 'claim', 'pr', ref).status).not.toBe(0);
    expect(existsSync(fileOf(home, 'alpha'))).toBe(false);
  });

  it.each(acceptRefs)('both accept ref %j', (ref) => {
    const home = newHome();
    expect(run(home, 'alpha', 'claim', 'pr', ref).status).toBe(0);
    expect(parseBoardEntry(JSON.parse(readFileSync(fileOf(home, 'alpha'), 'utf8')), 'alpha').ok).toBe(true);
  });

  it.each([
    ['title', 121, 'task', (v: string) => ({ task: { title: v, project: '', status: 'working' } })],
    ['project', 81, 'task', (v: string) => ({ task: { title: 'T', project: v, status: 'working' } })],
    ['note', 201, 'claim', (v: string) => ({ claims: [{ ...goodClaim('a'), note: v }] })],
  ] as const)('both reject an over-long %s and a control character', (name, len, _verb, build) => {
    const args = (v: string) =>
      name === 'title' ? ['task', v] : name === 'project' ? ['task', 'T', '--project', v] : ['claim', 'pr', 'a', '--note', v];
    for (const bad of ['x'.repeat(len), 'a\u0007b']) {
      expect(parseBoardEntry(entryFor('alpha', build(bad)), 'alpha').ok).toBe(false);
      const home = newHome();
      expect(run(home, 'alpha', ...args(bad)).status).not.toBe(0);
      expect(existsSync(fileOf(home, 'alpha'))).toBe(false);
    }
  });
});

describe('aether-board parity: self-containment and format', () => {
  it('imports only node: specifiers and avoids network, listener, spawn and require text', () => {
    const specs = [...scriptText.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s.startsWith('node:')).toBe(true);
    for (const banned of ['child_process', 'listen(', 'http', 'fetch(', 'require(']) {
      expect(scriptText).not.toContain(banned);
    }
  });

  it('writes clear exactly as the shared empty entry is serialised by the main writer', () => {
    const home = newHome();
    expect(run(home, 'alpha', 'clear').status).toBe(0);
    const text = readFileSync(fileOf(home, 'alpha'), 'utf8');
    const { updatedAt } = JSON.parse(text);
    expect(text).toBe(JSON.stringify(emptyBoardEntry('alpha', Date.parse(updatedAt)), null, 2) + '\n');
  });
});
