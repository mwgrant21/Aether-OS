// @vitest-environment node
//
// The default vitest environment for this repo is jsdom (see vite.config.ts).
// jsdom's patched timer/microtask globals prevent PassThrough 'data' events
// from firing, which hangs every stdio test until timeout -- the same reason
// acpClient.test.ts forces the node environment. Keep this pragma.

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { ProviderError, type ProviderEvent } from './contract';
import { FakeProvider } from './fakeProvider';
import { runProviderConformance } from './providerConformance';
import { LegacyCodexAcpAdapter } from './legacyCodexAcp';
import { CodexAppServerAdapter } from './codexAppServer';
import { ClaudeAgentSdkAdapter } from './claudeAgentSdk';
import { AcpClient } from '../acpClient';

// ---------------------------------------------------------------------------
// A stdio fake standing in for a real provider process. `handle` is given each
// decoded request and may push any number of notifications before returning a
// result, which is what lets these tests exercise streaming for real rather
// than asserting on a single canned response.
// ---------------------------------------------------------------------------

interface FakeServer {
  child: ChildProcessWithoutNullStreams;
  received: Array<{ id?: number; method: string; params?: unknown }>;
  /** Messages this fake wrote to the adapter. */
  sent: unknown[];
  /** Messages the ADAPTER wrote back that were answers rather than requests
   *  (no `method`) -- notably its reply to a server->client approval request. */
  answers: Array<{ id?: number; result?: unknown; error?: unknown }>;
}

function makeStdioFake(
  handle: (
    req: { id?: number; method: string; params?: unknown },
    push: (method: string, params: unknown) => void,
    request: (method: string, params: unknown, id: number) => void
  ) => unknown | undefined
): FakeServer {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & FakeServer;
  child.stdout = stdout as unknown as ChildProcessWithoutNullStreams['stdout'];
  child.stdin = stdin as unknown as ChildProcessWithoutNullStreams['stdin'];
  child.kill = vi.fn() as unknown as ChildProcessWithoutNullStreams['kill'];

  const server: FakeServer = { child, received: [], sent: [], answers: [] };
  const write = (obj: unknown) => {
    server.sent.push(obj);
    stdout.write(JSON.stringify(obj) + '\n');
  };
  const push = (method: string, params: unknown) => write({ jsonrpc: '2.0', method, params });
  const request = (method: string, params: unknown, id: number) => write({ jsonrpc: '2.0', id, method, params });

  let buffer = '';
  stdin.on('data', (data: Buffer) => {
    buffer += data.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: unknown; result?: unknown };
      if (!msg.method) {
        // An answer to one of OUR server->client requests (e.g. an approval).
        server.answers.push(msg as { id?: number; result?: unknown; error?: unknown });
        continue;
      }
      server.received.push({ id: msg.id, method: msg.method, params: msg.params });
      const result = handle({ id: msg.id, method: msg.method, params: msg.params }, push, request);
      if (result !== undefined && msg.id !== undefined) {
        write({ jsonrpc: '2.0', id: msg.id, result });
      }
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// ACP fake (the shipped transport)
// ---------------------------------------------------------------------------

function acpFake(): FakeServer {
  let nextPermId = 9000;
  return makeStdioFake((req, push, request) => {
    switch (req.method) {
      case 'initialize':
        return { protocolVersion: 1, authMethods: [{ id: 'api-key' }, { id: 'chat-gpt' }] };
      case 'authentication/status':
        return { type: 'chat-gpt' };
      case 'session/new':
        return { sessionId: 'acp-session-1' };
      case 'session/prompt': {
        const sessionId = (req.params as { sessionId: string }).sessionId;
        // Ask for a write permission mid-turn; the client must refuse it.
        request('session/request_permission', { sessionId }, nextPermId++);
        push('session/update', {
          sessionId,
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
        });
        push('session/update', {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } },
        });
        push('session/update', {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
        });
        return { stopReason: 'end_turn' };
      }
      default:
        return {};
    }
  });
}

