import { describe, it, expect, vi, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createMemoryStore } from './memoryStore.js';
import {
  runExtractor,
  defaultExtractExec,
  buildExtractArgs,
  prepareExtractCwd,
  extractCwdPath,
  ancestorHasMemoryFile,
  EXTRACT_TIMEOUT_MS,
  AUTH_STATUS_TIMEOUT_MS,
  ExtractRefusedError,
  type AuthStatusFn,
} from './memoryExtract.js';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock };
});

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-memextract-'));
  const store = createMemoryStore(join(dir, 'memory.db'), { now: () => 1_700_000_000 });
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe('runExtractor', () => {
  it('applies a well-formed op list returned by the model', async () => {
    const { store, cleanup } = tempStore();
    try {
      const result = await runExtractor(
        {
          store,
          writer: 'CINDER',
          sourceKind: 'run',
          sourceRunId: 'run-1',
          runSummary: 'The user asked CINDER to always double-check migrations before applying them.',
          existingMemories: [],
        },
        async () => ({ stdout: '[{"op":"ADD","kind":"habit","content":"Matt always asks CINDER to double-check migrations."}]' }),
      );
      expect(result.parseError).toBeNull();
      expect(result.added).toBe(1);
      expect(result.rejected).toEqual([]);
      expect(store.getPrivateCandidates('CINDER')).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('applies zero ops and reports no error when the model deliberately returns []', async () => {
    const { store, cleanup } = tempStore();
    try {
      const result = await runExtractor(
        { store, writer: 'CINDER', sourceKind: 'run', runSummary: 'Nothing notable happened.', existingMemories: [] },
        async () => ({ stdout: '[]' }),
      );
      expect(result.parseError).toBeNull();
      expect(result.added).toBe(0);
      expect(result.rejected).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('reports a parseError and applies zero ops when the model output is not parseable', async () => {
    const { store, cleanup } = tempStore();
    try {
      const result = await runExtractor(
        { store, writer: 'CINDER', sourceKind: 'run', runSummary: 'x', existingMemories: [] },
        async () => ({ stdout: 'I refuse to answer in JSON today.' }),
      );
      expect(result.parseError).toBe('no_json_array_found');
      expect(result.added).toBe(0);
      expect(result.rejected).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('reports an exec_failed parseError and applies zero ops when the CLI call throws', async () => {
    const { store, cleanup } = tempStore();
    try {
      const result = await runExtractor(
        { store, writer: 'CINDER', sourceKind: 'run', runSummary: 'x', existingMemories: [] },
        async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); },
      );
      expect(result.parseError).toBe('exec_failed: ENOENT');
      expect(result.added).toBe(0);
      expect(result.rejected).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('reports exec_failed: timeout when the child was killed by the timeout', async () => {
    const { store, cleanup } = tempStore();
    try {
      const result = await runExtractor(
        { store, writer: 'CINDER', sourceKind: 'run', runSummary: 'x', existingMemories: [] },
        async () => { throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }); },
      );
      expect(result.parseError).toBe('exec_failed: timeout');
    } finally {
      cleanup();
    }
  });

  it('never puts the exec error message (which carries the prompt) in parseError', async () => {
    const { store, cleanup } = tempStore();
    try {
      const result = await runExtractor(
        { store, writer: 'CINDER', sourceKind: 'run', runSummary: 'x', existingMemories: [] },
        async () => { throw new Error('Command failed: claude -p SECRET-RUN-SUMMARY'); },
      );
      expect(result.parseError).toBe('exec_failed: error');
      expect(result.parseError).not.toContain('SECRET-RUN-SUMMARY');
    } finally {
      cleanup();
    }
  });

  it('enforces single-writer even when the model output claims a different scope: writer identity never comes from model output', async () => {
    const { store, cleanup } = tempStore();
    try {
      // 'decision' is a SHARED kind, writable only by SHARED_WRITER ('STEWARD').
      // This model output tries to write one while the caller-supplied writer
      // is a plain agent id -- proving the reject comes from ctx.writer
      // (supplied by the caller of runExtractor), never from anything in the
      // model's JSON, which contains no writer/identity field at all.
      const result = await runExtractor(
        { store, writer: 'CINDER', sourceKind: 'run', runSummary: 'x', existingMemories: [] },
        async () => ({ stdout: '[{"op":"ADD","kind":"decision","content":"Matt decided X."}]' }),
      );
      expect(result.added).toBe(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toBe('scope_violation');
    } finally {
      cleanup();
    }
  });

  it('still enforces §3.4 forbidden-content rejection when the model emits a file path', async () => {
    const { store, cleanup } = tempStore();
    try {
      const result = await runExtractor(
        { store, writer: 'CINDER', sourceKind: 'run', runSummary: 'x', existingMemories: [] },
        async () => ({ stdout: '[{"op":"ADD","kind":"habit","content":"Matt approved the change in main.ts."}]' }),
      );
      expect(result.added).toBe(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toBe('forbidden_content');
    } finally {
      cleanup();
    }
  });

  it('gives each failed extraction its own fresh rejected array, never a shared instance', async () => {
    const { store, cleanup } = tempStore();
    try {
      const execFailResult = await runExtractor(
        { store, writer: 'CINDER', sourceKind: 'run', runSummary: 'x', existingMemories: [] },
        async () => { throw new Error('spawn ENOENT'); },
      );
      const parseFailResult = await runExtractor(
        { store, writer: 'CINDER', sourceKind: 'run', runSummary: 'x', existingMemories: [] },
        async () => ({ stdout: 'not json' }),
      );
      expect(execFailResult.rejected).not.toBe(parseFailResult.rejected);
      execFailResult.rejected.push({ op: {}, reason: 'unknown_op' });
      expect(parseFailResult.rejected).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe('defaultExtractExec', () => {
  it('runs claude -p with the exact isolation argv (hooks off, project-only settings, no MCP, no slash commands)', async () => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((...a: unknown[]) => {
      const cb = a[a.length - 1];
      if (typeof cb === 'function') cb(null, { stdout: '[]', stderr: '' });
    });
    await defaultExtractExec('hello', OK_DEPS);
    const [file, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(file).toBe('claude');
    expect(args).toEqual(buildExtractArgs('hello'));
    // Independent literal: not derived from the constants the code uses.
    expect(args).toEqual([
      '-p', 'hello',
      '--model', 'haiku', '--output-format', 'text',
      '--setting-sources', 'project',
      '--settings', '{"disableAllHooks":true}',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disable-slash-commands',
    ]);
    expect(args[1]).toBe('hello');
    // --mcp-config is variadic: it must be followed by another --flag, never be last or precede a positional.
    expect(args[args.indexOf('--mcp-config') + 2]?.startsWith('--')).toBe(true);
  });

  it('spawns -p in the neutral cwd with a scrubbed env, a bounded timeout and no shell', async () => {
    const saved: Record<string, string | undefined> = {};
    const sentinels = {
      ANTHROPIC_API_KEY: 'sk-a', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://x', CLAUDE_CODE_USE_VERTEX: '1',
    };
    for (const [k, v] of Object.entries(sentinels)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
      mockClaudeOk();
      await defaultExtractExec('hello', OK_DEPS);
      const call = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === '-p') as unknown as ExecCall;
      const opts = call[2] as Record<string, unknown> & ExecCall[2];
      expect(opts.cwd).toBe(NEUTRAL_CWD);
      expect(opts.timeout).toBe(EXTRACT_TIMEOUT_MS);
      expect(opts.windowsHide).toBe(true);
      expect(opts.shell).toBeFalsy();
      expect(opts.windowsVerbatimArguments).toBeUndefined();
      expect(opts.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
      const keys = Object.keys(opts.env ?? {}).map((k) => k.toUpperCase());
      for (const gone of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) expect(keys).not.toContain(gone);
      expect(keys.filter((k) => k.startsWith('CLAUDE_CODE_USE_'))).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

const NEUTRAL_CWD = join(tmpdir(), 'neutral-cwd-for-tests');
const OK_AUTH: AuthStatusFn = async () => ({ stdout: '{"authMethod":"claude.ai"}' });
const OK_DEPS = { authStatus: OK_AUTH, cwd: () => NEUTRAL_CWD };

type ExecCall = [string, string[], { env?: NodeJS.ProcessEnv; timeout?: number; windowsHide?: boolean }];

function mockClaudeOk(): void {
  execFileMock.mockReset();
  execFileMock.mockImplementation((...a: unknown[]) => {
    const cb = a[a.length - 1];
    if (typeof cb === 'function') cb(null, { stdout: '[]', stderr: '' });
  });
}

function promptSpawns(): number {
  return execFileMock.mock.calls.filter((c) => (c[1] as string[])[0] === '-p').length;
}

describe('defaultExtractExec subscription-only auth gate (#111)', () => {
  const refusals: Array<[string, () => Promise<{ stdout: string }>, string]> = [
    ['api_key', async () => ({ stdout: '{"authMethod":"api_key"}' }), 'auth_api_key'],
    ['api_key_helper', async () => ({ stdout: '{"authMethod":"api_key_helper"}' }), 'auth_api_key_helper'],
    ['third_party', async () => ({ stdout: '{"authMethod":"third_party"}' }), 'auth_third_party'],
    ['none', async () => ({ stdout: '{"authMethod":"none"}' }), 'auth_none'],
    ['unknown method', async () => ({ stdout: '{"authMethod":"something_new"}' }), 'auth_method_unknown'],
    ['non-JSON stdout', async () => ({ stdout: 'Logged in as x' }), 'auth_status_unparseable'],
    ['JSON without authMethod', async () => ({ stdout: '{"loggedIn":true}' }), 'auth_status_unparseable'],
    ['BOM prefix', async () => ({ stdout: '﻿{"authMethod":"claude.ai"}' }), 'auth_status_unparseable'],
    ['trailing text', async () => ({ stdout: '{"authMethod":"claude.ai"} trailing' }), 'auth_status_unparseable'],
    ['wrong casing', async () => ({ stdout: '{"authMethod":"Claude.ai"}' }), 'auth_method_unknown'],
    ['array authMethod', async () => ({ stdout: '{"authMethod":["claude.ai"]}' }), 'auth_status_unparseable'],
    ['JSON null', async () => ({ stdout: 'null' }), 'auth_status_unparseable'],
    ['non-string stdout', async () => ({ stdout: undefined as unknown as string }), 'auth_status_unparseable'],
    ['non-zero exit', () => Promise.reject({ code: 1 }), 'auth_status_exit'],
    ['timeout', () => Promise.reject({ killed: true, code: null }), 'auth_status_timeout'],
    ['ENOENT', () => Promise.reject({ code: 'ENOENT' }), 'auth_status_error'],
    ['reject undefined', () => Promise.reject(undefined), 'auth_status_error'],
    ['reject null', () => Promise.reject(null), 'auth_status_error'],
    ['reject string', () => Promise.reject('boom'), 'auth_status_error'],
    ['reject number', () => Promise.reject(7), 'auth_status_error'],
  ];

  it.each(refusals)('refuses %s with its fixed reason and never spawns -p', async (_name, authStatus, reason) => {
    mockClaudeOk();
    const err = await defaultExtractExec('p', { authStatus, cwd: OK_DEPS.cwd }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractRefusedError);
    expect((err as ExtractRefusedError).reason).toBe(reason);
    expect((err as ExtractRefusedError).message).toBe(reason);
    expect(promptSpawns()).toBe(0);
  });

  it.each(['claude.ai', 'oauth_token'])('proceeds for the subscription method %s, spawning -p once', async (method) => {
    mockClaudeOk();
    const out = await defaultExtractExec('p', { ...OK_DEPS, authStatus: async () => ({ stdout: `{"authMethod":"${method}"}` }) });
    expect(out.stdout).toBe('[]');
    expect(promptSpawns()).toBe(1);
  });

  it('runExtractor maps a refusal to exec_refused with no prompt text and a fresh rejected array', async () => {
    const { store, cleanup } = tempStore();
    try {
      const secret = 'SECRET-RUN-TEXT-xyz';
      const a = await runExtractor(
        { store, writer: 'CINDER', sourceKind: 'run', runSummary: secret, existingMemories: [] },
        async () => { throw new ExtractRefusedError('auth_api_key'); },
      );
      const b = await runExtractor(
        { store, writer: 'CINDER', sourceKind: 'run', runSummary: secret, existingMemories: [] },
        async () => { throw new ExtractRefusedError('auth_api_key'); },
      );
      expect(a.parseError).toBe('exec_refused: auth_api_key');
      expect(a.parseError).not.toContain(secret);
      expect(a.added).toBe(0);
      expect(a.rejected).toEqual([]);
      expect(a.rejected).not.toBe(b.rejected);
    } finally {
      cleanup();
    }
  });

  it('the default auth runner launches claude auth status --json with a scrubbed env and a bounded timeout', async () => {
    const saved: Record<string, string | undefined> = {};
    const sentinels = { ANTHROPIC_API_KEY: 'sk-sentinel', CLAUDE_CODE_USE_BEDROCK: '1' };
    for (const [k, v] of Object.entries(sentinels)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
      execFileMock.mockReset();
      execFileMock.mockImplementation((...a: unknown[]) => {
        const cb = a[a.length - 1];
        const args = a[1] as string[];
        const stdout = args[0] === 'auth' ? '{"authMethod":"claude.ai"}' : '[]';
        if (typeof cb === 'function') cb(null, { stdout, stderr: '' });
      });
      await defaultExtractExec('p', { cwd: OK_DEPS.cwd });
      const authCall = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === 'auth') as ExecCall;
      expect(authCall[0]).toBe('claude');
      expect((authCall[2] as { cwd?: string }).cwd).toBe(NEUTRAL_CWD);
      expect(authCall[1]).toEqual(['auth', 'status', '--json']);
      expect(authCall[2].timeout).toBe(AUTH_STATUS_TIMEOUT_MS);
      expect(authCall[2].windowsHide).toBe(true);
      const keys = Object.keys(authCall[2].env ?? {}).map((k) => k.toUpperCase());
      expect(keys).not.toContain('ANTHROPIC_API_KEY');
      expect(keys.filter((k) => k.startsWith('CLAUDE_CODE_USE_'))).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

describe('defaultExtractExec ordering and re-verification (#111)', () => {
  it('verifies the cwd before auth status and again before -p, and spawns nothing if either check fails', async () => {
    mockClaudeOk();
    const order: string[] = [];
    await defaultExtractExec('p', {
      cwd: () => { order.push('cwd'); return NEUTRAL_CWD; },
      authStatus: async () => { order.push('auth'); return { stdout: '{"authMethod":"claude.ai"}' }; },
    });
    expect(order).toEqual(['cwd', 'auth', 'cwd']);
    expect(promptSpawns()).toBe(1);

    // Second check fails (the directory was tampered with between auth and spawn).
    mockClaudeOk();
    let n = 0;
    const err = await defaultExtractExec('p', {
      cwd: () => { if (++n === 2) throw new ExtractRefusedError('cwd_dirty'); return NEUTRAL_CWD; },
      authStatus: OK_AUTH,
    }).catch((e: unknown) => e);
    expect((err as ExtractRefusedError).reason).toBe('cwd_dirty');
    expect(promptSpawns()).toBe(0);
  });

  it('a failing cwd runs neither auth status nor -p', async () => {
    mockClaudeOk();
    const authStatus = vi.fn(OK_AUTH);
    const err = await defaultExtractExec('p', {
      cwd: () => { throw new ExtractRefusedError('cwd_unavailable'); },
      authStatus,
    }).catch((e: unknown) => e);
    expect((err as ExtractRefusedError).reason).toBe('cwd_unavailable');
    expect(authStatus).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('a failing auth status leaves -p unspawned', async () => {
    mockClaudeOk();
    await defaultExtractExec('p', { cwd: OK_DEPS.cwd, authStatus: () => Promise.reject({ code: 1 }) }).catch(() => undefined);
    expect(promptSpawns()).toBe(0);
  });
});

describe('prepareExtractCwd (#111)', () => {
  const roots: string[] = [];
  function programData(): string {
    const root = mkdtempSync(join(tmpdir(), 'aether-cwd-'));
    roots.push(root);
    return root;
  }
  afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
  const clean = { ancestorHasMemory: () => false };

  function refusal(fn: () => unknown): string | undefined {
    try { fn(); } catch (e) { return e instanceof ExtractRefusedError ? e.reason : `other: ${String(e)}`; }
    return undefined;
  }

  it('builds the path under ProgramData and never falls back to the profile, temp or cwd', () => {
    expect(extractCwdPath('C:\\ProgramData')).toBe(join('C:\\ProgramData', 'AetherOS', 'memory-extract-cwd'));
    expect(refusal(() => prepareExtractCwd({ programData: undefined, ...clean }))).toBe('cwd_unavailable');
    expect(refusal(() => prepareExtractCwd({ programData: '', ...clean }))).toBe('cwd_unavailable');
  });

  it('creates the directory lazily and returns the same path on the second call', () => {
    const pd = programData();
    const a = prepareExtractCwd({ programData: pd, ...clean });
    expect(a).toBe(extractCwdPath(pd));
    expect(prepareExtractCwd({ programData: pd, ...clean })).toBe(a);
  });

  it('refuses cwd_unavailable when the directory cannot be created (ProgramData is a file)', () => {
    const pd = programData();
    const file = join(pd, 'a-file');
    writeFileSync(file, 'x');
    expect(refusal(() => prepareExtractCwd({ programData: file, ...clean }))).toBe('cwd_unavailable');
  });

  it.each(['claude.exe', 'claude.cmd', 'CLAUDE.md', '.mcp.json', 'anything.txt'])(
    'refuses cwd_dirty when the directory is not strictly empty (%s planted)',
    (name) => {
      const pd = programData();
      const dir = prepareExtractCwd({ programData: pd, ...clean });
      writeFileSync(join(dir, name), 'x');
      expect(refusal(() => prepareExtractCwd({ programData: pd, ...clean }))).toBe('cwd_dirty');
    },
  );

  it('refuses cwd_dirty for a planted .claude directory', () => {
    const pd = programData();
    const dir = prepareExtractCwd({ programData: pd, ...clean });
    mkdirSync(join(dir, '.claude'));
    expect(refusal(() => prepareExtractCwd({ programData: pd, ...clean }))).toBe('cwd_dirty');
  });

  it('refuses cwd_ancestor_memory when the ancestor check reports memory/settings', () => {
    const pd = programData();
    expect(refusal(() => prepareExtractCwd({ programData: pd, ancestorHasMemory: () => true }))).toBe('cwd_ancestor_memory');
  });

  it('asks the ancestor check about the directory itself and every ancestor up to the root, and terminates', () => {
    const pd = programData();
    const seen: string[] = [];
    const dir = prepareExtractCwd({ programData: pd, ancestorHasMemory: (d) => { seen.push(d); return false; } });
    const expected: string[] = [];
    for (let d = dir; ; d = dirname(d)) { expected.push(d); if (dirname(d) === d) break; }
    expect(seen).toEqual(expected);
    expect(seen.at(-1)).toBe(dirname(seen.at(-1) as string));
    expect(seen.length).toBeGreaterThan(2);
  });

  it('with the real ancestor check, a CLAUDE.md in a grandparent refuses', () => {
    const root = programData();
    writeFileSync(join(root, 'CLAUDE.md'), 'x');
    const pd = join(root, 'sub');
    mkdirSync(pd);
    expect(refusal(() => prepareExtractCwd({ programData: pd }))).toBe('cwd_ancestor_memory');
  });

  it('refuses cwd_unsafe when the directory is a symlink/junction', () => {
    const pd = programData();
    const target = join(pd, 'elsewhere');
    mkdirSync(target);
    mkdirSync(join(pd, 'AetherOS'));
    try {
      symlinkSync(target, extractCwdPath(pd), 'junction');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return; // cannot create links here; documented skip
      throw e;
    }
    expect(refusal(() => prepareExtractCwd({ programData: pd, ...clean }))).toBe('cwd_unsafe');
  });

  it('refuses cwd_unsafe when an ancestor was swapped for a junction (realpath differs)', () => {
    const pd = programData();
    const target = join(pd, 'elsewhere');
    mkdirSync(join(target, 'memory-extract-cwd'), { recursive: true });
    try {
      symlinkSync(target, join(pd, 'AetherOS'), 'junction');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return;
      throw e;
    }
    expect(refusal(() => prepareExtractCwd({ programData: pd, ...clean }))).toBe('cwd_unsafe');
  });

  it('the default ancestor check flags CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md and .claude settings files only', () => {
    const base = programData();
    const mk = (name: string): string => { const d = join(base, name); mkdirSync(d); return d; };
    expect(ancestorHasMemoryFile(mk('none'))).toBe(false);
    const a = mk('a'); writeFileSync(join(a, 'CLAUDE.md'), 'x'); expect(ancestorHasMemoryFile(a)).toBe(true);
    const b = mk('b'); writeFileSync(join(b, 'CLAUDE.local.md'), 'x'); expect(ancestorHasMemoryFile(b)).toBe(true);
    const c = mk('c'); mkdirSync(join(c, '.claude')); writeFileSync(join(c, '.claude', 'CLAUDE.md'), 'x'); expect(ancestorHasMemoryFile(c)).toBe(true);
    const d = mk('d'); mkdirSync(join(d, '.claude')); writeFileSync(join(d, '.claude', 'settings.local.json'), '{}'); expect(ancestorHasMemoryFile(d)).toBe(true);
    const e = mk('e'); mkdirSync(join(e, '.claude')); expect(ancestorHasMemoryFile(e)).toBe(false);
  });
});

describe('spawn argv and binary resolution (#111)', () => {
  it('passes the two JSON argv elements through execFile unchanged (no shell, no quoting)', () => {
    const json = buildExtractArgs('x').filter((a) => a.startsWith('{'));
    expect(json).toEqual(['{"disableAllHooks":true}', '{"mcpServers":{}}']);
    const out = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...json], { encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual(json);
  });

  // A1 probe: on Windows a bare `claude` is NOT resolved from the child's cwd by this libuv; PATH decides.
  // A harmless node.exe copy stands in for claude, so the real binary is never run. The empty-cwd rule
  // stays regardless of this result.
  it.skipIf(process.platform !== 'win32')('a claude.exe planted in the child cwd is not what execFile("claude") resolves', () => {
    const root = mkdtempSync(join(tmpdir(), 'aether-probe-'));
    try {
      const cwdDir = join(root, 'cwd');
      const pathDir = join(root, 'pathbin');
      mkdirSync(cwdDir);
      mkdirSync(pathDir);
      copyFileSync(process.execPath, join(cwdDir, 'claude.exe'));
      copyFileSync(process.execPath, join(pathDir, 'claude.exe'));
      const out = execFileSync('claude', ['-p', 'process.execPath'], { cwd: cwdDir, env: { ...process.env, PATH: pathDir }, encoding: 'utf8' });
      expect(out.trim()).toBe(join(pathDir, 'claude.exe'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
