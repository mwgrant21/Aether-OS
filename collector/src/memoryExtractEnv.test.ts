import { describe, expect, it } from 'vitest';
import { scrubbedEnv } from './memoryExtract.js';

describe('scrubbedEnv (#104)', () => {
  it('drops the billing variables case-insensitively (Windows env names are case-insensitive) and keeps the rest', () => {
    const source: NodeJS.ProcessEnv = {
      Anthropic_Api_Key: 'sk-mixed',
      anthropic_auth_token: 'tok-lower',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
      PATH: 'bin-path',
      Home: 'home-dir',
    };
    const env = scrubbedEnv(source);
    const left = Object.keys(env).map((k) => k.toUpperCase());
    expect(left).not.toContain('ANTHROPIC_API_KEY');
    expect(left).not.toContain('ANTHROPIC_AUTH_TOKEN');
    expect(left).not.toContain('ANTHROPIC_BASE_URL');
    expect(env.PATH).toBe('bin-path');
    expect(env.Home).toBe('home-dir');
    // The source (parent env) is not mutated.
    expect(source.Anthropic_Api_Key).toBe('sk-mixed');
  });
});
