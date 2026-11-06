// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const scriptPath = fileURLToPath(new URL('./aether-board.mjs', import.meta.url));
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;

function newHome(): string {
  const h = mkdtempSync(join(tmpdir(), 'aether-board-'));
  homes.push(h);
  return h;
}
function run(home: string, terminal: string | undefined, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.AETHER_TERMINAL;
  delete env.AETHER_STATUSLINE_NO_PERSIST;
  if (terminal !== undefined) env.AETHER_TERMINAL = terminal;
  return spawnSync('node', [scriptPath, ...args], { encoding: 'utf8', env });
}
const dirOf = (home: string) => join(home, '.aether-os', 'terminal-board');
const fileOf = (home: string, t: string) => join(dirOf(home), `${t}.json`);

function seed(home: string, terminal: string, over: Record<string, unknown> = {}, ageMs = 0) {
  mkdirSync(dirOf(home), { recursive: true });
  const entry = {
    schemaVersion: 1,
    terminal,
    updatedAt: new Date(Date.now() - ageMs).toISOString(),
    task: null,
    claims: [],
    blockedBy: [],
    ...over,
  };
  writeFileSync(fileOf(home, terminal), JSON.stringify(entry, null, 2) + '\n');
}

const symlinkSupported = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'aether-board-probe-'));
    homes.push(d);
    writeFileSync(join(d, 'real'), 'x', 'utf8');
    symlinkSync(join(d, 'real'), join(d, 'link'));
    return true;
  } catch {
    return false;
  }
})();

describe('aether-board identity', () => {
  it('whoami prints alpha / beta and exits 2 when unset', () => {
    const home = newHome();
    expect(run(home, 'alpha', 'whoami').stdout).toBe('alpha\n');
    expect(run(home, 'beta', 'whoami').stdout).toBe('beta\n');
    const none = run(home, undefined, 'whoami');
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('AETHER_TERMINAL is not set to alpha or beta');
  });

  it.each(['ALPHA', 'gamma', '../beta', 'alpha/../beta', ''])(
    'refuses AETHER_TERMINAL=%j on whoami and clear with no filesystem effect',
    (value) => {
      const home = newHome();
      expect(run(home, value, 'whoami').status).toBe(2);
      expect(run(home, value, 'clear').status).toBe(2);
      expect(existsSync(join(home, '.aether-os'))).toBe(false);
    },
  );
});