function makeLegacyAdapter(): LegacyCodexAcpAdapter {
  const fake = acpFake();
  return new LegacyCodexAcpAdapter(new AcpClient(), fake.child);
}

// ---------------------------------------------------------------------------
// app-server fake
// ---------------------------------------------------------------------------

function appServerFake(): FakeServer {
  let nextApprovalId = 7000;
  return makeStdioFake((req, push, request) => {
    switch (req.method) {
      case 'initialize':
        return { userAgent: 'codex-app-server/0.153.2', codexHome: '', platformFamily: 'windows', platformOs: 'windows' };
      case 'account/read':
        return { authMode: 'chatgpt' };
      case 'thread/start':
        return { thread: { id: 'thread-1' } };
      case 'turn/start': {
        const threadId = (req.params as { threadId: string }).threadId;
        request('item/fileChange/requestApproval', { threadId, turnId: 'turn-1' }, nextApprovalId++);
        push('item/reasoning/textDelta', { threadId, turnId: 'turn-1', itemId: 'i0', delta: 'thinking' });
        push('item/agentMessage/delta', { threadId, turnId: 'turn-1', itemId: 'i1', delta: 'hello ' });
        push('item/agentMessage/delta', { threadId, turnId: 'turn-1', itemId: 'i1', delta: 'world' });
        push('thread/tokenUsage/updated', {
          threadId,
          turnId: 'turn-1',
          tokenUsage: { last: { inputTokens: 11, outputTokens: 22, cachedInputTokens: 33 } },
        });
        return { turn: { id: 'turn-1', status: 'completed' } };
      }
      default:
        return {};
    }
  });
}

function makeAppServerAdapter(): CodexAppServerAdapter {
  const fake = appServerFake();
  return new CodexAppServerAdapter(() => fake.child);
}

// ---------------------------------------------------------------------------
// The shared contract, run against every adapter
// ---------------------------------------------------------------------------

runProviderConformance({ name: 'FakeProvider', create: () => new FakeProvider({ chunks: ['hel', 'lo'] }) });
runProviderConformance({ name: 'LegacyCodexAcpAdapter', create: makeLegacyAdapter });
runProviderConformance({ name: 'CodexAppServerAdapter', create: makeAppServerAdapter });
// The Claude stub cannot connect, so only the pre-connect half of the contract
// applies -- which is exactly the half that must already be right for the real
// implementation to drop in later.
runProviderConformance({
  name: 'ClaudeAgentSdkAdapter (stub)',
  create: () => new ClaudeAgentSdkAdapter(),
  skipTurns: true,
  connectable: false,
});

// ---------------------------------------------------------------------------
// Adapter-specific behaviour the shared contract cannot express
// ---------------------------------------------------------------------------

describe('LegacyCodexAcpAdapter', () => {
  it('streams thought and message chunks separately, and only message text reaches the result', async () => {
    const adapter = makeLegacyAdapter();
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: process.cwd() });
    const events: ProviderEvent[] = [];
    const result = await adapter.sendTurn({ sessionId, text: 'go' }, (e) => events.push(e));

    expect(result.text).toBe('hello world');
    expect(events.filter((e) => e.kind === 'reasoning-chunk')).toHaveLength(1);
    // The thought chunk must NOT be folded into the answer -- doing so would
    // silently corrupt every existing verification result.
    expect(result.text).not.toContain('thinking');
    await adapter.dispose();
  });

  it('refuses the permission the agent asks for and reports the denial', async () => {
    const adapter = makeLegacyAdapter();
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: process.cwd() });
    const events: ProviderEvent[] = [];
    await adapter.sendTurn({ sessionId, text: 'write a file' }, (e) => events.push(e));

    const denials = events.filter((e) => e.kind === 'permission-request');
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ decision: 'denied' });
    await adapter.dispose();
  });

  it('does not forward an outputSchema it cannot honour', async () => {
    const adapter = makeLegacyAdapter();
    expect(adapter.capabilities().structuredOutputSchema).toBe(false);
    await adapter.connect();
    // Must not throw, and must not smuggle the schema onto the wire.
    const sessionId = await adapter.newSession({ cwd: process.cwd(), outputSchema: { type: 'object' } });
    expect(sessionId).toBe('acp-session-1');
    await adapter.dispose();
  });

  it('reports usage as unavailable rather than inventing zeros', async () => {
    const adapter = makeLegacyAdapter();
    expect(adapter.capabilities().usageReporting).toBe(false);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: process.cwd() });
    const result = await adapter.sendTurn({ sessionId, text: 'go' }, () => {});
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, cachedInputTokens: null });
    await adapter.dispose();
  });
});

