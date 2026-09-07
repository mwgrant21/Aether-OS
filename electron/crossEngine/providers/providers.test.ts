// @vitest-environment node
//
// The default vitest environment for this repo is jsdom (see vite.config.ts).
// jsdom's patched timer/microtask globals prevent PassThrough 'data' events
// from firing, which hangs every stdio test until timeout -- the same reason
// acpClient.test.ts forces the node environment. Keep this pragma.

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';

import { ProviderError, type ProviderAdapter, type ProviderEvent } from './contract';
import { FakeProvider } from './fakeProvider';
import { runProviderConformance } from './providerConformance';
import { LegacyCodexAcpAdapter } from './legacyCodexAcp';
import { CodexAppServerAdapter } from './codexAppServer';
import { ClaudeHeadlessCliAdapter } from './claudeHeadlessCli';
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
      const id = msg.id;
      // A handler may return a Promise to answer slowly, which is what lets a
      // test exercise a deadline that spans more than one protocol phase.
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        void (result as Promise<unknown>).then((r) => {
          if (r !== undefined && id !== undefined) write({ jsonrpc: '2.0', id, result: r });
        });
      } else if (result !== undefined && id !== undefined) {
        write({ jsonrpc: '2.0', id, result });
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
        // GetAccountResponse: { account: Account | null, requiresOpenaiAuth }.
        // Account is a tagged union on `type`. The previous fake invented a
        // top-level `authMode`, which is why the adapter's own misreading of
        // this response went unnoticed.
        return { account: { type: 'chatgpt', email: null, planType: 'pro' }, requiresOpenaiAuth: false };
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
        // The real server accepts the turn immediately and reports the
        // outcome later via turn/completed. The old fake returned a
        // synchronously-completed turn, which masked the adapter treating
        // turn/start's response as the outcome.
        push('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed' } });
        return { turn: { id: 'turn-1', status: 'inProgress' } };
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
// claude -p fake. Emits the exact stream-json line vocabulary a real run
// produced (system/init, stream_event/content_block_delta, user tool_result,
// result), so the adapter is tested against observed output rather than an
// invented shape.
// ---------------------------------------------------------------------------

interface ClaudeFake {
  spawnTurn: (args: string[], cwd: string) => ChildProcess;
  /** Every argv the adapter spawned, so a test can assert the read-only flag
   *  set actually reaches the CLI. */
  calls: Array<{ args: string[]; cwd: string }>;
}

function claudeCliFake(opts: { deltas?: string[]; denyPermission?: boolean; omitResult?: boolean } = {}): ClaudeFake {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const spawnTurn = (args: string[], cwd: string): ChildProcess => {
    calls.push({ args, cwd });
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const child = new EventEmitter() as unknown as ChildProcess & { stdout: PassThrough; stdin: PassThrough };
    child.stdout = stdout;
    child.stdin = stdin;
    (child as unknown as { kill: () => void }).kill = vi.fn();

    const sid = 'claude-sess-abc';
    const line = (o: unknown) => stdout.write(JSON.stringify(o) + '\n');
    queueMicrotask(() => {
      line({ type: 'system', subtype: 'init', session_id: sid, cwd, tools: ['Read', 'Grep', 'Glob'], mcp_servers: [] });
      for (const d of opts.deltas ?? ['hello ', 'world']) {
        line({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d } },
          session_id: sid,
        });
      }
      if (opts.denyPermission) {
        line({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: 'Permission for this tool use was denied.' },
            ],
          },
          session_id: sid,
        });
      }
      if (!opts.omitResult) {
        line({
          type: 'result',
          subtype: 'success',
          session_id: sid,
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 9, cache_creation_input_tokens: 3 },
        });
      }
      child.emit('close', 0);
    });
    return child;
  };
  return { spawnTurn, calls };
}

/** Emits pre-built stream-json lines, one write each. */
function rawClaudeSpawn(lines: unknown[]): (args: string[], cwd: string) => ChildProcess {
  return rawClaudeSpawnBuffers(lines.map((l) => Buffer.from(JSON.stringify(l) + '\n', 'utf8')));
}

/** Emits raw byte chunks verbatim, so a test can split a multi-byte character
 *  across a read boundary. */
function rawClaudeSpawnBuffers(chunks: Buffer[]): (args: string[], cwd: string) => ChildProcess {
  return () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const child = new EventEmitter() as unknown as ChildProcess & { stdout: PassThrough; stdin: PassThrough };
    child.stdout = stdout;
    child.stdin = stdin;
    (child as unknown as { kill: () => void }).kill = vi.fn();
    queueMicrotask(() => {
      for (const c of chunks) stdout.write(c);
      child.emit('close', 0);
    });
    return child;
  };
}

function makeClaudeAdapter(): ClaudeHeadlessCliAdapter {
  return new ClaudeHeadlessCliAdapter(claudeCliFake().spawnTurn);
}

// ---------------------------------------------------------------------------
// The shared contract, run against every adapter
// ---------------------------------------------------------------------------

