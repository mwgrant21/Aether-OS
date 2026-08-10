// @vitest-environment node
//
// See acpClient.test.ts's header comment: jsdom's patched timers/microtasks
// prevent PassThrough 'data' events from firing, hanging every test here
// until timeout. Force the plain node environment for this file too.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import type { GitProbe } from '../../src/shared/projectIdentity';
import type { DispatchEvidence, EvidenceResult } from './dispatchEvidence';
import type { VerificationSnapshot } from './snapshotBuilder';
import type { VerificationEvent } from '../../src/shared/crossEngineTypes';

vi.mock('./dispatchEvidence', () => ({ resolveDispatchEvidence: vi.fn() }));
vi.mock('./snapshotBuilder', () => ({ buildVerificationSnapshot: vi.fn() }));
vi.mock('./acpProcess', () => ({ spawnAcpProcess: vi.fn() }));

import { resolveDispatchEvidence } from './dispatchEvidence';
import { buildVerificationSnapshot } from './snapshotBuilder';
import { spawnAcpProcess } from './acpProcess';
import { CodexVerifier } from './codexVerifier';

type AcpRequest = { id: number; method: string; params?: unknown };

type FakeChild = {
  stdout: PassThrough;
  stdin: PassThrough;
  kill: () => void;
  _responders: Array<(req: AcpRequest) => void>;
  received: AcpRequest[];
};

/** The real Codex ACP adapter (v1.1.14) InitializeResponse shape,
 *  captured from a live handshake -- see acpClient.test.ts. */
const REAL_INITIALIZE_RESULT = {
  protocolVersion: 1,
  authMethods: [
    { id: 'api-key', name: 'API Key' },
    { id: 'chat-gpt', name: 'ChatGPT' },
  ],
};

function fakeChild(): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const emitter = new EventEmitter() as unknown as FakeChild;
  emitter.stdout = stdout;
  emitter.stdin = stdin;
  emitter.kill = vi.fn();
  emitter._responders = [];
  emitter.received = [];
  stdin.on('data', (data: Buffer) => {
    for (const line of data.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const req = JSON.parse(line) as AcpRequest;
      emitter.received.push(req);
      const responder = emitter._responders.shift();
      if (responder) responder(req);
    }
  });
  return emitter;
}

function respondTo(child: FakeChild, result: unknown) {
  child._responders.push((req) => {
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
  });
}

/** Queues a `session/prompt` responder that first streams a `session/update`
 *  notification carrying the given text as one `agent_message_chunk`, then
 *  responds to the `session/prompt` request itself with a PromptResponse. */
function respondToPromptWithMessage(child: FakeChild, sessionId: string, text: string) {
  child._responders.push((req) => {
    const notification = { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } };
    child.stdout.write(JSON.stringify(notification) + '\n');
    child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn' } }) + '\n');
  });
}

const evidence: DispatchEvidence = { toolUseId: 'tu1', projectRoot: 'C:/proj', claim: 'did the thing', touchedFiles: ['a.ts'] };

function okEvidence(): EvidenceResult {
  return { ok: true, evidence };
}

