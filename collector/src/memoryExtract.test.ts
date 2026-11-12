import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from './memoryStore.js';
import {
  runExtractor,
  defaultExtractExec,
  EXTRACT_TIMEOUT_MS,
  AUTH_STATUS_TIMEOUT_MS,
  ExtractRefusedError,
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
  it('runs claude with hooks disabled via --settings and a bounded timeout', async () => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((...a: unknown[]) => {
      const cb = a[a.length - 1];
      if (typeof cb === 'function') cb(null, { stdout: '[]', stderr: '' });
    });
    await defaultExtractExec('hello', { authStatus: async () => ({ stdout: '{"authMethod":"claude.ai"}' }) });
    const [file, args, opts] = execFileMock.mock.calls[0] as [string, string[], { timeout?: number }];
    expect(file).toBe('claude');
    const i = args.indexOf('--settings');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('{"disableAllHooks":true}');
    expect(opts.timeout).toBe(EXTRACT_TIMEOUT_MS);
  });
});

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
    const err = await defaultExtractExec('p', { authStatus }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtractRefusedError);
    expect((err as ExtractRefusedError).reason).toBe(reason);
    expect((err as ExtractRefusedError).message).toBe(reason);
    expect(promptSpawns()).toBe(0);
  });

  it.each(['claude.ai', 'oauth_token'])('proceeds for the subscription method %s, spawning -p once', async (method) => {
    mockClaudeOk();
    const out = await defaultExtractExec('p', { authStatus: async () => ({ stdout: `{"authMethod":"${method}"}` }) });
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
      await defaultExtractExec('p');
      const authCall = execFileMock.mock.calls.find((c) => (c[1] as string[])[0] === 'auth') as ExecCall;
      expect(authCall[0]).toBe('claude');
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