runProviderConformance({ name: 'FakeProvider', create: () => new FakeProvider({ chunks: ['hel', 'lo'] }) });
runProviderConformance({ name: 'LegacyCodexAcpAdapter', create: makeLegacyAdapter });
runProviderConformance({ name: 'CodexAppServerAdapter', create: makeAppServerAdapter });
runProviderConformance({ name: 'ClaudeHeadlessCliAdapter', create: makeClaudeAdapter });

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

  it('stays pending until turn/completed rather than trusting turn/start', async () => {
    // turn/start resolves as soon as the turn is ACCEPTED. A fake that never
    // sends turn/completed must therefore time out, not report a result.
    const fake = makeStdioFake((req) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (req.method === 'turn/start') return { turn: { id: 't', status: 'inProgress' } };
      return {};
    });
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });
    const result = await adapter.sendTurn({ sessionId, text: 'go', timeoutMs: 80 }, () => {});
    expect(result.stopReason).toBe('timeout');
    await adapter.dispose();
  });

  it('reports a failed turn from turn/completed as an error, not a completion', async () => {
    const fake = makeStdioFake((req, push) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (req.method === 'turn/start') {
        const threadId = (req.params as { threadId: string }).threadId;
        push('turn/completed', { threadId, turn: { id: 't', status: 'failed', error: { message: 'nope' } } });
        return { turn: { id: 't', status: 'inProgress' } };
      }
      return {};
    });
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });
    const result = await adapter.sendTurn({ sessionId, text: 'go' }, () => {});
    expect(result.stopReason).toBe('error');
    await adapter.dispose();
  });

  it('ignores a stale turn/completed belonging to an earlier turn', async () => {
    // A turn that timed out locally can still complete provider-side. That
    // late notification must not settle the NEXT turn on the same thread.
    let turnNo = 0;
    const fake = makeStdioFake((req, push) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (req.method === 'turn/start') {
        turnNo += 1;
        const threadId = (req.params as { threadId: string }).threadId;
        if (turnNo === 2) {
          // The FIRST turn's completion, arriving during the second turn.
          push('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed' } });
        }
        return { turn: { id: 'turn-' + turnNo, status: 'inProgress' } };
      }
      return {};
    });
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });
    await adapter.sendTurn({ sessionId, text: 'first', timeoutMs: 60 }, () => {});
    const second = await adapter.sendTurn({ sessionId, text: 'second', timeoutMs: 60 }, () => {});
    // Matching on threadId alone would return 'completed' here.
    expect(second.stopReason).toBe('timeout');
    await adapter.dispose();
  });

  // NOTE: there are two distinct filters, and they need separate tests.
  // Notifications that arrive BEFORE turn/start's response are buffered and
  // filtered on flush; those arriving AFTER are filtered by the live gate in
  // onNotification. A test covering only the first passes with the second
  // removed, which is how the original version of this test was vacuous.
  it('does not mix a previous turn\'s BUFFERED deltas into the next turn (flush filter)', async () => {
    // A timed-out turn keeps streaming provider-side. Those late deltas carry
    // the OLD turnId and must not be appended to the new turn's text.
    let turnNo = 0;
    const fake = makeStdioFake((req, push) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (req.method === 'turn/start') {
        turnNo += 1;
        const threadId = (req.params as { threadId: string }).threadId;
        const id = 'turn-' + turnNo;
        if (turnNo === 2) {
          // Leftovers from turn 1, arriving during turn 2.
          push('item/agentMessage/delta', { threadId, turnId: 'turn-1', itemId: 'i0', delta: 'STALE' });
          push('thread/tokenUsage/updated', {
            threadId,
            turnId: 'turn-1',
            tokenUsage: { last: { inputTokens: 999, outputTokens: 999, cachedInputTokens: 999 } },
          });
          push('item/agentMessage/delta', { threadId, turnId: id, itemId: 'i1', delta: 'fresh' });
          push('turn/completed', { threadId, turn: { id, status: 'completed' } });
        }
        return { turn: { id, status: 'inProgress' } };
      }
      return {};
    });
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });
    await adapter.sendTurn({ sessionId, text: 'first', timeoutMs: 60 }, () => {});
    const second = await adapter.sendTurn({ sessionId, text: 'second', timeoutMs: 500 }, () => {});
    expect(second.stopReason).toBe('completed');
    expect(second.text).toBe('fresh');
    expect(second.text).not.toContain('STALE');
    expect(second.usage.inputTokens).not.toBe(999);
    await adapter.dispose();
  });

  it('does not mix a previous turn\'s LATE deltas into the next turn (live gate)', async () => {
    // Same hazard, other path: these arrive AFTER turn/start has told the
    // adapter which turn was accepted, so they hit the live gate rather than
    // the buffer.
    let turnNo = 0;
    const fake = makeStdioFake((req, push) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (req.method === 'turn/start') {
        turnNo += 1;
        const threadId = (req.params as { threadId: string }).threadId;
        const id = 'turn-' + turnNo;
        if (turnNo === 2) {
          // Deliberately AFTER the turn/start response is written, so the
          // adapter already knows the accepted id.
          setTimeout(() => {
            push('item/agentMessage/delta', { threadId, turnId: 'turn-1', itemId: 'i0', delta: 'STALE' });
            push('thread/tokenUsage/updated', {
              threadId,
              turnId: 'turn-1',
              tokenUsage: { last: { inputTokens: 999, outputTokens: 999, cachedInputTokens: 999 } },
            });
            push('item/agentMessage/delta', { threadId, turnId: id, itemId: 'i1', delta: 'fresh' });
            push('turn/completed', { threadId, turn: { id, status: 'completed' } });
          }, 25);
        }
        return { turn: { id, status: 'inProgress' } };
      }
      return {};
    });
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });
    await adapter.sendTurn({ sessionId, text: 'first', timeoutMs: 60 }, () => {});
    const second = await adapter.sendTurn({ sessionId, text: 'second', timeoutMs: 500 }, () => {});
    expect(second.stopReason).toBe('completed');
    expect(second.text).toBe('fresh');
    expect(second.usage.inputTokens).not.toBe(999);
    await adapter.dispose();
  });

  it('a stale notification cannot redirect cancel() to a previous turn', async () => {
    // The hazard the previous round's fix created: activeTurn was written
    // from any notification carrying a turnId, so a late one from turn 1
    // arriving during turn 2 made cancel() interrupt turn 1 instead.
    let turnNo = 0;
    const fake = makeStdioFake((req, push) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (req.method === 'turn/start') {
        turnNo += 1;
        const threadId = (req.params as { threadId: string }).threadId;
        const id = 'turn-' + turnNo;
        if (turnNo === 2) {
          setTimeout(() => {
            push('item/agentMessage/delta', { threadId, turnId: 'turn-1', itemId: 'i0', delta: 'STALE' });
          }, 20);
        }
        return { turn: { id, status: 'inProgress' } };
      }
      return {};
    });
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });
    await adapter.sendTurn({ sessionId, text: 'first', timeoutMs: 60 }, () => {});

    const turn = adapter.sendTurn({ sessionId, text: 'second', timeoutMs: 400 }, () => {});
    await new Promise((r) => setTimeout(r, 60)); // let the stale delta land
    await adapter.cancel(sessionId);
    await turn;

    const interrupt = fake.received.find((r) => r.method === 'turn/interrupt');
    expect(interrupt).toBeTruthy();
    // Must interrupt the turn actually running, not the one that leaked in.
    expect((interrupt?.params as Record<string, unknown>)?.turnId).toBe('turn-2');
    await adapter.dispose();
  });

  it('bounds retained late-response handlers and clears them on child death', async () => {
    // A turn/start the server never acknowledges used to retain its handler --
    // and that handler's closure -- for the adapter's entire lifetime.
    const fake = makeStdioFake((req) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      return undefined; // turn/start is NEVER answered
    });
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });

    for (let i = 0; i < 25; i++) {
      await adapter.sendTurn({ sessionId, text: 'go ' + i, timeoutMs: 5 }, () => {});
    }
    expect(adapter.retainedLateHandlerCount).toBeGreaterThan(0);
    expect(adapter.retainedLateHandlerCount).toBeLessThanOrEqual(16);

    (fake.child as unknown as EventEmitter).emit('close', 1);
    expect(adapter.retainedLateHandlerCount).toBe(0);
    await adapter.dispose();
  });

  it('still interrupts when the acknowledgement itself misses the deadline', async () => {
    // The sixth window of this shape: if turn/start does not answer within the
    // shared deadline, the await rejects, `finally` clears the interrupt flag,
    // and the late accepted id is dropped -- so a pre-ack cancellation would
    // leave the provider-side turn running with no turn/interrupt ever sent.
    const ACK_DELAY_MS = 200;
    const TURN_TIMEOUT_MS = 60;
    const fake = makeStdioFake((req) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (req.method === 'turn/start') {
        // Answers well AFTER the caller's deadline has expired.
        return new Promise((resolve) =>
          setTimeout(() => resolve({ turn: { id: 'turn-verylate', status: 'inProgress' } }), ACK_DELAY_MS)
        );
      }
      return {};
    });
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });

    const turn = adapter.sendTurn({ sessionId, text: 'go', timeoutMs: TURN_TIMEOUT_MS }, () => {});
    await new Promise((r) => setTimeout(r, 20)); // cancel before the ack
    await adapter.cancel(sessionId);
    const result = await turn;
    expect(result.stopReason).toBe('timeout');

    // Give the late acknowledgement time to land and be acted on.
    await new Promise((r) => setTimeout(r, ACK_DELAY_MS + 120));
    const interrupt = fake.received.find((r) => r.method === 'turn/interrupt');
    expect(interrupt, 'a late acknowledgement must still honour the cancellation').toBeTruthy();
    expect((interrupt?.params as Record<string, unknown>)?.turnId).toBe('turn-verylate');
    await adapter.dispose();
  });

  it('replays a cancellation that arrived before turn/start was acknowledged', async () => {
    // The window the accepted-id-only strategy creates: cancel() has no id to
    // interrupt with yet, so the interrupt has to be issued once the id lands.
    const ACK_DELAY_MS = 80;
    const fake = makeStdioFake((req) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (req.method === 'turn/start') {
        return new Promise((resolve) =>
          setTimeout(() => resolve({ turn: { id: 'turn-late', status: 'inProgress' } }), ACK_DELAY_MS)
        );
      }
      return {};
    });
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });

    const turn = adapter.sendTurn({ sessionId, text: 'go', timeoutMs: 400 }, () => {});
    await new Promise((r) => setTimeout(r, 20)); // cancel BEFORE the ack
    await adapter.cancel(sessionId);
    await turn;

    const interrupt = fake.received.find((r) => r.method === 'turn/interrupt');
    expect(interrupt, 'a pre-ack cancel must still interrupt once the id arrives').toBeTruthy();
    expect((interrupt?.params as Record<string, unknown>)?.turnId).toBe('turn-late');
    await adapter.dispose();
  });

  it('can interrupt a turn acknowledged before any notification arrived', async () => {
    // cancel() reads activeTurn; if turn/start answered first and only the
    // waiter knew the id, the interrupt was silently never sent.
    const fake = makeStdioFake((req) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (req.method === 'turn/start') return { turn: { id: 'turn-solo', status: 'inProgress' } };
      return {};
    });
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });
    const turn = adapter.sendTurn({ sessionId, text: 'go', timeoutMs: 400 }, () => {});
    await new Promise((r) => setTimeout(r, 60));
    await adapter.cancel(sessionId);
    await turn;
    const interrupt = fake.received.find((r) => r.method === 'turn/interrupt');
    expect(interrupt, 'cancel() must send turn/interrupt for the accepted turn').toBeTruthy();
    expect((interrupt?.params as Record<string, unknown>)?.turnId).toBe('turn-solo');
    await adapter.dispose();
  });

  it('throws PROCESS_EXITED when the child dies mid-turn, never reports a timeout', async () => {
    const fake = makeStdioFake((req) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (req.method === 'turn/start') return { turn: { id: 't1', status: 'inProgress' } };
      return {};
    });
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });
    const turn = adapter.sendTurn({ sessionId, text: 'go', timeoutMs: 5_000 }, () => {});
    setTimeout(() => (fake.child as unknown as EventEmitter).emit('close', 1), 20);
    // A crashed provider must be distinguishable from an ordinary deadline.
    await expect(turn).rejects.toBeInstanceOf(ProviderError);
    await adapter.dispose();
  });

  it('bounds the whole turn by one deadline, not one per phase', async () => {
    // turn/start is ACKNOWLEDGED slowly (most of the budget), and no
    // completion ever arrives. Starting a fresh full-length timer for the
    // second phase would let this run for ~2x the caller's limit.
    const ACK_DELAY_MS = 90;
    const fake = makeStdioFake((req) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (req.method === 'turn/start') {
        return new Promise((resolve) =>
          setTimeout(() => resolve({ turn: { id: 't1', status: 'inProgress' } }), ACK_DELAY_MS)
        );
      }
      return {};
    });
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });
    const startedAt = Date.now();
    const result = await adapter.sendTurn({ sessionId, text: 'go', timeoutMs: 150 }, () => {});
    const elapsed = Date.now() - startedAt;
    expect(result.stopReason).toBe('timeout');
    // The ack alone consumed 90ms of a 150ms budget. Two independent timers
    // would give 90 + 150 = 240ms+; one shared deadline gives ~150ms.
    expect(elapsed).toBeGreaterThanOrEqual(ACK_DELAY_MS);
    expect(elapsed).toBeLessThan(230);
    await adapter.dispose();
  });

  it('forwards a requested outputSchema on turn/start, not thread/start', async () => {
    const fake = appServerFake();
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const schema = { type: 'object', required: ['verdict'] };
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot', outputSchema: schema });
    await adapter.sendTurn({ sessionId, text: 'go' }, () => {});

    // capabilities() advertises structuredOutputSchema:true, so dropping the
    // schema would let a caller trust a constraint that was never applied.
    // ThreadStartParams has no outputSchema field; TurnStartParams does.
    const start = fake.received.find((r) => r.method === 'thread/start');
    const turn = fake.received.find((r) => r.method === 'turn/start');
    expect((start?.params as Record<string, unknown>)?.outputSchema).toBeUndefined();
    expect((turn?.params as Record<string, unknown>)?.outputSchema).toEqual(schema);
    await adapter.dispose();
  });

  it('classifies every Account variant and fails closed off subscription', async () => {
    // Account = { type: "apiKey" } | { type: "chatgpt", ... } | { type: "amazonBedrock", ... }
    const cases: Array<[unknown, boolean, string]> = [
      [{ type: 'chatgpt', email: null, planType: 'pro' }, true, 'subscription'],
      [{ type: 'apiKey' }, false, 'api-key'],
      [{ type: 'amazonBedrock', usesCodexManagedCredentials: false }, false, 'gateway'],
      [null, false, 'unauthenticated'],
    ];
    for (const [account, ready, authMode] of cases) {
      const fake = makeStdioFake((req) => {
        if (req.method === 'initialize') return { userAgent: 'x' };
        if (req.method === 'account/read') return { account, requiresOpenaiAuth: false };
        return {};
      });
      const adapter = new CodexAppServerAdapter(() => fake.child);
      await adapter.connect();
      const health = await adapter.health();
      expect(health.ready, JSON.stringify(account)).toBe(ready);
      expect(health.authMode, JSON.stringify(account)).toBe(authMode);
      await adapter.dispose();
    }
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

describe('ClaudeHeadlessCliAdapter', () => {
  it('passes the full fail-closed read-only flag set on every turn', async () => {
    const fake = claudeCliFake();
    const adapter = new ClaudeHeadlessCliAdapter(fake.spawnTurn);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });
    await adapter.sendTurn({ sessionId, text: 'review this' }, () => {});

    const args = fake.calls[0].args;
    // --restricted alone is NOT read-only: a measured run left Write, Edit,
    // NotebookEdit and Skill available. Each flag carries part of the
    // guarantee, so each is asserted individually rather than as one blob.
    expect(args).toContain('--restricted');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    // Fail-closed allowlist, not a denylist -- a denylist would admit any
    // newly added tool by default.
    expect(args).toContain('--allowedTools');
    expect(args).toContain('Read');
    expect(args).not.toContain('--disallowedTools');
    // Anything that would prompt is denied automatically.
    expect(args.join(' ')).toContain('--permission-prompts none');
    expect(args).not.toContain('bypassPermissions');
    expect(fake.calls[0].cwd).toBe('C:/tmp/snapshot');
    await adapter.dispose();
  });

  it('learns the CLI session id and resumes it on the next turn', async () => {
    const fake = claudeCliFake();
    const adapter = new ClaudeHeadlessCliAdapter(fake.spawnTurn);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });

    await adapter.sendTurn({ sessionId, text: 'first' }, () => {});
    expect(fake.calls[0].args).not.toContain('--resume');

    await adapter.sendTurn({ sessionId, text: 'second' }, () => {});
    expect(fake.calls[1].args).toContain('--resume');
    expect(fake.calls[1].args).toContain('claude-sess-abc');
    await adapter.dispose();
  });

  it('reports provider usage from the result line', async () => {
    const adapter = makeClaudeAdapter();
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });
    const result = await adapter.sendTurn({ sessionId, text: 'go' }, () => {});
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 7, cachedInputTokens: 9 });
    expect(result.stopReason).toBe('completed');
    expect(result.text).toBe('hello world');
    await adapter.dispose();
  });

  it('surfaces a denied tool as a permission-request event', async () => {
    const fake = claudeCliFake({ denyPermission: true });
    const adapter = new ClaudeHeadlessCliAdapter(fake.spawnTurn);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });
    const events: ProviderEvent[] = [];
    await adapter.sendTurn({ sessionId, text: 'write a file' }, (e) => events.push(e));

    const denials = events.filter((e) => e.kind === 'permission-request');
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ decision: 'denied' });
    await adapter.dispose();
  });

  it('treats a turn that produced no result line as an error, not a completion', async () => {
    const fake = claudeCliFake({ omitResult: true });
    const adapter = new ClaudeHeadlessCliAdapter(fake.spawnTurn);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp/snapshot' });
    const result = await adapter.sendTurn({ sessionId, text: 'go' }, () => {});
    expect(result.stopReason).toBe('error');
    await adapter.dispose();
  });

  it('health is fail-closed: only a proven first-party subscription login is ready', async () => {
    const fake = claudeCliFake();
    const cases: Array<[Record<string, unknown> | null, boolean, string]> = [
      [{ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }, true, 'subscription'],
      [{ loggedIn: false }, false, 'unauthenticated'],
      [{ loggedIn: true, authMethod: 'apiKey', apiProvider: 'firstParty' }, false, 'api-key'],
      [{ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }, false, 'gateway'],
      [{ loggedIn: true }, false, 'unknown'],
      [null, false, 'unknown'],
    ];
    for (const [status, ready, authMode] of cases) {
      const adapter = new ClaudeHeadlessCliAdapter(fake.spawnTurn, null, async () => status);
      await adapter.connect();
      const health = await adapter.health();
      expect(health.ready, JSON.stringify(status)).toBe(ready);
      expect(health.authMode, JSON.stringify(status)).toBe(authMode);
      await adapter.dispose();
    }
    // The probe spends no tokens and must never start a turn -- the same rule
    // AcpClient.probe() follows by never sending `authenticate`.
    expect(fake.calls).toHaveLength(0);
  });

  it('health never copies the probe\'s email or org id into ProviderHealth', async () => {
    const fake = claudeCliFake();
    const adapter = new ClaudeHeadlessCliAdapter(fake.spawnTurn, null, async () => ({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'someone@example.com',
      orgId: 'org-abc-123',
    }));
    await adapter.connect();
    const serialized = JSON.stringify(await adapter.health());
    // ProviderHealth is a structure other layers may log or persist.
    expect(serialized).not.toContain('someone@example.com');
    expect(serialized).not.toContain('org-abc-123');
    await adapter.dispose();
  });

  it('falls back to the result subtype when stop_reason is absent', async () => {
    // Defaulting an unrecognised stop_reason straight to 'error' threw away
    // complete answers: the text was correct while the turn read as failed.
    const spawnTurn = rawClaudeSpawn([
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } } },
      { type: 'result', subtype: 'success', session_id: 's1', usage: {} },
    ]);
    const adapter = new ClaudeHeadlessCliAdapter(spawnTurn);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp' });
    const result = await adapter.sendTurn({ sessionId, text: 'go' }, () => {});
    expect(result.stopReason).toBe('completed');
    expect(result.text).toBe('done');
    await adapter.dispose();
  });

  it('still fails closed when neither stop_reason nor subtype is conclusive', async () => {
    const spawnTurn = rawClaudeSpawn([
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'result', session_id: 's1', usage: {} },
    ]);
    const adapter = new ClaudeHeadlessCliAdapter(spawnTurn);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp' });
    expect((await adapter.sendTurn({ sessionId, text: 'go' }, () => {})).stopReason).toBe('error');
    await adapter.dispose();
  });

  it('decodes a multi-byte character split across two stdout chunks', async () => {
    const line =
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a\u2014b' } },
      }) + '\n';
    const full = Buffer.concat([
      Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }) + '\n', 'utf8'),
      Buffer.from(line, 'utf8'),
      Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1', stop_reason: 'end_turn', usage: {} }) + '\n', 'utf8'),
    ]);
    // Split inside the em dash's 3-byte UTF-8 sequence. A raw
    // chunk.toString('utf8') decodes the partial bytes to U+FFFD, which either
    // corrupts the text or breaks JSON.parse and is silently swallowed.
    const cut = full.indexOf(Buffer.from('\u2014', 'utf8')) + 1;
    const spawnTurn = rawClaudeSpawnBuffers([full.subarray(0, cut), full.subarray(cut)]);
    const adapter = new ClaudeHeadlessCliAdapter(spawnTurn);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp' });
    const result = await adapter.sendTurn({ sessionId, text: 'go' }, () => {});
    expect(result.text).toBe('a\u2014b');
    await adapter.dispose();
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