describe('CodexAppServerAdapter', () => {
  it('opens threads read-only at the protocol level', async () => {
    const fake = appServerFake();
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    await adapter.newSession({ cwd: 'C:/tmp/snapshot' });

    const start = fake.received.find((r) => r.method === 'thread/start');
    expect(start?.params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never' });
    await adapter.dispose();
  });

  it('answers every approval request with an explicit denial', async () => {
    const fake = appServerFake();
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });
    await adapter.sendTurn({ sessionId, text: 'patch this file' }, () => {});

    const denial = fake.answers.find(
      (m) => (m.result as { decision?: string } | undefined)?.decision === 'denied'
    );
    expect(denial, 'the adapter must answer an approval request with decision: denied').toBeTruthy();
    await adapter.dispose();
  });

  it('reports provider-supplied token usage rather than nulls', async () => {
    const adapter = makeAppServerAdapter();
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });
    const result = await adapter.sendTurn({ sessionId, text: 'go' }, () => {});
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22, cachedInputTokens: 33 });
    expect(result.stopReason).toBe('completed');
    expect(result.text).toBe('hello world');
    await adapter.dispose();
  });

  it('treats an unrecognised turn status as an error, never as completed', async () => {
    const fake = makeStdioFake((req) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (req.method === 'turn/start') return { turn: { id: 't', status: 'inProgress' } };
      return {};
    });
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });
    const result = await adapter.sendTurn({ sessionId, text: 'go' }, () => {});
    expect(result.stopReason).toBe('error');
    await adapter.dispose();
  });

  it('fails closed on a non-subscription billing mode', async () => {
    const fake = makeStdioFake((req) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'account/read') return { authMode: 'api-key' };
      return {};
    });
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const health = await adapter.health();
    expect(health.ready).toBe(false);
    expect(health.authMode).toBe('api-key');
    await adapter.dispose();
  });

  it('rejects a thread/start response with no thread id', async () => {
    const fake = makeStdioFake((req) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: {} };
      return {};
    });
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    await expect(adapter.newSession({ cwd: 'C:/tmp' })).rejects.toBeInstanceOf(ProviderError);
    await adapter.dispose();
  });
});

describe('ClaudeAgentSdkAdapter', () => {
  it('fails loudly with NOT_IMPLEMENTED instead of silently degrading', async () => {
    const adapter = new ClaudeAgentSdkAdapter();
    let caught: unknown;
    try {
      await adapter.connect();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).code).toBe('NOT_IMPLEMENTED');
  });

  it('still declares the capability set its implementation will have', () => {
    const caps = new ClaudeAgentSdkAdapter().capabilities();
    expect(caps.streamingEvents).toBe(true);
    expect(caps.cancellation).toBe(true);
  });
});

describe('FakeProvider', () => {
  it('stops early when cancelled mid-turn', async () => {
    const adapter = new FakeProvider({ chunks: ['a', 'b', 'c'], yieldBetweenChunks: true });
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: process.cwd() });
    const turn = adapter.sendTurn({ sessionId, text: 'go' }, () => {});
    await adapter.cancel(sessionId);
    const result = await turn;
    expect(result.stopReason).toBe('cancelled');
    expect(result.text.length).toBeLessThan(3);
    await adapter.dispose();
  });
});
