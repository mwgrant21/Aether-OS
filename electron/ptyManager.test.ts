import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { buildClaudeLaunchCommand, buildPtyEnv, buildPtyLaunchSpec, buildUnsetCommand, launchLine, resolveBoardCliPath, terminalIdentityEnv } from './ptyManager';

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

  it('strips mixed-case spellings of the billing variables (Windows env names are case-insensitive) and keeps the rest', () => {
    const source = {
      Anthropic_Api_Key: 'sk-mixed',
      anthropic_auth_token: 'tok-lower',
      Anthropic_Base_Url: 'https://proxy.example',
      PATH: '/usr/bin',
      Home: 'home-dir',
    };
    const env = buildPtyEnv(source);
    const upper = Object.keys(env).map((k) => k.toUpperCase());
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) expect(upper).not.toContain(name);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.Home).toBe('home-dir');
    expect(source.Anthropic_Api_Key).toBe('sk-mixed');
    expect(Object.keys(source)).toHaveLength(5);
  });

  it.skipIf(process.platform !== 'win32')('a real child process does not see a mixed-case billing variable', () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.Anthropic_Api_Key = 'sk-e2e-sentinel';
    try {
      const env = buildPtyEnv(process.env);
      const out = execFileSync(process.execPath, ['-e', 'console.log(String(process.env.ANTHROPIC_API_KEY))'], { env, encoding: 'utf8' });
      expect(out.trim()).toBe('undefined');
    } finally {
      if (prev === undefined) delete process.env.Anthropic_Api_Key;
      else process.env.Anthropic_Api_Key = prev;
    }
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

describe('buildPtyEnv board CLI', () => {
  it('drops an inherited AETHER_BOARD_CLI', () => {
    const env = buildPtyEnv({ AETHER_BOARD_CLI: '/stale/aether-board.mjs', PATH: '/usr/bin' });
    expect(env.AETHER_BOARD_CLI).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });
});

describe('terminalIdentityEnv', () => {
  it('maps the claude slot to alpha and terminal2 to beta', () => {
    expect(terminalIdentityEnv('claude')).toEqual({ AETHER_TERMINAL: 'alpha' });
    expect(terminalIdentityEnv('terminal2')).toEqual({ AETHER_TERMINAL: 'beta' });
  });

  it('adds AETHER_BOARD_CLI only when a path is given', () => {
    expect(terminalIdentityEnv('claude', '/x/aether-board.mjs')).toEqual({ AETHER_TERMINAL: 'alpha', AETHER_BOARD_CLI: '/x/aether-board.mjs' });
    expect('AETHER_BOARD_CLI' in terminalIdentityEnv('terminal2')).toBe(false);
    expect('AETHER_BOARD_CLI' in terminalIdentityEnv('terminal2', undefined)).toBe(false);
  });
});

describe('resolveBoardCliPath', () => {
  const opts = { isPackaged: false, resourcesPath: join('R', 'resources'), appPath: join('A', 'app') };

  it('resolves under the app path in dev', () => {
    expect(resolveBoardCliPath(opts, () => true)).toBe(join('A', 'app', 'scripts', 'aether-board.mjs'));
  });

  it('resolves under resourcesPath when packaged', () => {
    expect(resolveBoardCliPath({ ...opts, isPackaged: true }, () => true)).toBe(join('R', 'resources', 'scripts', 'aether-board.mjs'));
  });

  it('returns undefined when the file does not exist', () => {
    expect(resolveBoardCliPath(opts, () => false)).toBeUndefined();
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

describe('buildPtyLaunchSpec', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('plain Claude: shell, empty args, home cwd, unset then launch writes, sanitized env, identity env', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-secret');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'token-secret');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://example.invalid');
    const spec = buildPtyLaunchSpec(120, 40, undefined, id, terminalIdentityEnv('claude', '/x/aether-board.mjs'));
    expect(spec.file).toBe(process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash');
    expect(spec.args).toEqual([]);
    expect(spec.cwd).toBe(os.homedir());
    expect([spec.cols, spec.rows]).toEqual([120, 40]);
    expect(spec.writes).toEqual([
      buildUnsetCommand(process.platform, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']),
      `claude --session-id ${id}\r`,
    ]);
    expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(spec.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(spec.env.COLORTERM).toBe('truecolor');
    expect(spec.env.AETHER_TERMINAL).toBe('alpha');
    expect(spec.env.AETHER_BOARD_CLI).toBe('/x/aether-board.mjs');
  });

  it('writes a launch command override verbatim as the second write', () => {
    const cmd = 'claude --model sonnet --effort medium\r';
    expect(buildPtyLaunchSpec(100, 30, undefined, id, undefined, cmd).writes[1]).toBe(cmd);
  });

  it.runIf(process.platform === 'win32')('bridge launch: -NoExit -File args, no writes, the bridge env', () => {
    const spec = buildPtyLaunchSpec(100, 30, { scriptPath: 'C:/b/launch.ps1', env: { AETHER_BRIDGE_PIPE: 'p' } });
    expect(spec.file).toBe('powershell.exe');
    expect(spec.args).toEqual(['-NoExit', '-File', 'C:/b/launch.ps1']);
    expect(spec.writes).toEqual([]);
    expect(spec.env).toEqual({ AETHER_BRIDGE_PIPE: 'p' });
  });

  it('strips ELECTRON_RUN_AS_NODE from the env, including a bridge env, without mutating it', () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    expect(buildPtyLaunchSpec().env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(buildPtyLaunchSpec(100, 30, undefined, undefined, { ELECTRON_RUN_AS_NODE: '1' }).env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    if (process.platform === 'win32') {
      const bridgeEnv = { ELECTRON_RUN_AS_NODE: '1', X: 'y' };
      const spec = buildPtyLaunchSpec(100, 30, { scriptPath: 's.ps1', env: bridgeEnv });
      expect(spec.env).toEqual({ X: 'y' });
      expect(bridgeEnv.ELECTRON_RUN_AS_NODE).toBe('1');
    }
  });
});