describe('adapter lifecycle and cancellation (review follow-ups)', () => {
  it('CodexAppServer surfaces a spawn failure as PROCESS_EXITED instead of crashing the process', async () => {
    // Without an 'error' listener Node throws this as an uncaught exception,
    // which in the real app takes down the Electron main process.
    const spawnChild = () => {
      const stdout = new PassThrough();
      const stdin = new PassThrough();
      const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & { stdout: PassThrough; stdin: PassThrough };
      child.stdout = stdout as unknown as ChildProcessWithoutNullStreams['stdout'];
      child.stdin = stdin as unknown as ChildProcessWithoutNullStreams['stdin'];
      child.kill = vi.fn() as unknown as ChildProcessWithoutNullStreams['kill'];
      queueMicrotask(() => child.emit('error', new Error('spawn codex ENOENT')));
      return child;
    };
    const adapter = new CodexAppServerAdapter(spawnChild);
    let caught: unknown;
    try {
      await adapter.connect();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).code).toBe('PROCESS_EXITED');
    await adapter.dispose();
  });

  it('CodexAppServer rejects pending calls when the child closes mid-turn', async () => {
    // Must NOT answer turn/start -- otherwise the turn completes before the
    // close event fires and the test proves nothing.
    const fake = makeStdioFake((req) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      return undefined;
    });
    const emitClose = () => (fake.child as unknown as EventEmitter).emit('close', 1);
    const spawnChild = () => fake.child;
    const adapter = new CodexAppServerAdapter(spawnChild);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp' });
    const turn = adapter.sendTurn({ sessionId, text: 'go' }, () => {});
    emitClose();
    // Must reject promptly rather than hanging to turn/start's 5-minute cap.
    await expect(turn).rejects.toBeInstanceOf(ProviderError);
    await adapter.dispose();
  });

  it('CodexAppServer: cancelling an idle session does not poison the next turn', async () => {
    const fake = appServerFake();
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp' });
    await adapter.cancel(sessionId); // no turn in flight
    const result = await adapter.sendTurn({ sessionId, text: 'go' }, () => {});
    // A stale interrupt flag would report this completed turn as 'cancelled'.
    expect(result.stopReason).toBe('completed');
    await adapter.dispose();
  });

  it('LegacyCodexAcp: cancelling an idle session does not discard the next turn', async () => {
    const adapter = makeLegacyAdapter();
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: process.cwd() });
    await adapter.cancel(sessionId); // races a turn that already finished
    const result = await adapter.sendTurn({ sessionId, text: 'go' }, () => {});
    expect(result.stopReason).toBe('completed');
    expect(result.text).toBe('hello world');
    await adapter.dispose();
  });

  it('LegacyCodexAcp: a timed-out turn returns the text that did arrive', async () => {
    // Streams two chunks, then never answers session/prompt.
    const fake = makeStdioFake((req, push) => {
      if (req.method === 'initialize') return { protocolVersion: 1, authMethods: [{ id: 'chat-gpt' }] };
      if (req.method === 'session/new') return { sessionId: 'acp-session-1' };
      if (req.method === 'session/prompt') {
        const sessionId = (req.params as { sessionId: string }).sessionId;
        push('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial ' } } });
        push('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } } });
        return undefined; // never responds
      }
      return {};
    });
    const adapter = new LegacyCodexAcpAdapter(new AcpClient(), fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: process.cwd() });
    const result = await adapter.sendTurn({ sessionId, text: 'go', timeoutMs: 80 }, () => {});
    expect(result.stopReason).toBe('timeout');
    // Previously returned '' -- a long answer that timed out on its last chunk
    // was indistinguishable from one that produced nothing.
    expect(result.text).toBe('partial answer');
    await adapter.dispose();
  });
});

