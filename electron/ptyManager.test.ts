import { describe, it, expect } from 'vitest';
import { buildPtyEnv, resolveShellInvocation } from './ptyManager';

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

// Guards against a shell profile (~/.bashrc, ~/.zshrc, $PROFILE) re-exporting
// a var buildPtyEnv() already stripped, before `claude` is written to the PTY.
describe('resolveShellInvocation', () => {
  it('suppresses PowerShell profile loading on win32', () => {
    expect(resolveShellInvocation('win32', undefined)).toEqual({
      shell: 'powershell.exe',
      args: ['-NoProfile'],
    });
  });

  it('suppresses bash rc/profile loading', () => {
    expect(resolveShellInvocation('linux', '/bin/bash')).toEqual({
      shell: '/bin/bash',
      args: ['--norc', '--noprofile'],
    });
  });

  it('suppresses zsh rc loading', () => {
    expect(resolveShellInvocation('darwin', '/bin/zsh')).toEqual({
      shell: '/bin/zsh',
      args: ['-f'],
    });
  });

  it('defaults to bash with rc/profile suppressed when $SHELL is unset', () => {
    expect(resolveShellInvocation('linux', undefined)).toEqual({
      shell: 'bash',
      args: ['--norc', '--noprofile'],
    });
  });

  it('passes an unrecognized shell through with no suppression flag', () => {
    expect(resolveShellInvocation('linux', '/usr/bin/fish')).toEqual({
      shell: '/usr/bin/fish',
      args: [],
    });
  });
});
