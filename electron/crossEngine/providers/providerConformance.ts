// Shared conformance suite every ProviderAdapter must pass.
//
// Test-only module: it imports vitest and is never imported by the Electron
// main bundle. Its job is to make "provider-neutral" a checked property
// rather than an aspiration -- the same suite runs against the fake, the
// legacy Codex ACP adapter, the Codex app-server adapter, and (for its
// not-implemented behaviour) the Claude stub.
//
// Adapters differ in what they SUPPORT, so the suite reads each adapter's own
// capabilities() and skips the cases that adapter declares it cannot do,
// rather than forcing every provider to fake a feature it lacks. A capability
// an adapter claims IS exercised -- claiming it is what opts you into the
// test.

import { describe, it, expect } from 'vitest';
import { ProviderError, type ProviderAdapter, type ProviderEvent, type TurnUsage } from './contract';

export interface ConformanceTarget {
  name: string;
  /** Fresh, not-yet-connected adapter per test. */
  create: () => ProviderAdapter | Promise<ProviderAdapter>;
  /** Adapters whose transport cannot be driven without a real provider
   *  (currently none) may skip the turn-level cases. */
  skipTurns?: boolean;
  /** False for an adapter that deliberately cannot connect. Its pre-connect
   *  lifecycle is still asserted in full, plus an explicit check that
   *  connect() rejects; the turn-level cases are skipped, since every one of
   *  them needs a live connection. */
  connectable?: boolean;
  /** Proves the DISJOINTNESS invariant, not merely the floor: for an adapter
   *  whose wire format nests buckets (Codex is the motivating case --
   *  `ThreadTokenUsage.last.inputTokens` INCLUDES `cachedInputTokens`),
   *  `create()` must return an adapter already wired to a fixture that
   *  reports a KNOWN NESTED raw payload -- the same fake `create()` normally
   *  builds is fine, provided its usage numbers are fixed and nested (see
   *  makeAppServerAdapter() below). `expected` is the exact post-subtraction
   *  `TurnUsage` that payload must produce. Adapters whose wire format is
   *  already disjoint (Claude) have nothing to prove here and may omit this
   *  field entirely; the shape/non-negativity case above still runs for
   *  them regardless. */
  rawUsageFixture?: {
    turnText: string;
    expected: TurnUsage;
  };
}

/** Asserts explicitly rather than via rejects.toMatchObject: matcher
 *  behaviour against Error subclasses varies, and a silently-passing
 *  assertion is exactly what this suite must not have. */
async function expectProviderError(fn: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected a ProviderError(' + code + '), but the call resolved').toBeInstanceOf(ProviderError);
  expect((caught as ProviderError).code).toBe(code);
}

