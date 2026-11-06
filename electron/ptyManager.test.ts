import { describe, it, expect } from 'vitest';
import { buildClaudeLaunchCommand, buildPtyEnv, buildUnsetCommand, launchLine, terminalIdentityEnv } from './ptyManager';

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

  it('sets COLORTERM=truecolor, overwriting any existing value', () => {
    expect(buildPtyEnv({ PATH: '/usr/bin' }).COLORTERM).toBe('truecolor');
    expect(buildPtyEnv({ COLORTERM: '24bit' }).COLORTERM).toBe('truecolor');
  });

  it('does not mutate the source env object', () => {
    const source = { ANTHROPIC_API_KEY: 'sk-ant-secret' };
    buildPtyEnv(source);
    expect(source.ANTHROPIC_API_KEY).toBe('sk-ant-secret');
  });

  it('drops an inherited AETHER_TERMINAL and lets terminalIdentityEnv win', () => {
    const env = buildPtyEnv({ AETHER_TERMINAL: 'alpha', PATH: '/usr/bin' });
    expect(env.AETHER_TERMINAL).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect({ ...buildPtyEnv({ AETHER_TERMINAL: 'alpha' }), ...terminalIdentityEnv('terminal2') }.AETHER_TERMINAL).toBe('beta');
  });
});

describe('terminalIdentityEnv', () => {
  it('maps the claude slot to alpha and terminal2 to beta', () => {
    expect(terminalIdentityEnv('claude')).toEqual({ AETHER_TERMINAL: 'alpha' });
    expect(terminalIdentityEnv('terminal2')).toEqual({ AETHER_TERMINAL: 'beta' });
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

describe('buildClaudeLaunchCommand', () => {
  it('passes the pinned session id when given, and stays a bare fresh launch without one', () => {
    expect(buildClaudeLaunchCommand('0b9a6f1e-1d2c-4e5f-8a7b-1c2d3e4f5a6b')).toBe('claude --session-id 0b9a6f1e-1d2c-4e5f-8a7b-1c2d3e4f5a6b\r');
    expect(buildClaudeLaunchCommand()).toBe('claude\r');
  });
});

describe('launchLine', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  it('with no override is byte-identical to buildClaudeLaunchCommand', () => {
    expect(launchLine()).toBe('claude\r');
    expect(launchLine(id)).toBe(`claude --session-id ${id}\r`);
    expect(launchLine(id)).toBe(buildClaudeLaunchCommand(id));
    expect(launchLine(undefined, undefined)).toBe(buildClaudeLaunchCommand());
  });
  it('returns an override verbatim, ignoring the session id', () => {
    const cmd = `claude --session-id ${id} --model sonnet --effort medium\r`;
    expect(launchLine(id, cmd)).toBe(cmd);
    expect(launchLine(undefined, cmd)).toBe(cmd);
  });
  it('does not alter or append to an override (embedded text, no trailing CR)', () => {
    const odd = 'claude --x "a  b"; echo \n  end';
    expect(launchLine(id, odd)).toBe(odd);
  });
});
