import { describe, expect, it } from 'vitest';
import { scrubbedEnv, isolatedExtractEnv } from './memoryExtract.js';

describe('isolatedExtractEnv (#111)', () => {
  it('removes the CLAUDE_CODE_USE_* provider switches case-insensitively but keeps the subscription token and PATH', () => {
    const source: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      claude_code_use_vertex: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-keep',
      PATH: 'bin-path',
    };
    const env = isolatedExtractEnv(source);
    expect(Object.keys(env).filter((k) => k.toUpperCase().startsWith('CLAUDE_CODE_USE_'))).toEqual([]);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-keep');
    expect(env.PATH).toBe('bin-path');
    expect(source.CLAUDE_CODE_USE_BEDROCK).toBe('1');
  });

  it('forces CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 over a parent value of 0, leaving one key whatever its case', () => {
    expect(isolatedExtractEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    const source: NodeJS.ProcessEnv = { Claude_Code_Disable_Auto_Memory: '0' };
    const env = isolatedExtractEnv(source);
    const matches = Object.keys(env).filter((k) => k.toUpperCase() === 'CLAUDE_CODE_DISABLE_AUTO_MEMORY');
    expect(matches).toEqual(['CLAUDE_CODE_DISABLE_AUTO_MEMORY']);
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(source.Claude_Code_Disable_Auto_Memory).toBe('0');
  });
});

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