describe('aether-board clear', () => {
  it('creates the dir and a valid empty entry, leaving no tmp file', () => {
    const home = newHome();
    const r = run(home, 'alpha', 'clear');
    expect(r.status).toBe(0);
    const text = readFileSync(fileOf(home, 'alpha'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.startsWith('{\n  "schemaVersion": 1,')).toBe(true);
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed)).toEqual(['schemaVersion', 'terminal', 'updatedAt', 'task', 'claims', 'blockedBy']);
    expect(parsed).toMatchObject({ schemaVersion: 1, terminal: 'alpha', task: null, claims: [], blockedBy: [] });
    expect(readdirSync(dirOf(home))).toEqual(['alpha.json']);
  });

  it('never touches the other terminal file, in either direction', () => {
    const home = newHome();
    seed(home, 'alpha', {}, HOUR);
    seed(home, 'beta', {}, HOUR);
    const a = readFileSync(fileOf(home, 'alpha'));
    const b = readFileSync(fileOf(home, 'beta'));
    expect(run(home, 'alpha', 'clear').status).toBe(0);
    expect(readFileSync(fileOf(home, 'beta')).equals(b)).toBe(true);
    expect(run(home, 'beta', 'clear').status).toBe(0);
    expect(readFileSync(fileOf(home, 'alpha')).equals(a)).toBe(false); // alpha was rewritten by its own clear
    // alpha, rewritten above, must now stay put while beta clears again
    const a2 = readFileSync(fileOf(home, 'alpha'));
    expect(run(home, 'beta', 'clear').status).toBe(0);
    expect(readFileSync(fileOf(home, 'alpha')).equals(a2)).toBe(true);
  });

  it('bumps updatedAt past a seeded older value', () => {
    const home = newHome();
    seed(home, 'alpha', {}, HOUR);
    const before = Date.parse(JSON.parse(readFileSync(fileOf(home, 'alpha'), 'utf8')).updatedAt);
    expect(run(home, 'alpha', 'clear').status).toBe(0);
    const after = Date.parse(JSON.parse(readFileSync(fileOf(home, 'alpha'), 'utf8')).updatedAt);
    expect(after).toBeGreaterThan(before + HOUR / 2);
  });

  it('treats a corrupt own file as empty, warns, and replaces it', () => {
    const home = newHome();
    mkdirSync(dirOf(home), { recursive: true });
    writeFileSync(fileOf(home, 'alpha'), '{not json');
    const r = run(home, 'alpha', 'clear');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('existing board file was invalid (bad-json)');
    expect(JSON.parse(readFileSync(fileOf(home, 'alpha'), 'utf8')).terminal).toBe('alpha');
  });

  it('exits 4 with the code only when a directory sits at the own file path', () => {
    const home = newHome();
    mkdirSync(fileOf(home, 'alpha'), { recursive: true });
    const r = run(home, 'alpha', 'clear');
    expect(r.status).toBe(4);
    expect(r.stderr).toMatch(/write failed \([A-Z]+\)/);
    expect(r.stderr).not.toContain(home);
    expect(readdirSync(dirOf(home))).toEqual(['alpha.json']);
  });

  it('exits 4 when a file sits where the board dir should be', () => {
    const home = newHome();
    mkdirSync(join(home, '.aether-os'), { recursive: true });
    writeFileSync(dirOf(home), 'in the way');
    const r = run(home, 'alpha', 'clear');
    expect(r.status).toBe(4);
    expect(r.stderr).toMatch(/write failed \([A-Z]+\)/);
  });

  it.skipIf(process.platform === 'win32')('refuses a read-only own file and leaves it unchanged', () => {
    const home = newHome();
    seed(home, 'alpha', {}, HOUR);
    const before = readFileSync(fileOf(home, 'alpha'));
    chmodSync(fileOf(home, 'alpha'), 0o444);
    try {
      const r = run(home, 'alpha', 'clear');
      expect(r.status).toBe(4);
      expect(r.stderr).toContain('EACCES');
      expect(readFileSync(fileOf(home, 'alpha')).equals(before)).toBe(true);
    } finally {
      chmodSync(fileOf(home, 'alpha'), 0o644);
    }
  });

  it.skipIf(!symlinkSupported)('writes through a symlink at the own target and keeps it a link', () => {
    const home = newHome();
    mkdirSync(dirOf(home), { recursive: true });
    const real = join(home, 'real-alpha.json');
    writeFileSync(real, '{}');
    symlinkSync(real, fileOf(home, 'alpha'));
    expect(run(home, 'alpha', 'clear').status).toBe(0);
    expect(lstatSync(fileOf(home, 'alpha')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8')).terminal).toBe('alpha');
  });
});

describe('aether-board status', () => {
  it('reports no board file for both terminals, without an identity', () => {
    const home = newHome();
    const r = run(home, undefined, 'status');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('alpha: no board file');
    expect(r.stdout).toContain('beta: no board file');
  });

  it('shows an invalid beta with its reason, and exits 0', () => {
    const home = newHome();
    mkdirSync(dirOf(home), { recursive: true });
    writeFileSync(fileOf(home, 'beta'), 'nope');
    const r = run(home, 'alpha', 'status');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('alpha (you): no board file');
    expect(r.stdout).toContain('beta: invalid file (bad-json)');
  });

  it('shows a beta older than 4 h as stale and a fresher one as updated', () => {
    const home = newHome();
    seed(home, 'beta', {}, 4 * HOUR + 60_000);
    expect(run(home, undefined, 'status').stdout).toMatch(/beta: no task, stale \(4h ago\)/);
    seed(home, 'beta', {}, 4 * HOUR - 60_000);
    expect(run(home, undefined, 'status').stdout).toMatch(/beta: no task, updated 3h ago/);
  });

  it('--json prints staleAfterMs and both views', () => {
    const home = newHome();
    seed(home, 'beta');
    const out = JSON.parse(run(home, undefined, 'status', '--json').stdout);
    expect(out.staleAfterMs).toBe(4 * HOUR);
    expect(out.terminals.alpha.source).toBe('missing');
    expect(out.terminals.beta.source).toBe('file');
    expect(typeof out.at).toBe('string');
  });
});

const readEntry = (home: string, t = 'alpha') => JSON.parse(readFileSync(fileOf(home, t), 'utf8'));
const bytes = (home: string, t: string) => readFileSync(fileOf(home, t));
const claim = (ref: string, over: Record<string, unknown> = {}) => ({
  kind: 'pr',
  ref,
  since: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('aether-board task', () => {
  it('sets the task, defaults status to working, keeps existing claims', () => {
    const home = newHome();
    seed(home, 'alpha', { claims: [claim('#9')] });
    expect(run(home, 'alpha', 'task', 'Fix it', '--project', 'aether').status).toBe(0);
    expect(readEntry(home).task).toEqual({ title: 'Fix it', project: 'aether', status: 'working' });
    expect(readEntry(home).claims).toHaveLength(1);
    expect(run(home, 'alpha', 'task', 'Wait', '--status=idle').status).toBe(0);
    expect(readEntry(home).task).toEqual({ title: 'Wait', project: '', status: 'idle' });
  });

  it.each([
    [['task', 'T', '--status', 'bogus']],
    [['task', 'a', 'b']],
    [['task', '']],
    [['task', '   ']],
    [['task']],
    [['task', 'T', '--nope', 'x']],
  ])('rejects %j with exit 1 and writes nothing', (args) => {
    const home = newHome();
    expect(run(home, 'alpha', ...args).status).toBe(1);
    expect(existsSync(fileOf(home, 'alpha'))).toBe(false);
  });
});

describe('aether-board claim / release / blocked', () => {
  it('round-trips claim and release; a repeat claim is idempotent and only updates the note when passed', () => {
    const home = newHome();
    expect(run(home, 'alpha', 'claim', 'pr', '#155', '--note', 'mine').status).toBe(0);
    const since = readEntry(home).claims[0].since;
    expect(readEntry(home).claims[0]).toEqual({ kind: 'pr', ref: '#155', since, note: 'mine' });
    expect(run(home, 'alpha', 'claim', 'pr', '155').status).toBe(0);
    expect(readEntry(home).claims).toEqual([{ kind: 'pr', ref: '#155', since, note: 'mine' }]);
    expect(run(home, 'alpha', 'claim', 'pr', '#155', '--note', 'newer').status).toBe(0);
    expect(readEntry(home).claims[0]).toEqual({ kind: 'pr', ref: '#155', since, note: 'newer' });
    expect(run(home, 'alpha', 'release', 'PR 155').status).toBe(0);
    expect(readEntry(home).claims).toEqual([]);
  });

  it.each(['155', 'PR 155', '#155'])('CONFLICT on a non-stale beta claim: alpha claiming %j exits 3 naming beta and the ref', (ref) => {
    const home = newHome();
    seed(home, 'beta', { claims: [claim('#155', { note: 'review' })] }, 60_000);
    const r = run(home, 'alpha', 'claim', 'pr', ref);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('CONFLICT: #155 is claimed by beta');
    expect(r.stderr).toContain('aether-board blocked');
    expect(existsSync(fileOf(home, 'alpha'))).toBe(false);
    expect(run(home, 'alpha', 'claim', 'pr', '#156').status).toBe(0);
  });

  it('does not block on a stale, corrupt or missing beta, but still blocks at 4 h minus a minute', () => {
    const stale = newHome();
    seed(stale, 'beta', { claims: [claim('#155')] }, 4 * HOUR + 60_000);
    const r = run(stale, 'alpha', 'claim', 'pr', '#155');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('stale');

    const corrupt = newHome();
    mkdirSync(dirOf(corrupt), { recursive: true });
    writeFileSync(fileOf(corrupt, 'beta'), '{bad');
    expect(run(corrupt, 'alpha', 'claim', 'pr', '#155').status).toBe(0);

    expect(run(newHome(), 'alpha', 'claim', 'pr', '#155').status).toBe(0);

    const fresh = newHome();
    seed(fresh, 'beta', { claims: [claim('#155')] }, 4 * HOUR - 60_000);
    expect(run(fresh, 'alpha', 'claim', 'pr', '#155').status).toBe(3);
  });

  it("blocked records beta's stored spelling, rejects a ref beta does not hold, and release removes it", () => {
    const home = newHome();
    seed(home, 'beta', { claims: [claim('#155')] });
    const miss = run(home, 'alpha', 'blocked', '999');
    expect(miss.status).toBe(1);
    expect(miss.stderr).toContain('no active claim on 999 by beta');
    expect(existsSync(fileOf(home, 'alpha'))).toBe(false);
    expect(run(home, 'alpha', 'blocked', 'PR 155').status).toBe(0);
    expect(readEntry(home).blockedBy).toEqual([{ ref: '#155', owner: 'beta' }]);
    expect(run(home, 'alpha', 'blocked', '155').status).toBe(0);
    expect(readEntry(home).blockedBy).toHaveLength(1);
    expect(run(home, 'alpha', 'release', '#155').status).toBe(0);
    expect(readEntry(home).blockedBy).toEqual([]);
  });

  it('release of an unknown ref exits 0 and does not write', () => {
    const home = newHome();
    seed(home, 'alpha', { claims: [claim('#1')] }, HOUR);
    const before = bytes(home, 'alpha');
    const r = run(home, 'alpha', 'release', '#2');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('nothing to release');
    expect(bytes(home, 'alpha').equals(before)).toBe(true);
  });

  it('every successful write bumps updatedAt and never touches the other file; refusals leave own bytes alone', () => {
    const home = newHome();
    seed(home, 'beta', { claims: [claim('#155')] }, 60_000);
    const beta = bytes(home, 'beta');
    for (const args of [['task', 'T'], ['claim', 'branch', 'x'], ['blocked', '#155'], ['clear']]) {
      seed(home, 'alpha', {}, 2 * HOUR);
      expect(run(home, 'alpha', ...args).status).toBe(0);
      expect(Date.now() - Date.parse(readEntry(home).updatedAt)).toBeLessThan(HOUR);
    }
    const alpha = bytes(home, 'alpha');
    expect(run(home, 'alpha', 'claim', 'pr', '#155').status).toBe(3);
    expect(run(home, 'alpha', 'task', 'T', '--status', 'bogus').status).toBe(1);
    expect(run(home, 'alpha', 'claim', 'pr', '..').status).toBe(1);
    expect(bytes(home, 'alpha').equals(alpha)).toBe(true);
    expect(bytes(home, 'beta').equals(beta)).toBe(true);
  });

  it('preserves unrelated entries across read-modify-write', () => {
    const home = newHome();
    expect(run(home, 'alpha', 'claim', 'branch', 'feat/x').status).toBe(0);
    expect(run(home, 'alpha', 'task', 'Work', '--status', 'blocked').status).toBe(0);
    expect(readEntry(home).claims.map((c: { ref: string }) => c.ref)).toEqual(['feat/x']);
    expect(run(home, 'alpha', 'claim', 'file', 'src/a.ts').status).toBe(0);
    expect(readEntry(home).task.title).toBe('Work');
  });
});

const REJECT_REFS = [
  'C:\\x', 'c:/x', '/etc/x', '\\\\srv\\s', '~/x', 'file:///x', 'FILE:x', '..', 'a/../b', 'a\\..\\b', ' ..',
  'a/ .. /b', '', '   ', 'a\tb', 'x'.repeat(201),
];
const ACCEPT_REFS = [
  '.worktrees/x', '..foo', 'a..b', '#155', 'feat/terminal-cli', 'src/shared/terminalBoard.ts', 'x'.repeat(200),
];

describe('aether-board privacy and limit matrix', () => {
  it.each(REJECT_REFS)('claim rejects ref %j', (ref) => {
    const home = newHome();
    expect(run(home, 'alpha', 'claim', 'file', ref).status).toBe(1);
    expect(existsSync(fileOf(home, 'alpha'))).toBe(false);
  });

  it.each(ACCEPT_REFS)('claim accepts ref %j', (ref) => {
    const home = newHome();
    expect(run(home, 'alpha', 'claim', 'file', ref).status).toBe(0);
    expect(readEntry(home).claims[0].ref).toBe(ref);
  });

  it.each([
    ['title', 120, 121, (v: string) => ['task', v]],
    ['project', 80, 81, (v: string) => ['task', 'T', '--project', v]],
    ['note', 200, 201, (v: string) => ['claim', 'file', 'a', '--note', v]],
  ] as const)('%s accepts %i chars and rejects %i', (_n, ok, bad, mk) => {
    const home = newHome();
    expect(run(home, 'alpha', ...mk('x'.repeat(ok))).status).toBe(0);
    const h2 = newHome();
    expect(run(h2, 'alpha', ...mk('x'.repeat(bad))).status).toBe(1);
    expect(existsSync(fileOf(h2, 'alpha'))).toBe(false);
  });

  it.each([
    ['title', (v: string) => ['task', v]],
    ['project', (v: string) => ['task', 'T', '--project', v]],
    ['note', (v: string) => ['claim', 'file', 'a', '--note', v]],
  ] as const)('%s rejects a control character', (_n, mk) => {
    const home = newHome();
    expect(run(home, 'alpha', ...mk('a\u0007b')).status).toBe(1);
    expect(existsSync(fileOf(home, 'alpha'))).toBe(false);
  });

  it('rejects an invalid kind and a 51st claim', () => {
    const home = newHome();
    expect(run(home, 'alpha', 'claim', 'dir', 'a').status).toBe(1);
    seed(home, 'alpha', { claims: Array.from({ length: 50 }, (_, i) => claim(`r${i}`)) });
    const before = bytes(home, 'alpha');
    expect(run(home, 'alpha', 'claim', 'file', 'one-more').status).toBe(1);
    expect(bytes(home, 'alpha').equals(before)).toBe(true);
  });
});

describe('aether-board relative-path aliases', () => {
  it.each(['./src/x.ts', 'src//x.ts', 'src/x.ts/', 'src/./x.ts', 'SRC\\x.ts'])(
    'beta claiming alias %j of alpha\'s src/x.ts exits 3 naming alpha',
    (alias) => {
      const home = newHome();
      expect(run(home, 'alpha', 'claim', 'file', 'src/x.ts').status).toBe(0);
      const r = run(home, 'beta', 'claim', 'file', alias);
      expect(r.status).toBe(3);
      expect(r.stderr).toContain('claimed by alpha');
      expect(existsSync(fileOf(home, 'beta'))).toBe(false);
    },
  );

  it('blocked and release match the alias, and the conflict hint is copy-pasteable', () => {
    const home = newHome();
    expect(run(home, 'alpha', 'claim', 'pr', 'PR 155').status).toBe(0);
    expect(run(home, 'alpha', 'claim', 'file', 'src/x.ts').status).toBe(0);
    const c = run(home, 'beta', 'claim', 'pr', '#155');
    expect(c.stderr).toContain('aether-board blocked "PR 155" and');
    expect(run(home, 'beta', 'blocked', './src/x.ts').status).toBe(0);
    expect(readEntry(home, 'beta').blockedBy).toEqual([{ ref: 'src/x.ts', owner: 'alpha' }]);
    expect(run(home, 'beta', 'release', './src/x.ts').status).toBe(0);
    expect(readEntry(home, 'beta').blockedBy).toEqual([]);
  });

  it('a ref that reduces to nothing does not collide with an unrelated ref', () => {
    const home = newHome();
    expect(run(home, 'alpha', 'claim', 'file', '.').status).toBe(0);
    expect(run(home, 'beta', 'claim', 'file', 'src').status).toBe(0);
    expect(run(home, 'beta', 'claim', 'file', './').status).toBe(3);
  });
});
