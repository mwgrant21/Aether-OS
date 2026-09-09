// electron/crossEngine/acpProcess.test.ts
import { buildAllowlistedChildEnv } from './acpProcess';
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { buildCodexChildEnv, resolveCodexHome, spawnAcpProcess, toUnpackedPath } from './acpProcess';

const BLOCKED = [
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID', 'MODEL_PROVIDER', 'DEFAULT_AUTH_REQUEST', 'CODEX_CONFIG', 'CODEX_PATH',
];
const REQUIRED_SURVIVE = ['PATH', 'TEMP', 'TMP'];

describe('toUnpackedPath', () => {
  // The Windows case is the one that matters in production: this app packages
  // win-only (electron-builder.yml targets nsis/x64), and require.resolve()
  // returns backslash-separated paths there. A regex that handled only "/"
  // would pass a POSIX test and still ship the bug.
  it('rewrites a Windows in-archive path to its unpacked sibling', () => {
    const resolved = 'C:\\Users\\m\\AppData\\Local\\Programs\\aether-os\\resources\\app.asar\\node_modules\\@openai\\codex\\bin\\codex.js';
    expect(toUnpackedPath(resolved)).toBe(
      'C:\\Users\\m\\AppData\\Local\\Programs\\aether-os\\resources\\app.asar.unpacked\\node_modules\\@openai\\codex\\bin\\codex.js',
    );
  });

  it('rewrites a POSIX in-archive path to its unpacked sibling', () => {
    expect(toUnpackedPath('/opt/aether/resources/app.asar/node_modules/x/index.js')).toBe(
      '/opt/aether/resources/app.asar.unpacked/node_modules/x/index.js',
    );
  });

  // In development nothing resolves through an archive, which is precisely why
  // the unpacked-path bug is invisible until the app is packaged.
  it('leaves a development path untouched', () => {
    const dev = 'C:\\Users\\m\\projects\\aether-os\\node_modules\\@openai\\codex\\bin\\codex.js';
    expect(toUnpackedPath(dev)).toBe(dev);
  });

  it('rewrites the archive segment, not a directory that merely ends in app.asar', () => {
    const decoy = '/home/m/my.app.asar-backup/node_modules/x/index.js';
    expect(toUnpackedPath(decoy)).toBe(decoy);
  });

  it('rewrites only the first archive segment', () => {
    expect(toUnpackedPath('/a/app.asar/b/app.asar/c.js')).toBe(
      '/a/app.asar.unpacked/b/app.asar/c.js',
    );
  });
});

describe('buildCodexChildEnv', () => {
  it('removes every blocked billing/provider variable', () => {
    const osEnv = Object.fromEntries(BLOCKED.map((k) => [k, 'leaked-value'])) as NodeJS.ProcessEnv;
    const child = buildCodexChildEnv(osEnv, 'C:/fake/codex-home');
    for (const key of BLOCKED) expect(child[key]).toBeUndefined();
  });

  it('does not inherit process.env by spreading it first', () => {
    const osEnv = { RANDOM_UNRELATED_VAR: 'x', PATH: '/usr/bin' } as NodeJS.ProcessEnv;
    const child = buildCodexChildEnv(osEnv, 'C:/fake/codex-home');
    expect(child.RANDOM_UNRELATED_VAR).toBeUndefined();
  });

  it('preserves required OS variables the adapter needs to run', () => {
    const osEnv = { PATH: '/usr/bin', TEMP: '/tmp', TMP: '/tmp' } as NodeJS.ProcessEnv;
    const child = buildCodexChildEnv(osEnv, 'C:/fake/codex-home');
    for (const key of REQUIRED_SURVIVE) expect(child[key]).toBe((osEnv as Record<string, string>)[key]);
  });

  it('always sets CODEX_HOME to the dedicated directory, never the OS value', () => {
    const osEnv = { CODEX_HOME: '/some/other/global/home' } as NodeJS.ProcessEnv;
    const child = buildCodexChildEnv(osEnv, 'C:/fake/codex-home');
    expect(child.CODEX_HOME).toBe('C:/fake/codex-home');
  });

  // Without this, spawning process.execPath (electron.exe inside the real
  // app, not node.exe) against the adapter's .js entry point launches
  // Electron itself instead of running the script as plain Node -- the
  // adapter appears to start and exit instantly with no output, only when
  // driven from the real running app (every terminal-based smoke test uses
  // plain node.exe, where this flag is a harmless no-op).
  it('sets ELECTRON_RUN_AS_NODE so process.execPath runs the script as plain Node under Electron', () => {
    const child = buildCodexChildEnv({} as NodeJS.ProcessEnv, 'C:/fake/codex-home');
    expect(child.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});

describe('resolveCodexHome', () => {
  it('returns a path under ~/.aether-os/codex-home', () => {
    expect(resolveCodexHome().replace(/\\/g, '/')).toMatch(/\.aether-os\/codex-home$/);
  });

  // I6: a missing CODEX_HOME directory would otherwise break the first real
  // canary attempt opaquely deep inside the spawned adapter process.
  it('creates the directory if it does not already exist', () => {
    const dir = resolveCodexHome();
    expect(existsSync(dir)).toBe(true);
  });

  it('does not throw when the directory already exists (idempotent)', () => {
    const dir = resolveCodexHome();
    expect(() => resolveCodexHome()).not.toThrow();
    expect(existsSync(dir)).toBe(true);
  });
});

describe('spawnAcpProcess', () => {
  // Regression test for Finding 1: this module runs inside the Electron main
  // ESM bundle (package.json "type": "module"), where a bare `require` is
  // undefined. resolveAdapterExecutable() must use the createRequire(import.
  // meta.url) pattern (matching main.ts/collectorStore.ts/memoryStore.ts)
  // rather than a bare `require.resolve` call, or every real adapter launch
  // throws "require is not defined" before spawning Codex.
  let child: ReturnType<typeof spawnAcpProcess> | null = null;
  afterEach(() => {
    child?.kill();
    child = null;
  });

  it('resolves the adapter executable and spawns without a ReferenceError for require', () => {
    expect(() => {
      child = spawnAcpProcess();
    }).not.toThrow();
    expect(child).not.toBeNull();
  });
});

describe('buildAllowlistedChildEnv', () => {
  // The Claude headless adapter relies on this too: inheriting process.env
  // there would let an operator's key silently route deliberation turns
  // through metered billing or a third-party gateway.
  it('excludes every provider billing variable by construction', () => {
    const env = buildAllowlistedChildEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-should-not-survive',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      ANTHROPIC_MODEL: 'x',
      OPENAI_API_KEY: 'sk-nope',
      OPENAI_BASE_URL: 'https://gateway.example',
      CLAUDE_CODE_USE_BEDROCK: '1',
    });
    expect(env.PATH).toBe('/usr/bin');
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/^(ANTHROPIC|OPENAI|CLAUDE_CODE_USE)_/);
    }
  });

  it('is an allowlist, not a denylist -- an unknown variable is dropped', () => {
    const env = buildAllowlistedChildEnv({ SOME_FUTURE_BILLING_BYPASS: 'x', PATH: '/usr/bin' });
    expect(env.SOME_FUTURE_BILLING_BYPASS).toBeUndefined();
  });
});