// Proves the conformance suite's own `connectable: false` option works on its
// own. It was documented but keyed on a different flag, so registering it
// without skipTurns produced six failing tests instead.
class UnconnectableAdapter implements ProviderAdapter {
  readonly id = 'fake' as const;
  capabilities() {
    return {
      resumableSessions: false,
      streamingEvents: false,
      permissionRequests: false,
      usageReporting: false,
      cancellation: false,
      structuredOutputSchema: false,
    };
  }
  async connect(): Promise<void> {
    throw new ProviderError('NOT_IMPLEMENTED', 'cannot connect');
  }
  async health(): Promise<never> {
    throw new ProviderError('NOT_CONNECTED', 'nope');
  }
  async newSession(): Promise<never> {
    throw new ProviderError('NOT_CONNECTED', 'nope');
  }
  async sendTurn(): Promise<never> {
    throw new ProviderError('NOT_CONNECTED', 'nope');
  }
  async cancel(): Promise<void> {}
  async dispose(): Promise<void> {}
}

runProviderConformance({ name: 'UnconnectableAdapter', create: () => new UnconnectableAdapter(), connectable: false });

// The refactor's own invariant: a turn record leaves `turns` through exactly
// one function, on exactly these paths. Before the restructure this state was
// spread across eleven fields with no single retirement point, which is what
// let round 7's leak exist at all.
describe('CodexAppServerAdapter: turn record retirement', () => {
  const completingFake = () =>
    makeStdioFake((req, push) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (req.method === 'turn/start') {
        const threadId = (req.params as { threadId: string }).threadId;
        push('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed' } });
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      return {};
    });

  const stallingFake = (ackId: string | null) =>
    makeStdioFake((req) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (req.method === 'turn/start') {
        return ackId === null ? undefined : { turn: { id: ackId, status: 'inProgress' } };
      }
      return {};
    });

  it('retires on a completed outcome', async () => {
    const fake = completingFake();
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp' });
    await adapter.sendTurn({ sessionId, text: 'go' }, () => {});
    expect(adapter.liveTurnCount).toBe(0);
    await adapter.dispose();
  });

  it('retires on a deadline once the turn id is known', async () => {
    const fake = stallingFake('turn-known');
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp' });
    const result = await adapter.sendTurn({ sessionId, text: 'go', timeoutMs: 60 }, () => {});
    expect(result.stopReason).toBe('timeout');
    // The id is known, so any interrupt owed was already sent: nothing further
    // is owed and the record goes.
    expect(adapter.liveTurnCount).toBe(0);
    await adapter.dispose();
  });

  it('KEEPS the record when the turn was never acknowledged', async () => {
    // The deliberate exception, and the whole reason the record outlives
    // sendTurn: the acknowledgement may still arrive carrying the id a pending
    // cancellation needs.
    const fake = stallingFake(null);
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp' });
    await adapter.sendTurn({ sessionId, text: 'go', timeoutMs: 40 }, () => {});
    expect(adapter.liveTurnCount).toBe(1);
    await adapter.dispose();
  });

  it('retires on child death', async () => {
    const fake = stallingFake(null);
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp' });
    await adapter.sendTurn({ sessionId, text: 'go', timeoutMs: 40 }, () => {});
    expect(adapter.liveTurnCount).toBe(1);
    (fake.child as unknown as EventEmitter).emit('close', 1);
    expect(adapter.liveTurnCount).toBe(0);
    await adapter.dispose();
  });

  it('retires on dispose', async () => {
    const fake = stallingFake(null);
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp' });
    await adapter.sendTurn({ sessionId, text: 'go', timeoutMs: 40 }, () => {});
    expect(adapter.liveTurnCount).toBe(1);
    await adapter.dispose();
    expect(adapter.liveTurnCount).toBe(0);
  });

  it('retires oldest-first once the cap is reached', async () => {
    const fake = stallingFake(null);
    const adapter = new CodexAppServerAdapter(() => fake.child);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp' });
    for (let i = 0; i < 25; i += 1) {
      await adapter.sendTurn({ sessionId, text: 'go ' + i, timeoutMs: 5 }, () => {});
    }
    expect(adapter.liveTurnCount).toBeLessThanOrEqual(16);
    await adapter.dispose();
  });
});

