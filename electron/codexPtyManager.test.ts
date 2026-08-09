import { describe, it, expect } from 'vitest';
import { buildCodexPtyEnv } from './codexPtyManager';

// Mirrors ptyManager.test.ts's guard, for the Codex terminal's own launch path.
// Mirrors acpProcess.test.ts's BLOCKED list -- the verifier already enumerates
// the real billing/auth-bypass vector list for `codex`; the terminal must
// strip the same set.
const BLOCKED = [
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID', 'MODEL_PROVIDER', 'DEFAULT_AUTH_REQUEST', 'CODEX_CONFIG', 'CODEX_PATH',
];

describe('buildCodexPtyEnv', () => {
  it('strips the full billing/auth-bypass vector list', () => {
    const source: Record<string, string> = { PATH: '/usr/bin' };
    for (const key of BLOCKED) source[key] = 'leaked-value';

    const env = buildCodexPtyEnv(source, 'C:/fake/codex-home');
    for (const key of BLOCKED) expect(env[key]).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('does not mutate the source env object', () => {
    const source = { OPENAI_API_KEY: 'sk-openai-secret' };
    buildCodexPtyEnv(source, 'C:/fake/codex-home');
    expect(source.OPENAI_API_KEY).toBe('sk-openai-secret');
  });

  it('always sets CODEX_HOME to the dedicated directory, never the OS value', () => {
    const source = { CODEX_HOME: '/some/other/global/home' };
    const env = buildCodexPtyEnv(source, 'C:/fake/codex-home');
    expect(env.CODEX_HOME).toBe('C:/fake/codex-home');
  });
});
