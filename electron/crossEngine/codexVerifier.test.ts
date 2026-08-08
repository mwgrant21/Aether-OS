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

type FakeChild = {
  stdout: PassThrough;
  stdin: PassThrough;
  kill: () => void;
  _responders: Array<(req: { id: number; method: string }) => void>;
};

function fakeChild(): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const emitter = new EventEmitter() as unknown as FakeChild;
  emitter.stdout = stdout;
  emitter.stdin = stdin;
  emitter.kill = vi.fn();
  emitter._responders = [];
  stdin.on('data', (data: Buffer) => {
    for (const line of data.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const req = JSON.parse(line) as { id: number; method: string };
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
    respondTo(child, {}); // initialize
    respondTo(child, {}); // authenticate
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
    respondTo(child, {});
    respondTo(child, {});
    respondTo(child, { type: 'api-key' });

    const result = await verifier.run('run-3', { toolUseId: 'tu1' }, (e) => events.push(e));

    expect(result.verdict).toBe('inconclusive');
    expect(events.some((e) => e.kind === 'error' && e.code === 'BILLING_MODE_BLOCKED')).toBe(true);
  });

  it('returns a validated result on a well-formed Codex response', async () => {
    vi.mocked(resolveDispatchEvidence).mockResolvedValue(okEvidence());
    const child = fakeChild();
    vi.mocked(spawnAcpProcess).mockReturnValue(child as never);
    const raw = { schemaVersion: 1, verdict: 'supported', confidence: 0.8, summary: 'matches', findings: [], tests: [], limitations: [] };
    respondTo(child, {}); // initialize
    respondTo(child, {}); // authenticate
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
    respondTo(child, {});
    respondTo(child, {});
    respondTo(child, { type: 'chat-gpt' });
    respondTo(child, { sessionId: 'sess-2' }); // session/new
    // No responder queued for session/prompt -- it never resolves.

    const runPromise = verifier.run('run-5', { toolUseId: 'tu1' }, (e) => events.push(e));
    runPromise.catch(() => {}); // avoid an unhandled-rejection warning before the assertion below attaches
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);

    // CodexVerifier does not catch the race's timeout into an inconclusive
    // result -- it propagates, same as any other prompt failure. Cleanup
    // still runs via the `finally` block.
    await expect(runPromise).rejects.toThrow('VERIFICATION_TIMEOUT');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('cleans up on cancellation', async () => {
    vi.mocked(resolveDispatchEvidence).mockResolvedValue(okEvidence());
    const child = fakeChild();
    vi.mocked(spawnAcpProcess).mockReturnValue(child as never);
    respondTo(child, {});
    respondTo(child, {});
    respondTo(child, { type: 'chat-gpt' });
    respondTo(child, { sessionId: 'sess-3' });
    // No responder for session/prompt -- cancel() disposes the client while
    // that call is outstanding, which should reject it and unwind run().

    const runPromise = verifier.run('run-6', { toolUseId: 'tu1' }, (e) => events.push(e));
    await vi.waitFor(() => expect(child._responders.length).toBe(0));
    await verifier.cancel('run-6');

    await expect(runPromise).rejects.toThrow();
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
    respondTo(child, {});
    respondTo(child, {});
    respondTo(child, { type: 'chat-gpt' });
    respondTo(child, { sessionId: 'sess-4' });
    // session/prompt is never answered -- simulates the child having crashed.

    const runPromise = verifier.run('run-7', { toolUseId: 'tu1' }, (e) => events.push(e));
    runPromise.catch(() => {});
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);

    await expect(runPromise).rejects.toThrow('VERIFICATION_TIMEOUT');
    expect(dispose).toHaveBeenCalledTimes(1);
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