export function runProviderConformance(target: ConformanceTarget): void {
  const connectable = target.connectable !== false;

  describe(`ProviderAdapter conformance: ${target.name}`, () => {
    if (!connectable) {
      it('rejects connect() rather than pretending to be usable', async () => {
        const adapter = await target.create();
        await expect(adapter.connect()).rejects.toBeInstanceOf(ProviderError);
      });
    }

    it('declares a stable, complete capability set', async () => {
      const adapter = await target.create();
      const a = adapter.capabilities();
      const b = adapter.capabilities();
      expect(a).toEqual(b);
      for (const key of [
        'resumableSessions',
        'streamingEvents',
        'permissionRequests',
        'usageReporting',
        'cancellation',
        'structuredOutputSchema',
      ] as const) {
        expect(typeof a[key]).toBe('boolean');
      }
    });

    it('exposes a provider id', async () => {
      const adapter = await target.create();
      expect(adapter.id).toBeTruthy();
    });

    it('rejects use before connect() with NOT_CONNECTED', async () => {
      const adapter = await target.create();
      await expectProviderError(() => adapter.health(), 'NOT_CONNECTED');
      await expectProviderError(() => adapter.newSession({ cwd: process.cwd() }), 'NOT_CONNECTED');
    });

    it('dispose() is idempotent and returns to the not-connected state', async () => {
      const adapter = await target.create();
      if (connectable) await adapter.connect();
      await adapter.dispose();
      await adapter.dispose();
      await expectProviderError(() => adapter.newSession({ cwd: process.cwd() }), 'NOT_CONNECTED');
    });

    it('cancel() on an unknown session is a no-op, not an error', async () => {
      const adapter = await target.create();
      if (connectable) await adapter.connect();
      await expect(adapter.cancel('no-such-session')).resolves.toBeUndefined();
      await adapter.dispose();
    });

    // Both flags gate the turn-level cases: every one of them calls
    // connect(), so an adapter that cannot connect must skip them regardless
    // of skipTurns. Previously only skipTurns was checked, so registering
    // { connectable: false } alone produced six failing tests rather than the
    // documented behaviour.
    if (target.skipTurns || !connectable) return;

    it('opens a session and returns a non-empty opaque id', async () => {
      const adapter = await target.create();
      await adapter.connect();
      const id = await adapter.newSession({ cwd: process.cwd() });
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      await adapter.dispose();
    });

    it('streams chunks and returns their concatenation as the turn text', async () => {
      const adapter = await target.create();
      if (!adapter.capabilities().streamingEvents) return;
      await adapter.connect();
      const sessionId = await adapter.newSession({ cwd: process.cwd() });
      const events: ProviderEvent[] = [];
      const result = await adapter.sendTurn({ sessionId, text: 'hello' }, (e) => events.push(e));
      const streamed = events
        .filter((e): e is Extract<ProviderEvent, { kind: 'message-chunk' }> => e.kind === 'message-chunk')
        .map((e) => e.text)
        .join('');
      expect(result.text).toBe(streamed);
      await adapter.dispose();
    });

    it('always denies permission requests -- no event may carry any other decision', async () => {
      const adapter = await target.create();
      if (!adapter.capabilities().permissionRequests) return;
      await adapter.connect();
      const sessionId = await adapter.newSession({ cwd: process.cwd() });
      const events: ProviderEvent[] = [];
      await adapter.sendTurn({ sessionId, text: 'please write a file' }, (e) => events.push(e));
      for (const e of events) {
        if (e.kind === 'permission-request') expect(e.decision).toBe('denied');
      }
      await adapter.dispose();
    });

    it('reports four disjoint, non-negative token buckets', async () => {
      const adapter = await target.create();
      if (!adapter.capabilities().usageReporting) return;
      await adapter.connect();
      const sessionId = await adapter.newSession({ cwd: process.cwd() });
      const result = await adapter.sendTurn({ sessionId, text: 'hello' }, () => {});
      // The buckets are DISJOINT by contract (see TurnUsage in contract.ts):
      // a provider that reports nested buckets must subtract before reporting.
      // A negative value is the signature of that subtraction done without a
      // floor -- the one failure mode the de-nesting itself can introduce.
      for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens'] as const) {
        expect(result.usage).toHaveProperty(key);
        const value = result.usage[key];
        expect(value === null || (Number.isFinite(value) && value >= 0)).toBe(true);
      }
      await adapter.dispose();
    });

    // The non-negativity case above cannot tell "correctly de-nested" apart
    // from "passed a nested total straight through" -- both are four
    // non-negative finite numbers. Only an adapter that supplies a fixture
    // with a KNOWN nested raw payload lets the suite assert the exact
    // de-nested result, which is what actually pins disjointness rather than
    // just the floor. Skipped, visibly, for an adapter that supplies none --
    // never silently passed.
    if (target.rawUsageFixture) {
      const { turnText, expected } = target.rawUsageFixture;
      it('de-nests a known nested raw usage payload to the exact expected buckets', async () => {
        const adapter = await target.create();
        await adapter.connect();
        const sessionId = await adapter.newSession({ cwd: process.cwd() });
        const result = await adapter.sendTurn({ sessionId, text: turnText }, () => {});
        expect(result.usage).toEqual(expected);
        await adapter.dispose();
      });
    } else {
      it.skip('de-nests a known nested raw usage payload to the exact expected buckets (no rawUsageFixture supplied)', () => {});
    }

    it('returns a valid stop reason rather than throwing on provider-side outcomes', async () => {
      const adapter = await target.create();
      await adapter.connect();
      const sessionId = await adapter.newSession({ cwd: process.cwd() });
      const result = await adapter.sendTurn({ sessionId, text: 'hello' }, () => {});
      expect(['completed', 'cancelled', 'refused', 'timeout', 'error']).toContain(result.stopReason);
      await adapter.dispose();
    });

    it('rejects a turn against an unknown session with UNKNOWN_SESSION', async () => {
      const adapter = await target.create();
      await adapter.connect();
      await expectProviderError(
        () => adapter.sendTurn({ sessionId: 'not-a-real-session', text: 'hi' }, () => {}),
        'UNKNOWN_SESSION'
      );
      await adapter.dispose();
    });
  });
}

/** Re-exported so adapter suites can build expectations without importing
 *  contract.ts separately. */
export { ProviderError };