describe('CodexAppServerAdapter: retention bounds must not break live turns', () => {
  it('never expires a record whose caller is still waiting', async () => {
    // The TTL is shorter than the default turn deadline, so a legitimately
    // long turn WILL be older than its TTL while still running. Sweeping it
    // would leave its own sendTurn waiting on a record that no longer exists,
    // and its later deltas and completion would find nothing - reporting a
    // successful long turn as a truncated timeout.
    let settleTurnOne: (() => void) | null = null;
    const fake = makeStdioFake((req, push) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (req.method === 'turn/start') {
        const threadId = (req.params as { threadId: string }).threadId;
        const id = (req.params as { input: unknown[] }) && 'turn-' + (settleTurnOne ? '2' : '1');
        if (id === 'turn-1') {
          // Completes only when the test says so, long after its TTL.
          settleTurnOne = () => {
            push('item/agentMessage/delta', { threadId, turnId: 'turn-1', itemId: 'i', delta: 'late but valid' });
            push('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed' } });
          };
        }
        return { turn: { id, status: 'inProgress' } };
      }
      return {};
    });

    // 20ms TTL: turn one is comfortably "expired" by age while still running.
    const adapter = new CodexAppServerAdapter(() => fake.child, 20);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp' });

    const first = adapter.sendTurn({ sessionId, text: 'long one', timeoutMs: 2000 }, () => {});
    await new Promise((r) => setTimeout(r, 60)); // now older than its TTL

    // Starting another turn runs the sweep. It must not take turn one.
    const second = adapter.sendTurn({ sessionId, text: 'other', timeoutMs: 60 }, () => {});
    await second;

    settleTurnOne?.();
    const result = await first;
    expect(result.stopReason).toBe('completed');
    expect(result.text).toBe('late but valid');
    await adapter.dispose();
  });

  it('retains for the FULL ttl when the caller waited longer than it -- the shipped ratio', async () => {
    // The production defaults are ttl 120s against a 300s deadline, so by the
    // time the caller gives up the record's creation-time expiresAt is already
    // 180s in the past. Arming from that stale value gave a delay of zero and
    // retired the record on the next tick, collapsing the retention window to
    // nothing in exactly the configuration that ships.
    //
    // Both earlier retention tests used ttl > timeout, which is the inverse of
    // production and cannot see this.
    const fake = makeStdioFake((req) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      return undefined; // turn/start never answered
    });
    const TTL = 250;
    const adapter = new CodexAppServerAdapter(() => fake.child, TTL);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp' });

    // Caller waits LONGER than the ttl, as in production.
    await adapter.sendTurn({ sessionId, text: 'go', timeoutMs: TTL * 2 }, () => {});

    // The window must start now, not at record creation.
    expect(adapter.liveTurnCount).toBe(1);
    await new Promise((r) => setTimeout(r, TTL / 2));
    expect(adapter.liveTurnCount, 'retired early: the ttl was measured from creation, not from retention').toBe(1);

    await new Promise((r) => setTimeout(r, TTL));
    expect(adapter.liveTurnCount).toBe(0);
    await adapter.dispose();
  });

  it('a late acknowledgement can still interrupt after the caller waited past the ttl', async () => {
    // The consequence the window exists for. Cancel lands pre-ack, the caller
    // gives up after longer than the ttl, and the acknowledgement arrives
    // later still -- the interrupt must be sent.
    const ACK_DELAY = 260;
    const fake = makeStdioFake((req) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (req.method === 'turn/start') {
        return new Promise((resolve) =>
          setTimeout(() => resolve({ turn: { id: 'turn-late', status: 'inProgress' } }), ACK_DELAY)
        );
      }
      return {};
    });
    const adapter = new CodexAppServerAdapter(() => fake.child, 100); // ttl < caller deadline
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp' });

    const turn = adapter.sendTurn({ sessionId, text: 'go', timeoutMs: 180 }, () => {});
    await new Promise((r) => setTimeout(r, 20));
    await adapter.cancel(sessionId);
    await turn;

    await new Promise((r) => setTimeout(r, ACK_DELAY));
    const interrupt = fake.received.find((r) => r.method === 'turn/interrupt');
    expect(interrupt, 'the late ack must still honour the cancellation').toBeTruthy();
    expect((interrupt?.params as Record<string, unknown>)?.turnId).toBe('turn-late');
    await adapter.dispose();
  });

  it('expires a retained record on its own timer, with no later turn to trigger a sweep', async () => {
    // Checking expiresAt only on insert is not a TTL: with no second turn, the
    // record would sit for the adapter's lifetime holding its listener.
    const fake = makeStdioFake((req) => {
      if (req.method === 'initialize') return { userAgent: 'x' };
      if (req.method === 'thread/start') return { thread: { id: 'thread-1' } };
      return undefined; // turn/start is never answered
    });
    const adapter = new CodexAppServerAdapter(() => fake.child, 40);
    await adapter.connect();
    const sessionId = await adapter.newSession({ cwd: 'C:/tmp' });

    await adapter.sendTurn({ sessionId, text: 'go', timeoutMs: 20 }, () => {});
    expect(adapter.liveTurnCount).toBe(1); // retained: the ack may still arrive

    await new Promise((r) => setTimeout(r, 120)); // no further turns submitted
    expect(adapter.liveTurnCount).toBe(0);
    await adapter.dispose();
  });
});

