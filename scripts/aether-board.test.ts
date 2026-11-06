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
