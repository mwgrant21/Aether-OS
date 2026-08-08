// electron/crossEngine/acpProcess.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { buildCodexChildEnv, resolveCodexHome, spawnAcpProcess } from './acpProcess';

const BLOCKED = [
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID', 'MODEL_PROVIDER', 'DEFAULT_AUTH_REQUEST', 'CODEX_CONFIG', 'CODEX_PATH',
];
const REQUIRED_SURVIVE = ['PATH', 'TEMP', 'TMP'];

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
