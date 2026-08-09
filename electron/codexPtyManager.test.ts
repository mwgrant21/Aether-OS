import { describe, it, expect } from 'vitest';
import { buildCodexPtyEnv } from './codexPtyManager';

// Mirrors ptyManager.test.ts's guard, for the Codex terminal's own launch path.
describe('buildCodexPtyEnv', () => {
  it('strips OPENAI_API_KEY and CODEX_API_KEY', () => {
    const source = {
      OPENAI_API_KEY: 'sk-openai-secret',
      CODEX_API_KEY: 'codex-secret',
      PATH: '/usr/bin',
    };
    const env = buildCodexPtyEnv(source, 'C:/fake/codex-home');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
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
