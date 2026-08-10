import { describe, it, expect } from 'vitest';
import { buildPtyEnv, buildUnsetCommand } from './ptyManager';

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
// a var buildPtyEnv() already stripped, before `claude` is written to the PTY
// -- without suppressing profile loading itself (that would also break PATH
// setup, e.g. nvm/pyenv/Homebrew, that many operators rely on for `claude`
// to be discoverable at all).
describe('buildUnsetCommand', () => {
  it('builds a PowerShell Remove-Item command for each var on win32', () => {
    expect(buildUnsetCommand('win32', ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'])).toBe(
      'Remove-Item Env:\\ANTHROPIC_API_KEY -ErrorAction SilentlyContinue; ' +
        'Remove-Item Env:\\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue\r',
    );
  });

  it('builds a POSIX unset command for non-win32 platforms', () => {
    expect(buildUnsetCommand('linux', ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'])).toBe(
      'unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL\r',
    );
  });
});
