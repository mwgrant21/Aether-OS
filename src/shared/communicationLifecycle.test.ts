import { describe, expect, it } from 'vitest';
import {
  acceptCommunicationAsk, advanceCommunicationProvider, beginCommunicationSubmission,
  cancelCommunication, communicationCredits, communicationError, communicationStatus,
  confirmCommunicationCleanup, confirmCommunicationSubmission, createCommunicationLaunch,
  defineCommunicationPages, expireActiveCommunication, expireCommunicationContent,
  finishCommunication, failCommunicationCleanup, grantCommunicationCredits, lookupCommunication, observeCommunicationOutput,
  recordCommunicationPageServed, rejectCommunicationAsk, releaseUnsubmittedCommunication,
  renewCommunicationLease, setCommunicationClientConnected, validateAskCodex,
} from './communicationLifecycle';
import { COMMUNICATION_LIMITS as LIMITS } from './communicationTypes';
import type { CommunicationLaunch } from './communicationTypes';

const fresh = () => createCommunicationLaunch('launch-1');
function ask(state = fresh(), key = 'key-1', fingerprint = 'digest-1', now = 0, id = 'exchange-1') {
  return acceptCommunicationAsk(state, { request_key: key, question: 'Supplied question' },
    { exchangeId: id, fingerprint, now, gate: null, capacity: null });
}
const exchange = (state: CommunicationLaunch, id = 'exchange-1') => lookupCommunication(state, { exchange_id: id })!;
function completed(state = ask().state, id = 'exchange-1', now = 10): CommunicationLaunch {
  return finishCommunication(confirmCommunicationSubmission(beginCommunicationSubmission(state, id), id), id, now, { outcome: 'finished' });
}

