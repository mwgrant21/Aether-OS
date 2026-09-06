// @vitest-environment node
//
// Opt-in LIVE smoke tests. Skipped unless AETHER_LIVE_PROVIDER_SMOKE=1.
//
// Every other test in this directory drives an injected fake built from
// captured output, which is circular by construction: if a real event shape
// was misread, the fake encodes the same misreading and the suite still
// passes. These tests close that gap by talking to the real locally-installed
// CLIs -- and they are exactly why the default-spawn path went unexercised
// long enough to ship `spawn('codex', ...)`, which cannot work on Windows.
//
// Deliberately opt-in, per the broker plan: "real Claude/Codex smoke tests
// remain explicit local opt-in so CI contains no credentials." The Windows CI
// lane runs with this unset and therefore skips the whole file.
//
// TWO gates, because they cost differently:
//
//   AETHER_LIVE_PROVIDER_SMOKE=1  spends NO model tokens. Process spawning,
//                                 the protocol handshake, and read-only
//                                 auth/account probes only -- never a turn.
//   AETHER_LIVE_PROVIDER_TURN=1   spends a SMALL number of Codex tokens: one
//                                 trivial real turn, end to end.
//
// The turn gate is separate precisely so the cheap checks can run freely while
// the paid one stays deliberate. Neither is set in CI.
//
//   AETHER_LIVE_PROVIDER_SMOKE=1 npx vitest run electron/crossEngine/providers/providers.live.test.ts
//   AETHER_LIVE_PROVIDER_TURN=1  npx vitest run electron/crossEngine/providers/providers.live.test.ts

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderEvent } from './contract';
import { CodexAppServerAdapter } from './codexAppServer';
import { ClaudeHeadlessCliAdapter } from './claudeHeadlessCli';

const LIVE = process.env.AETHER_LIVE_PROVIDER_SMOKE === '1';
const describeLive = LIVE ? describe : describe.skip;

/** The app-server child holds its cwd open, and Windows refuses to unlink a
 *  directory a live process is sitting in -- so removal races the childs
 *  shutdown. A leftover temp directory is not a test failure, so this retries
 *  briefly and then gives up quietly rather than turning cleanup into a red
 *  test (which is exactly what it did on the first run). */
async function bestEffortRemove(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** Separately gated: this one costs money. */
const LIVE_TURN = process.env.AETHER_LIVE_PROVIDER_TURN === '1';
const describeLiveTurn = LIVE_TURN ? describe : describe.skip;

describeLive('LIVE: CodexAppServerAdapter against the real codex app-server', () => {
  it('connects over the default spawn path and reports health', async () => {
    const adapter = new CodexAppServerAdapter();
    try {
      // The default spawn path. Nothing else in this suite covers it, and it
      // is where `spawn('codex')` failed with ENOENT on Windows.
      await adapter.connect();
      const health = await adapter.health();
      // 'unknown' means the response SHAPE drifted, not that the machine is
      // logged out (that reads 'unauthenticated'). Asserting only membership
      // of the full enum let this pass vacuously while health() was reading a
      // field the protocol never had.
      expect(['subscription', 'api-key', 'gateway', 'unauthenticated']).toContain(health.authMode);
      expect(typeof health.ready).toBe('boolean');
    } finally {
      await adapter.dispose();
    }
  }, 60_000);

  it('opens and closes a read-only thread', async () => {
    const adapter = new CodexAppServerAdapter();
    try {
      await adapter.connect();
      const threadId = await adapter.newSession({ cwd: process.cwd() });
      expect(threadId).toMatch(/\S/);
      // Cancelling an idle thread must be a no-op, not an error.
      await expect(adapter.cancel(threadId)).resolves.toBeUndefined();
    } finally {
      await adapter.dispose();
    }
  }, 60_000);
});

describeLive('LIVE: ClaudeHeadlessCliAdapter against the real claude CLI', () => {
  it('classifies the real login state without spending tokens', async () => {
    const adapter = new ClaudeHeadlessCliAdapter();
    try {
      await adapter.connect();
      const health = await adapter.health();
      // Same reasoning as the Codex probe: 'unknown' means shape drift.
      expect(['subscription', 'api-key', 'gateway', 'unauthenticated']).toContain(health.authMode);
      expect(typeof health.ready).toBe('boolean');
      // The probe returns the operator's email and org id; neither may reach
      // ProviderHealth, which other layers may log or persist.
      const serialized = JSON.stringify(health);
      expect(serialized).not.toMatch(/@[\w.-]+\.\w+/);
    } finally {
      await adapter.dispose();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The gap every one of the seven review rounds lived in.
//
// `turn/completed` had never run against a real server. Each round's finding
// was in that region, and the reason is structural: the unit fakes encode the
// author's understanding of the protocol, so they can only catch deviations
// FROM that understanding, never a misunderstanding OF it. Round 2's inverted
// lifecycle -- treating `turn/start`'s response as the outcome -- would have
// been caught in seconds by one real turn. Instead it took a reviewer, and the
// fixes for it generated four more findings.
//
// One trivial turn is the cheapest possible way to close that. It exercises
// turn/start -> streamed deltas -> turn/completed end to end, which is
// precisely the sequence no fake can validate.
// ---------------------------------------------------------------------------

describeLiveTurn('LIVE TURN: the full turn lifecycle against a real codex app-server', () => {
  it('runs one real turn: accepted, streamed, completed', async () => {
    const adapter = new CodexAppServerAdapter();
    // A scratch directory rather than this repo: the turn should have nothing
    // interesting to read, which keeps it cheap and its output predictable.
    const cwd = mkdtempSync(join(tmpdir(), 'aether-live-turn-'));
    try {
      await adapter.connect();
      const threadId = await adapter.newSession({ cwd });

      const events: ProviderEvent[] = [];
      const result = await adapter.sendTurn(
        { sessionId: threadId, text: 'Reply with exactly: OK', timeoutMs: 120_000 },
        (e) => events.push(e)
      );

      // 1. The turn reached a real terminal status. Before the round-2 fix
      //    this was 'error' for every normal turn, because turn/start's
      //    "inProgress" acknowledgement was being read as the outcome.
      expect(result.stopReason).toBe('completed');

      // 2. Streamed content actually arrived and was accumulated. A lifecycle
      //    that returns at acknowledgement yields empty text even when the
      //    model answered.
      const chunks = events.filter((e) => e.kind === 'message-chunk');
      expect(chunks.length).toBeGreaterThan(0);
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.text).toContain('OK');

      // 3. Usage came from the provider, not from a default. This is the
      //    field the fakes had wrong for two rounds.
      expect(result.usage.inputTokens).not.toBeNull();
      expect(result.usage.outputTokens).not.toBeNull();
    } finally {
      await adapter.dispose();
      await bestEffortRemove(cwd);
    }
  }, 180_000);

  it('leaves no turn record behind after a real completed turn', async () => {
    // The restructure's invariant, checked against a real server rather than
    // a fake: a completed turn retires its record.
    const adapter = new CodexAppServerAdapter();
    const cwd = mkdtempSync(join(tmpdir(), 'aether-live-turn-'));
    try {
      await adapter.connect();
      const threadId = await adapter.newSession({ cwd });
      await adapter.sendTurn({ sessionId: threadId, text: 'Reply with exactly: OK', timeoutMs: 120_000 }, () => {});
      expect(adapter.liveTurnCount).toBe(0);
    } finally {
      await adapter.dispose();
      await bestEffortRemove(cwd);
    }
  }, 180_000);
});

