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

// `npm run electron:dev` (and any `npm exec`) prepends `<dir>/node_modules/.bin`
// for the package dir (npm_config_local_prefix) and every ancestor to PATH
// before Electron starts, so the bare `codex` CODEX_LAUNCH_COMMAND resolved
// to the project-local pinned @openai/codex shim (0.153.2) instead of the
// operator's global install (0.154.0) -- the terminal reported a stale
// version no "update" could fix. The launch env must drop exactly that
// npm-injected set and nothing else.
describe('buildCodexPtyEnv PATH filtering', () => {
  const GLOBAL_NPM = 'C:\\Users\\op\\AppData\\Roaming\\npm';
  // A node_modules/.bin the operator put on PATH themselves (custom prefix,
  // direnv PATH_add): not an ancestor of the package dir, so npm did not
  // inject it.
  const OPERATOR_BIN = 'D:\\tools\\node_modules\\.bin';
  const WIN_NPM = {
    npm_execpath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    npm_config_local_prefix: 'C:\\proj\\aether-os',
    npm_package_json: 'C:\\proj\\aether-os\\package.json',
    INIT_CWD: 'C:\\proj\\aether-os',
  };
  const WIN_PATH = [
    'C:\\proj\\aether-os\\node_modules\\.bin',
    'C:\\proj\\node_modules\\.bin',
    'C:\\node_modules\\.bin\\',
    'C:\\Windows\\System32',
    OPERATOR_BIN,
    GLOBAL_NPM,
    'C:\\Program Files\\nodejs',
  ].join(';');
  const WIN_EXPECTED = ['C:\\Windows\\System32', OPERATOR_BIN, GLOBAL_NPM, 'C:\\Program Files\\nodejs'].join(';');

  it('drops exactly the INIT_CWD-ancestor node_modules/.bin entries on win32, keeping order of the rest', () => {
    const env = buildCodexPtyEnv({ ...WIN_NPM, Path: WIN_PATH }, 'C:/fake/codex-home', 'win32');
    expect(env.Path).toBe(WIN_EXPECTED);
  });

  it('keeps an operator-managed node_modules/.bin that npm did not inject', () => {
    const env = buildCodexPtyEnv({ ...WIN_NPM, Path: WIN_PATH }, 'C:/fake/codex-home', 'win32');
    expect(env.Path?.split(';')).toContain(OPERATOR_BIN);
  });

  it('matches injected entries case-insensitively and with either separator on win32', () => {
    const source = { ...WIN_NPM, Path: ['c:/PROJ/aether-os/node_modules/.bin', 'C:\\Windows\\System32'].join(';') };
    const env = buildCodexPtyEnv(source, 'C:/fake/codex-home', 'win32');
    expect(env.Path).toBe('C:\\Windows\\System32');
  });

  it('strips nothing when the process was not launched by npm (packaged build)', () => {
    const env = buildCodexPtyEnv({ npm_config_local_prefix: 'C:\\proj\\aether-os', Path: WIN_PATH }, 'C:/fake/codex-home', 'win32');
    expect(env.Path).toBe(WIN_PATH);
  });

  // `npm --prefix C:\proj\aether-os run electron:dev` from C:\Users\op: npm
  // injects the package's ancestors, but INIT_CWD is the caller's directory.
  // The filter must follow the package, and must not touch a bin dir that is
  // only an ancestor of the caller.
  it('follows the npm package dir, not INIT_CWD, for an npm --prefix launch from elsewhere', () => {
    const CALLER_BIN = 'C:\\Users\\op\\node_modules\\.bin';
    const source = { ...WIN_NPM, INIT_CWD: 'C:\\Users\\op', Path: [CALLER_BIN, WIN_PATH].join(';') };
    const env = buildCodexPtyEnv(source, 'C:/fake/codex-home', 'win32');
    expect(env.Path).toBe([CALLER_BIN, WIN_EXPECTED].join(';'));
  });

  it('falls back to the npm_package_json directory when npm_config_local_prefix is absent', () => {
    const { npm_config_local_prefix: _omit, ...withoutPrefix } = WIN_NPM;
    const env = buildCodexPtyEnv({ ...withoutPrefix, Path: WIN_PATH }, 'C:/fake/codex-home', 'win32');
    expect(env.Path).toBe(WIN_EXPECTED);
  });

  it('matches the PATH key case-insensitively and does not add a second key', () => {
    const env = buildCodexPtyEnv({ ...WIN_NPM, PATH: WIN_PATH }, 'C:/fake/codex-home', 'win32');
    expect(env.PATH).toBe(WIN_EXPECTED);
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['PATH']);
  });

  it('uses the POSIX delimiter and forward-slash form off win32', () => {
    const source = {
      npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
      npm_config_local_prefix: '/home/op/proj',
      PATH: '/home/op/proj/node_modules/.bin:/home/op/node_modules/.bin:/node_modules/.bin:/usr/local/bin:/opt/mine/node_modules/.bin:/usr/bin',
    };
    const env = buildCodexPtyEnv(source, '/fake/codex-home', 'linux');
    expect(env.PATH).toBe('/usr/local/bin:/opt/mine/node_modules/.bin:/usr/bin');
  });

  it('does not mutate the source PATH', () => {
    const source = { ...WIN_NPM, Path: WIN_PATH };
    buildCodexPtyEnv(source, 'C:/fake/codex-home', 'win32');
    expect(source.Path).toBe(WIN_PATH);
  });
});