describe('communication admission and launch accounting', () => {
  it('reserves atomically without recording input text in launch state or metadata', () => {
    const original = fresh();
    const accepted = ask(original);
    expect(accepted.error).toBeNull();
    expect(communicationCredits(accepted.state)).toEqual({ granted: 3, reserved: 1, consumed: 0, remaining: 2 });
    expect(original.exchanges).toEqual([]);
    expect(JSON.stringify(accepted.state)).not.toContain('Supplied question');
    expect(JSON.stringify(exchange(accepted.state).metadata)).not.toContain('digest-1');
    expect(JSON.stringify(exchange(accepted.state).metadata)).not.toContain('key-1');
    expect(JSON.parse(JSON.stringify(accepted.state))).toEqual(accepted.state);
  });
  it('recovers a lost acknowledgement and aliases identical payloads without a second start', () => {
    const initial = ask().state;
    const retry = ask(initial);
    const alias = ask(retry.state, 'alias');
    expect(retry.duplicate).toBe(true);
    expect(alias.exchangeId).toBe('exchange-1');
    expect(alias.duplicate).toBe(true);
    expect(alias.state.exchanges).toHaveLength(1);
    expect(lookupCommunication(alias.state, { request_key: 'alias' })).toEqual(exchange(alias.state));
    expect(communicationCredits(alias.state).reserved).toBe(1);
  });
  it('bounds alias growth so repeated keys for one payload cannot exhaust memory', () => {
    let state = ask().state;
    for (let i = 0; i < LIMITS.requestKeyAliases + 50; i++) {
      const retry = ask(state, `alias-${i}`);
      expect(retry.duplicate).toBe(true);
      expect(retry.error).toBeNull();
      expect(retry.exchangeId).toBe('exchange-1');
      state = retry.state;
    }
    expect(exchange(state).requestKeys).toHaveLength(LIMITS.requestKeyAliases);
    expect(state.exchanges).toHaveLength(1);
    expect(communicationCredits(state).reserved).toBe(1);
    expect(state.cooldownUntil).toBe(0);
    const retained = exchange(state).requestKeys;
    expect(retained[0]).toBe('key-1');
    expect(lookupCommunication(state, { request_key: retained[retained.length - 1] })).toEqual(exchange(state));
    expect(lookupCommunication(state, { request_key: `alias-${LIMITS.requestKeyAliases + 49}` })).toBeUndefined();
  });
  it('rejects changed content under an existing key and preserves the original mapping', () => {
    const initial = ask().state;
    const changed = ask(initial, 'key-1', 'different');
    expect(changed.error).toBe('KEY_CONFLICT');
    expect(exchange(changed.state).fingerprint).toBe('digest-1');
    expect(communicationCredits(changed.state)).toEqual(communicationCredits(initial));
  });
  it('treats prototype-like identifiers as ordinary keys', () => {
    const accepted = ask(fresh(), '__proto__', 'constructor', 0, 'constructor');
    const duplicate = ask(accepted.state, 'toString', 'constructor');
    expect(duplicate.exchangeId).toBe('constructor');
    expect(lookupCommunication(duplicate.state, { request_key: '__proto__' })?.metadata.exchangeId).toBe('constructor');
    expect(lookupCommunication(duplicate.state, { request_key: 'valueOf' })).toBeUndefined();
  });
  it('rejects duplicate generated IDs for new content', () => {
    const state = confirmCommunicationCleanup(completed(), 'exchange-1');
    expect(ask(state, 'new', 'new', 20).error).toBe('INVALID_INPUT');
  });
  it('fan-out shares one slot and does not spend on rejections', () => {
    let state = ask().state;
    for (let i = 2; i <= 10; i++) {
      const result = ask(state, `key-${i}`, `digest-${i}`, i, `exchange-${i}`);
      expect(result.error).toBe(i === 2 ? 'BUSY' : 'COOLDOWN');
      state = result.state;
    }
    expect(state.exchanges).toHaveLength(1);
    expect(communicationCredits(state)).toEqual({ granted: 3, reserved: 1, consumed: 0, remaining: 2 });
  });
  it('recovers duplicates during exhaustion and cooldown, including expired content', () => {
    let state = fresh();
    for (let i = 1; i <= 3; i++) {
      state = ask(state, `key-${i}`, `digest-${i}`, i * 100, `exchange-${i}`).state;
      state = confirmCommunicationCleanup(completed(state, `exchange-${i}`, i * 100 + 10), `exchange-${i}`);
    }
    expect(communicationCredits(state).remaining).toBe(0);
    const rejected = ask(state, 'key-4', 'digest-4', 400, 'exchange-4');
    expect(rejected.error).toBe('BUDGET_EXHAUSTED');
    const recovered = ask(rejected.state, 'alias', 'digest-1', 401);
    expect(recovered.duplicate).toBe(true);
    expect(recovered.exchangeId).toBe('exchange-1');
    state = expireCommunicationContent(recovered.state, 700_000);
    expect(exchange(state).metadata.delivery.availability).toBe('expired');
    expect(ask(state).duplicate).toBe(true);
    expect(communicationCredits(state).consumed).toBe(3);
  });
  it('validates actual UTF-8 sizes and unknown fields with zero reservation', () => {
    expect(validateAskCodex({ request_key: 'k', question: 'é'.repeat(8192) })).toBeNull();
    expect(validateAskCodex({ request_key: 'k', question: 'é'.repeat(8193) })).toBe('INPUT_LIMIT');
    expect(validateAskCodex({ request_key: 'k', question: 'ok', context: '😀'.repeat(8193) })).toBe('INPUT_LIMIT');
    for (const bad of [null, [], { request_key: 'k', question: ' ' },
      { request_key: 'bad key', question: 'q' }, { request_key: 'k', question: 'q', file: 'private' }]) {
      expect(validateAskCodex(bad)).toBe('INVALID_INPUT');
    }
    const result = acceptCommunicationAsk(fresh(), { request_key: 'k', question: ' ' },
      { exchangeId: 'e', fingerprint: 'd', now: 0, gate: null, capacity: null });
    expect(result.error).toBe('INVALID_INPUT');
    expect(communicationCredits(result.state).remaining).toBe(3);
  });
  it.each(['DISABLED', 'NOT_CONNECTED', 'POLICY_BLOCKED'] as const)('enforces %s before duplicate access', gate => {
    const state = ask().state;
    const result = acceptCommunicationAsk(state, { request_key: 'key-1', question: 'q' },
      { exchangeId: 'e', fingerprint: 'digest-1', now: 10, gate, capacity: null });
    expect(result.error).toBe(gate);
    expect(communicationCredits(result.state)).toEqual(communicationCredits(state));
  });
  it.each(['BUSY', 'RETENTION_FULL'] as const)('respects app-level %s without spending', capacity => {
    const result = acceptCommunicationAsk(fresh(), { request_key: 'k', question: 'q' },
      { exchangeId: 'e', fingerprint: 'digest', now: 10, gate: null, capacity });
    expect(result.error).toBe(capacity);
    expect(result.state.exchanges).toEqual([]);
    expect(communicationCredits(result.state).remaining).toBe(3);
  });
  it('uncertain submission counts consumed and failure alone cannot refund it', () => {
    let state = beginCommunicationSubmission(ask().state, 'exchange-1');
    expect(communicationCredits(state)).toEqual({ granted: 3, reserved: 0, consumed: 1, remaining: 2 });
    state = finishCommunication(state, 'exchange-1', 100, { outcome: 'PROVIDER_FAILED' });
    state = confirmCommunicationCleanup(state, 'exchange-1');
    expect(communicationCredits(state).consumed).toBe(1);
    expect(beginCommunicationSubmission(state, 'exchange-1')).toEqual(state);
  });
  it('releases preparation reservations and uncertain submissions only on explicit non-submission proof', () => {
    for (const state of [ask().state, beginCommunicationSubmission(ask().state, 'exchange-1')]) {
      const released = releaseUnsubmittedCommunication(state, 'exchange-1', 'confirmed-not-submitted');
      expect(communicationCredits(released)).toEqual({ granted: 3, reserved: 0, consumed: 0, remaining: 3 });
      expect(releaseUnsubmittedCommunication(released, 'exchange-1', 'confirmed-not-submitted')).toEqual(released);
      expect(beginCommunicationSubmission(released, 'exchange-1')).toEqual(released);
    }
    const consumed = confirmCommunicationSubmission(beginCommunicationSubmission(ask().state, 'exchange-1'), 'exchange-1');
    expect(releaseUnsubmittedCommunication(consumed, 'exchange-1', 'confirmed-not-submitted')).toEqual(consumed);
  });
  it('grant increments exactly three, deduplicates confirmation and preserves cooldown/tombstones', () => {
    const state = rejectCommunicationAsk(expireCommunicationContent(completed(), 700_000), 'BUSY', 700_000);
    const granted = grantCommunicationCredits(state, 'confirmation-1');
    expect(granted.granted).toBe(6);
    expect(granted.exchanges).toEqual(state.exchanges);
    expect(granted.cooldownUntil).toBe(state.cooldownUntil);
    expect(grantCommunicationCredits(granted, 'confirmation-1')).toBe(granted);
    expect(grantCommunicationCredits(state, '')).toBe(state);
    const ceiling = { ...state, granted: Number.MAX_SAFE_INTEGER - 1 };
    expect(grantCommunicationCredits(ceiling, 'new')).toBe(ceiling);
  });
});

