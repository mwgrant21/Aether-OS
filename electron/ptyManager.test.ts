import { describe, it, expect } from 'vitest';
import { buildPtyEnv } from './ptyManager';

// Guards the 2026-08-04 incident fix: the auto-launched `claude` session must
// never inherit a paid API key from the operator's own shell environment.
describe('buildPtyEnv', () => {
  it('strips ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, and ANTHROPIC_BASE_URL', () => {
    const source = {
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      ANTHROPIC_AUTH_TOKEN: 'token-secret',
      ANTHROPIC_BASE_URL: 'https://example.invalid',
      PATH: '/usr/bin',
    };
    const env = buildPtyEnv(source);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('does not mutate the source env object', () => {
    const source = { ANTHROPIC_API_KEY: 'sk-ant-secret' };
    buildPtyEnv(source);
    expect(source.ANTHROPIC_API_KEY).toBe('sk-ant-secret');
  });
});