describe('CodexVerifier.run', () => {
  let dispose: ReturnType<typeof vi.fn>;
  let events: VerificationEvent[];
  let verifier: CodexVerifier;

  beforeEach(() => {
    vi.clearAllMocks();
    dispose = vi.fn(async () => {});
    events = [];
    vi.mocked(buildVerificationSnapshot).mockResolvedValue({ snapshotDir: 'C:/tmp/snap', dispose } as VerificationSnapshot);
    verifier = new CodexVerifier({} as DatabaseSync, 'C:/sessions', 'pinned-session', {} as GitProbe);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns inconclusive without connecting when evidence is incomplete', async () => {
    vi.mocked(resolveDispatchEvidence).mockResolvedValue({ ok: false, missing: 'dispatch transcript not found' });

    const result = await verifier.run('run-1', { toolUseId: 'tu1' }, (e) => events.push(e));

    expect(result.verdict).toBe('inconclusive');
    expect(result.summary).toBe('dispatch transcript not found');
    expect(events.some((e) => e.kind === 'error' && e.code === 'EVIDENCE_INCOMPLETE')).toBe(true);
    expect(spawnAcpProcess).not.toHaveBeenCalled();
    expect(buildVerificationSnapshot).not.toHaveBeenCalled();
  });

  it('refuses to run and reports BILLING_MODE_BLOCKED when status is api-key after apparent success', async () => {
    vi.mocked(resolveDispatchEvidence).mockResolvedValue(okEvidence());
    const child = fakeChild();
    vi.mocked(spawnAcpProcess).mockReturnValue(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT); // initialize
    respondTo(child, { type: 'api-key' }); // authentication/status

    const result = await verifier.run('run-2', { toolUseId: 'tu1' }, (e) => events.push(e));

    expect(result.verdict).toBe('inconclusive');
    expect(events.some((e) => e.kind === 'error' && e.code === 'BILLING_MODE_BLOCKED')).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('refuses to run when status changes from chat-gpt to api-key between probe and this run', async () => {
    // A prior probe elsewhere may have observed 'chat-gpt', but CodexVerifier
    // never trusts a cached status -- it re-checks authentication/status on
    // every run and blocks on whatever the fresh check reports.
    vi.mocked(resolveDispatchEvidence).mockResolvedValue(okEvidence());
    const child = fakeChild();
    vi.mocked(spawnAcpProcess).mockReturnValue(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'api-key' });

    const result = await verifier.run('run-3', { toolUseId: 'tu1' }, (e) => events.push(e));

    expect(result.verdict).toBe('inconclusive');
    expect(events.some((e) => e.kind === 'error' && e.code === 'BILLING_MODE_BLOCKED')).toBe(true);
  });

  it('fails the run closed when the pre-prompt recheck finds no active login, without ever prompting', async () => {
    // The recheck runs immediately before the prompt on EVERY run. If the
    // operator signed out since the last status view, the run must stop here.
    vi.mocked(resolveDispatchEvidence).mockResolvedValue(okEvidence());
    const child = fakeChild();
    vi.mocked(spawnAcpProcess).mockReturnValue(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'unauthenticated' });

    const result = await verifier.run('run-11', { toolUseId: 'tu1' }, (e) => events.push(e));

    expect(result.verdict).toBe('inconclusive');
    expect(events.some((e) => e.kind === 'error' && e.code === 'BILLING_MODE_BLOCKED')).toBe(true);
    const methods = child.received.map((r) => r.method);
    expect(methods).not.toContain('session/new');
    expect(methods).not.toContain('session/prompt');
  });

  it('fails the run closed when chat-gpt is not an offered auth method, without querying status or prompting', async () => {
    vi.mocked(resolveDispatchEvidence).mockResolvedValue(okEvidence());
    const child = fakeChild();
    vi.mocked(spawnAcpProcess).mockReturnValue(child as never);
    respondTo(child, { protocolVersion: 1, authMethods: [{ id: 'api-key', name: 'API Key' }] });

    const result = await verifier.run('run-12', { toolUseId: 'tu1' }, (e) => events.push(e));

    expect(result.verdict).toBe('inconclusive');
    expect(events.some((e) => e.kind === 'error' && e.code === 'BILLING_MODE_BLOCKED')).toBe(true);
    expect(child.received.map((r) => r.method)).toEqual(['initialize']);
  });

  it('never sends authenticate during a run -- a verification must not open a browser login', async () => {
    vi.mocked(resolveDispatchEvidence).mockResolvedValue(okEvidence());
    const child = fakeChild();
    vi.mocked(spawnAcpProcess).mockReturnValue(child as never);
    const raw = { schemaVersion: 1, verdict: 'supported', confidence: 0.8, summary: 'matches', findings: [], tests: [], limitations: [] };
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'chat-gpt' });
    respondTo(child, { sessionId: 'sess-auth' });
    respondToPromptWithMessage(child, 'sess-auth', JSON.stringify(raw));

    await verifier.run('run-13', { toolUseId: 'tu1' }, (e) => events.push(e));

    expect(child.received.map((r) => r.method)).toEqual([
      'initialize',
      'authentication/status',
      'session/new',
      'session/prompt',
    ]);
  });

  it('sends the required protocolVersion on the run initialize', async () => {
    vi.mocked(resolveDispatchEvidence).mockResolvedValue(okEvidence());
    const child = fakeChild();
    vi.mocked(spawnAcpProcess).mockReturnValue(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'unauthenticated' });

    await verifier.run('run-14', { toolUseId: 'tu1' }, (e) => events.push(e));

    expect(child.received[0].params).toEqual({ protocolVersion: 1 });
  });

  it('returns a validated result on a well-formed Codex response', async () => {
    vi.mocked(resolveDispatchEvidence).mockResolvedValue(okEvidence());
    const child = fakeChild();
    vi.mocked(spawnAcpProcess).mockReturnValue(child as never);
    const raw = { schemaVersion: 1, verdict: 'supported', confidence: 0.8, summary: 'matches', findings: [{ severity: 'info', claim: 'did the thing', evidence: 'saw it in the diff', file: null, line: null }], tests: [], limitations: [] };
    respondTo(child, REAL_INITIALIZE_RESULT); // initialize
    respondTo(child, { type: 'chat-gpt' }); // authentication/status
    respondTo(child, { sessionId: 'sess-1' }); // session/new
    respondToPromptWithMessage(child, 'sess-1', JSON.stringify(raw)); // session/prompt

    const result = await verifier.run('run-4', { toolUseId: 'tu1' }, (e) => events.push(e));

    expect(result).toEqual(raw);
    expect(events.some((e) => e.kind === 'result')).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('cleans up the snapshot and client on timeout', async () => {
    vi.useFakeTimers();
    vi.mocked(resolveDispatchEvidence).mockResolvedValue(okEvidence());
    const child = fakeChild();
    vi.mocked(spawnAcpProcess).mockReturnValue(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'chat-gpt' });
    respondTo(child, { sessionId: 'sess-2' }); // session/new
    // No responder queued for session/prompt -- it never resolves.

    const runPromise = verifier.run('run-5', { toolUseId: 'tu1' }, (e) => events.push(e));
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);

    // CodexVerifier catches the race's timeout and converts it into a
    // structured inconclusive result, same shape as the other failure paths.
    const result = await runPromise;
    expect(result.verdict).toBe('inconclusive');
    expect(events.some((e) => e.kind === 'error' && e.code === 'VERIFICATION_TIMEOUT')).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('cleans up on cancellation', async () => {
    vi.mocked(resolveDispatchEvidence).mockResolvedValue(okEvidence());
    const child = fakeChild();
    vi.mocked(spawnAcpProcess).mockReturnValue(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'chat-gpt' });
    respondTo(child, { sessionId: 'sess-3' });
    // No responder for session/prompt -- cancel() disposes the client while
    // that call is outstanding, which should reject it and unwind run().

    const runPromise = verifier.run('run-6', { toolUseId: 'tu1' }, (e) => events.push(e));
    await vi.waitFor(() => expect(child._responders.length).toBe(0));
    await verifier.cancel('run-6');

    // cancel() disposes the client, which rejects the outstanding prompt
    // call; that rejection is now caught and converted into a structured
    // inconclusive result rather than propagating.
    const result = await runPromise;
    expect(result.verdict).toBe('inconclusive');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('cleans up on a child process crash mid-run', async () => {
    // AcpClient has no dedicated crash listener -- a crashed child simply
    // stops producing stdout data, so the outstanding session/prompt call
    // never resolves and the run's own timeout is what unwinds cleanup.
    vi.useFakeTimers();
    vi.mocked(resolveDispatchEvidence).mockResolvedValue(okEvidence());
    const child = fakeChild();
    vi.mocked(spawnAcpProcess).mockReturnValue(child as never);
    respondTo(child, REAL_INITIALIZE_RESULT);
    respondTo(child, { type: 'chat-gpt' });
    respondTo(child, { sessionId: 'sess-4' });
    // session/prompt is never answered -- simulates the child having crashed.

    const runPromise = verifier.run('run-7', { toolUseId: 'tu1' }, (e) => events.push(e));
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);

    const result = await runPromise;
    expect(result.verdict).toBe('inconclusive');
    expect(events.some((e) => e.kind === 'error' && e.code === 'VERIFICATION_TIMEOUT')).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation requested while evidence is still being resolved, before any client connects', async () => {
    // resolveDispatchEvidence never resolves until we say so -- cancel()
    // must land and be honored without spawnAcpProcess/client.connect()
    // ever having been reached.
    let resolveEvidence!: (r: EvidenceResult) => void;
    vi.mocked(resolveDispatchEvidence).mockReturnValue(new Promise((res) => { resolveEvidence = res; }));

    const runPromise = verifier.run('run-9', { toolUseId: 'tu1' }, (e) => events.push(e));
    await verifier.cancel('run-9');
    resolveEvidence(okEvidence());

    const result = await runPromise;
    expect(result.verdict).toBe('inconclusive');
    expect(events.some((e) => e.kind === 'cancelled' && e.runId === 'run-9')).toBe(true);
    expect(spawnAcpProcess).not.toHaveBeenCalled();
  });

  it('honors cancellation requested while the snapshot is being built, before authentication', async () => {
    vi.mocked(resolveDispatchEvidence).mockResolvedValue(okEvidence());
    let resolveSnapshot!: (s: VerificationSnapshot) => void;
    vi.mocked(buildVerificationSnapshot).mockReturnValue(new Promise((res) => { resolveSnapshot = res; }));

    const runPromise = verifier.run('run-10', { toolUseId: 'tu1' }, (e) => events.push(e));
    // Wait for run() to have actually entered buildVerificationSnapshot()
    // before cancelling -- otherwise cancel() can win the race and be
    // observed at the earlier (evidence) checkpoint instead of this one.
    await vi.waitFor(() => expect(buildVerificationSnapshot).toHaveBeenCalled());
    await verifier.cancel('run-10');
    resolveSnapshot({ snapshotDir: 'C:/tmp/snap2', dispose } as VerificationSnapshot);

    const result = await runPromise;
    expect(result.verdict).toBe('inconclusive');
    expect(events.some((e) => e.kind === 'cancelled' && e.runId === 'run-10')).toBe(true);
    // dispose() is idempotent by design (see snapshotBuilder.ts) -- run()'s
    // finally block always disposes too, so this can be 1 or 2 calls
    // depending on timing; what matters is that it happened at all.
    expect(dispose).toHaveBeenCalled();
    expect(spawnAcpProcess).not.toHaveBeenCalled();
  });

  it('rejects a second concurrent run while one is active', async () => {
    vi.mocked(resolveDispatchEvidence).mockResolvedValue(okEvidence());
    const child = fakeChild();
    vi.mocked(spawnAcpProcess).mockReturnValue(child as never);
    // No responders queued at all -- the first run stalls at 'initialize'.

    const firstRun = verifier.run('run-8a', { toolUseId: 'tu1' }, (e) => events.push(e));
    await expect(verifier.run('run-8b', { toolUseId: 'tu1' }, (e) => events.push(e))).rejects.toThrow('a verification run is already in progress');

    await verifier.cancel('run-8a');
    await expect(firstRun).rejects.toThrow();
  });
});