describe('communication outcomes and timing', () => {
  it('clears earlier busy cooldown on success and accepts an immediate distinct follow-up after cleanup', () => {
    let state = ask().state;
    state = ask(state, 'busy', 'busy', 1, 'busy').state;
    expect(state.cooldownUntil).toBe(30_001);
    state = completed(state, 'exchange-1', 2);
    expect(state.cooldownUntil).toBe(0);
    expect(communicationStatus(state, 'exchange-1', 3)?.next_eligible_at).toBe(3);
    expect(ask(state, 'next', 'next', 3, 'next').error).toBe('BUSY');
    state = confirmCommunicationCleanup(state, 'exchange-1');
    expect(ask(state, 'next', 'next', 3, 'next').error).toBeNull();
  });
  it('unsuccessful outcomes retain cooldown; COOLDOWN does not extend it', () => {
    const failed = finishCommunication(ask().state, 'exchange-1', 10, { outcome: 'PROVIDER_FAILED' });
    const rejected = ask(failed, 'next', 'next', 11, 'next');
    expect(rejected.error).toBe('COOLDOWN');
    expect(rejected.state.cooldownUntil).toBe(30_010);
    expect(communicationStatus(rejected.state, 'exchange-1', 12)?.next_eligible_at).toBe(30_010);
    expect(rejectCommunicationAsk(rejected.state, 'COOLDOWN', 20)).toBe(rejected.state);
  });
  it('READ_CAPACITY changes neither outcome nor budget or cooldown', () => {
    const state = ask().state;
    expect(rejectCommunicationAsk(state, 'READ_CAPACITY', 100)).toBe(state);
    expect(communicationError('READ_CAPACITY')).toEqual({ schemaVersion: 1, code: 'READ_CAPACITY',
      guidance: 'Stop this retrieval attempt. The operator can inspect the answer in Comms. Cancel remains available.' });
  });
  it('owner renewals cap at deadline; followers, UI and aborted returns do not renew', () => {
    let state = ask().state;
    for (const evidence of ['follower', 'ui', 'aborted'] as const) {
      expect(exchange(renewCommunicationLease(state, 'exchange-1', 40_000, evidence)).metadata.leaseExpiresAt).toBe(90_000);
    }
    for (const now of [60_000, 120_000, 180_000, 240_000]) {
      state = renewCommunicationLease(state, 'exchange-1', now, 'owner-pending-return');
    }
    expect(exchange(state).metadata.leaseExpiresAt).toBe(300_000);
    expect(exchange(state).metadata.deadlineAt).toBe(300_000);
    state = renewCommunicationLease(state, 'exchange-1', 300_000, 'owner-admitted');
    expect(exchange(state).cancellationReason).toBe('TIMEOUT');
  });
  it('lease expiry at its exact boundary wins over late success and cannot be renewed', () => {
    const state = beginCommunicationSubmission(ask().state, 'exchange-1');
    const late = finishCommunication(state, 'exchange-1', 90_000, { outcome: 'finished' });
    expect(exchange(late).metadata.failure).toBe('LEASE_EXPIRED');
    expect(exchange(late).metadata.providerState).toBe('failed');
    expect(renewCommunicationLease(late, 'exchange-1', 90_001, 'owner-admitted')).toEqual(late);
    expect(finishCommunication(late, 'exchange-1', 90_002, { outcome: 'finished' })).toEqual(late);
  });
  it('cancellation sticks before late completion and blocks submission/progress', () => {
    const cancelled = cancelCommunication(ask().state, 'exchange-1');
    expect(beginCommunicationSubmission(cancelled, 'exchange-1')).toEqual(cancelled);
    expect(observeCommunicationOutput(cancelled, 'exchange-1', 20, 10)).toEqual(cancelled);
    const finished = finishCommunication(cancelled, 'exchange-1', 20, { outcome: 'finished' });
    expect(exchange(finished).metadata.failure).toBe('CANCELLED');
    expect(exchange(finished).metadata.providerState).toBe('cancelled');
    expect(exchange(finished).cleanupConfirmed).toBe(false);
    expect(cancelCommunication(finished, 'exchange-1', 'TIMEOUT')).toEqual(finished);
  });
  it('completed answers survive stale lease callbacks, disconnect and retain their original expiry', () => {
    const state = completed();
    expect(expireActiveCommunication(state, 'exchange-1', 400_000)).toBe(state);
    const disconnected = setCommunicationClientConnected(state, false);
    expect(exchange(disconnected).metadata.delivery.clientConnected).toBe(false);
    expect(exchange(disconnected).metadata.delivery.availability).toBe('ready');
    expect(exchange(disconnected).metadata.contentExpiresAt).toBe(600_010);
    const retained = expireCommunicationContent(disconnected, 600_009);
    expect(exchange(retained).metadata.delivery.availability).toBe('ready');
    const expired = expireCommunicationContent(retained, 600_010);
    expect(exchange(expired).metadata.delivery.availability).toBe('expired');
    expect(exchange(expired).metadata.providerState).toBe('finished');
    expect(ask(expired).duplicate).toBe(true);
  });
  it('does not let cleanup alone release an active slot', () => {
    const active = ask().state;
    expect(confirmCommunicationCleanup(active, 'exchange-1')).toEqual(active);
    expect(ask(confirmCommunicationCleanup(active, 'exchange-1'), 'next', 'next', 1, 'next').error).toBe('BUSY');
  });
  it('reports cleanup failure separately without rewriting cancellation or releasing the slot', () => {
    const state = finishCommunication(cancelCommunication(ask().state, 'exchange-1'), 'exchange-1', 1, { outcome: 'CANCELLED' });
    const failedCleanup = failCommunicationCleanup(state, 'exchange-1');
    expect(communicationStatus(failedCleanup, 'exchange-1', 2)).toMatchObject({
      provider_state: 'cancelled', failure: 'CANCELLED', cleanup: 'failed',
    });
    expect(exchange(failedCleanup).cleanupConfirmed).toBe(false);
    const confirmed = confirmCommunicationCleanup(failedCleanup, 'exchange-1');
    expect(exchange(confirmed).metadata.cleanup).toBe('confirmed');
    expect(failCommunicationCleanup(confirmed, 'exchange-1')).toEqual(confirmed);
  });
  it('successful output proves uncertain submission and cannot be refunded', () => {
    const state = finishCommunication(beginCommunicationSubmission(ask().state, 'exchange-1'), 'exchange-1', 1, { outcome: 'finished' });
    expect(exchange(state).credit).toBe('consumed');
    expect(releaseUnsubmittedCommunication(state, 'exchange-1', 'confirmed-not-submitted')).toEqual(state);
    const streaming = observeCommunicationOutput(beginCommunicationSubmission(ask().state, 'exchange-1'), 'exchange-1', 1, 1);
    expect(releaseUnsubmittedCommunication(streaming, 'exchange-1', 'confirmed-not-submitted')).toEqual(streaming);
  });
  it('progress starts absent, records only observed deltas and never regresses phase', () => {
    let state = ask().state;
    expect(communicationStatus(state, 'exchange-1', 1000)).toMatchObject({
      elapsed_ms: 1000, remaining_deadline_ms: 299_000, observed_output_bytes: null, last_output_at: null,
    });
    expect(exchange(state).metadata.usage).toBeNull();
    state = advanceCommunicationProvider(state, 'exchange-1', 'preparing');
    state = observeCommunicationOutput(state, 'exchange-1', 8, 2000);
    state = observeCommunicationOutput(state, 'exchange-1', 5, 3000);
    expect(communicationStatus(state, 'exchange-1', 4000)).toMatchObject({
      provider_state: 'streaming', observed_output_bytes: 13, last_output_at: 3000,
    });
    expect(advanceCommunicationProvider(state, 'exchange-1', 'waiting')).toEqual(state);
    for (const bytes of [NaN, -1, Infinity, 0, 1.5]) expect(observeCommunicationOutput(state, 'exchange-1', bytes, 5000)).toEqual(state);
  });
  it('output limit cancels without recording a fabricated zero or accepting a late success', () => {
    const submitted = beginCommunicationSubmission(ask().state, 'exchange-1');
    const limited = observeCommunicationOutput(submitted, 'exchange-1', LIMITS.answerBytes + 1, 100);
    expect(exchange(limited).cancellationReason).toBe('OUTPUT_LIMIT');
    expect(exchange(limited).metadata.observedOutputBytes).toBe(LIMITS.answerBytes + 1);
    expect(exchange(limited).metadata.lastOutputAt).toBe(100);
    expect(releaseUnsubmittedCommunication(limited, 'exchange-1', 'confirmed-not-submitted')).toEqual(limited);
    expect(communicationCredits(limited).consumed).toBe(1);
    expect(exchange(finishCommunication(limited, 'exchange-1', 200, { outcome: 'finished' })).metadata.failure).toBe('OUTPUT_LIMIT');
  });
  it('does not invent a successful provider turn before submission', () => {
    const accepted = ask().state;
    expect(finishCommunication(accepted, 'exchange-1', 10, { outcome: 'finished' })).toEqual(accepted);
  });
  it('new launch cannot resolve old IDs or aliases', () => {
    expect(lookupCommunication(createCommunicationLaunch('launch-2'), { exchange_id: 'exchange-1' })).toBeUndefined();
    expect(lookupCommunication(createCommunicationLaunch('launch-2'), { request_key: 'key-1' })).toBeUndefined();
  });
});

