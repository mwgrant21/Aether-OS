import { describe, it, expect } from 'vitest';
import { buildCodexPtyEnv, buildUnsetCommand } from './codexPtyManager';

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

// Guards against a shell profile (~/.bashrc, ~/.zshrc, $PROFILE) re-exporting
// a var buildCodexPtyEnv() already stripped, before `codex` is written to the
// PTY -- without suppressing profile loading itself (that would also break
// PATH setup, e.g. nvm/pyenv/Homebrew, that many operators rely on for
// `codex` to be discoverable at all). See PR #17 review comments on this file.
describe('buildUnsetCommand', () => {
  it('builds a PowerShell Remove-Item command for each var on win32', () => {
    expect(buildUnsetCommand('win32', ['OPENAI_API_KEY', 'CODEX_API_KEY'])).toBe(
      'Remove-Item Env:\\OPENAI_API_KEY -ErrorAction SilentlyContinue; ' +
        'Remove-Item Env:\\CODEX_API_KEY -ErrorAction SilentlyContinue\r',
    );
  });

  it('builds a POSIX unset command for non-win32 platforms', () => {
    expect(buildUnsetCommand('linux', ['OPENAI_API_KEY', 'CODEX_API_KEY'])).toBe(
      'unset OPENAI_API_KEY CODEX_API_KEY\r',
    );
  });
});
