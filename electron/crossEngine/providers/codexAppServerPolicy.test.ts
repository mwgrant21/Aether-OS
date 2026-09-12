// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAppServerAdapter } from './codexAppServer';
import { assertNoEnabledMcpServers, CODEX_APP_SERVER_ARGS, CODEX_SESSION_CONFIG } from './codexAppServerPolicy';

function fixture(configResponse: unknown = { config: { mcp_servers: {} } }, cwd?: string) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & { disposeTree(): Promise<void> };
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.disposeTree = async () => { child.emit('close', 0); };
  const calls: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  let buffer = '';
  child.stdin.on('data', data => {
    buffer += data.toString();
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      calls.push(request);
      const result = request.method === 'initialize' ? { userAgent: 'fixture' }
        : request.method === 'config/read' ? configResponse
          : request.method === 'thread/start' ? { thread: { id: 't1' } }
            : request.method === 'turn/start' ? { turn: { id: 'turn1', status: 'completed' } } : {};
      (child.stdout as PassThrough).write(JSON.stringify({ id: request.id, result }) + '\n');
    }
  });
  const spawnedCwds: Array<string | undefined> = [];
  return { adapter: new CodexAppServerAdapter(processCwd => { spawnedCwds.push(processCwd); return child; }, undefined, cwd), calls, spawnedCwds };
}

describe('Codex consultation sandbox and peer configuration', () => {
  let directory: string;
  let schema: { properties: Record<string, unknown>; definitions: { SandboxPolicy: { oneOf: Array<{ properties: Record<string, { enum?: string[]; type?: string }> }> } } };
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'aether-u2-schema-'));
    const require = createRequire(import.meta.url);
    // Offline schema generation only: never connect or start a provider turn.
    const entry = require.resolve('@openai/codex/bin/codex.js');
    expect(execFileSync(process.execPath, [entry, '--version'], { encoding: 'utf8' }).trim()).toBe('codex-cli 0.153.2');
    execFileSync(process.execPath, [entry, 'app-server', 'generate-json-schema', '--experimental', '--out', directory], { timeout: 15_000 });
    schema = JSON.parse(readFileSync(join(directory, 'v2', 'TurnStartParams.json'), 'utf8'));
  }, 20_000);
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it('passes private cwd to spawn before initialization', async () => {
    const { adapter, calls, spawnedCwds } = fixture(undefined, 'C:/private-empty');
    try {
      await adapter.connect();
      expect(spawnedCwds).toEqual(['C:/private-empty']);
      expect(calls[0].method).toBe('initialize');
    } finally { await adapter.dispose(); }
  });

  it('sends the pinned turn sandboxPolicy, denies tool network, and never sends thread sandbox on a turn', async () => {
    const { adapter, calls } = fixture();
    try {
      await adapter.connect();
      const sessionId = await adapter.newSession({ cwd: 'C:/empty', outputSchema: { type: 'object' } });
      await adapter.sendTurn({ sessionId, text: 'fixture only' }, () => {});
      const thread = calls.find(c => c.method === 'thread/start')!.params;
      const turn = calls.find(c => c.method === 'turn/start')!.params;
      expect(calls.find(c => c.method === 'config/read')!.params).toEqual({ cwd: 'C:/empty', includeLayers: false });
      expect(thread).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never', config: CODEX_SESSION_CONFIG });
      expect(turn).toMatchObject({ sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never', outputSchema: { type: 'object' } });
      expect(turn).not.toHaveProperty('sandbox');
      for (const key of Object.keys(turn)) expect(schema.properties).toHaveProperty(key);
      const readOnly = schema.definitions.SandboxPolicy.oneOf.find(p => p.properties.type.enum?.includes('readOnly'))!;
      expect(Object.keys(readOnly.properties).sort()).toEqual(['networkAccess', 'type']);
      expect(readOnly.properties.networkAccess.type).toBe('boolean');
    } finally { await adapter.dispose(); }
  });

  it.each([
    { config: { mcp_servers: { 'aether-bridge': { enabled: true } } } },
    { config: { mcp_servers: { arbitrary: { command: 'anything' } } } },
    { config: { mcp_servers: { malformed: null } } },
    {}, null, { config: { mcp_servers: [] } },
  ])('rejects unproven or enabled peers before starting a thread: %j', async response => {
    const { adapter, calls } = fixture(response);
    try {
      await adapter.connect();
      await expect(adapter.newSession({ cwd: 'C:/empty' })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
      expect(calls.some(c => c.method === 'thread/start')).toBe(false);
    } finally { await adapter.dispose(); }
  });

  it('accepts explicitly disabled entries and forces app/plugin/delegation features off at both scopes', () => {
    expect(() => assertNoEnabledMcpServers({ config: { mcp_servers: { example: { enabled: false } } } })).not.toThrow();
    expect(CODEX_APP_SERVER_ARGS.at(-1)).toBe('app-server');
    expect(CODEX_SESSION_CONFIG).toEqual({ web_search: 'disabled', 'features.apps': false, 'features.plugins': false,
      'features.multi_agent': false, 'features.multi_agent_v2': false, 'features.skill_mcp_dependency_install': false });
    for (const [key, value] of Object.entries(CODEX_SESSION_CONFIG)) expect(CODEX_APP_SERVER_ARGS).toContain(`${key}=${JSON.stringify(value)}`);
  });
});