describe('stable result access accounting', () => {
  it('provider finish is not page serving; unique pages and replays are independent', () => {
    let state = defineCommunicationPages(completed(), 'exchange-1', 'v1', ['opaque-a', 'opaque-b']);
    expect(exchange(state).metadata.delivery).toMatchObject({ availability: 'ready', uniquePagesServed: 0, totalPages: 2 });
    state = recordCommunicationPageServed(state, 'exchange-1', 'v1', 1);
    const replay = recordCommunicationPageServed(state, 'exchange-1', 'v1', 1);
    expect(replay).toEqual(state);
    expect(exchange(replay).metadata.delivery.uniquePagesServed).toBe(1);
    expect(recordCommunicationPageServed(state, 'exchange-1', 'wrong-version', 0)).toEqual(state);
    expect(recordCommunicationPageServed(state, 'exchange-1', 'v1', 2)).toEqual(state);
    state = recordCommunicationPageServed(state, 'exchange-1', 'v1', 0);
    expect(exchange(state).metadata.delivery.uniquePagesServed).toBe(2);
    expect(communicationCredits(state).consumed).toBe(1);
    expect(defineCommunicationPages(state, 'exchange-1', 'v2', ['new'])).toEqual(state);
  });
  it('does not serve unfinished, unsuccessful or expired answers', () => {
    const active = ask().state;
    expect(defineCommunicationPages(active, 'exchange-1', 'v1', ['a'])).toEqual(active);
    const failed = finishCommunication(active, 'exchange-1', 1, { outcome: 'PROVIDER_FAILED' });
    expect(defineCommunicationPages(failed, 'exchange-1', 'v1', ['a'])).toEqual(failed);
    const expired = expireCommunicationContent(defineCommunicationPages(completed(), 'exchange-1', 'v1', ['a']), 700_000);
    expect(recordCommunicationPageServed(expired, 'exchange-1', 'v1', 0)).toEqual(expired);
  });
  it('retains unknown usage as null and measured zero usage as zero', () => {
    expect(exchange(completed()).metadata.usage).toBeNull();
    const submitted = beginCommunicationSubmission(ask().state, 'exchange-1');
    const finished = finishCommunication(submitted, 'exchange-1', 10, { outcome: 'finished', usage: { inputTokens: null, outputTokens: 0 } });
    expect(exchange(finished).metadata.usage).toEqual({ inputTokens: null, outputTokens: 0 });
  });
});
