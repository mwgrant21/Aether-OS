import { COMMUNICATION_LIMITS as LIMITS } from './communicationTypes';
import type {
  AskCodexInput, CommunicationErrorCode, CommunicationErrorV1, CommunicationExchange,
  CommunicationFailure, CommunicationLaunch, CommunicationMetadata, CommunicationStatusV1,
  CommunicationUsage, ExchangeLookup, ProviderState,
} from './communicationTypes';

// Pure transitions: callers supply monotonic time, authenticated launch scope and a
// canonical content fingerprint. No timers, hashing, payload storage or IPC here.
export function createCommunicationLaunch(launchId: string): CommunicationLaunch {
  return { launchId, granted: LIMITS.initialCredits, grantConfirmations: [], cooldownUntil: 0, exchanges: [] };
}
export function communicationCredits(state: CommunicationLaunch) {
  const reserved = state.exchanges.filter(e => e.credit === 'reserved').length;
  const consumed = state.exchanges.filter(e => e.credit === 'consumed' || e.credit === 'uncertain').length;
  return { granted: state.granted, reserved, consumed, remaining: state.granted - reserved - consumed };
}
export function communicationError(code: CommunicationErrorCode): CommunicationErrorV1 {
  let guidance: string;
  switch (code) {
    case 'DISABLED': case 'NOT_CONNECTED': case 'AUTH_REQUIRED': case 'POLICY_BLOCKED':
      guidance = 'Do not retry. The operator must enable, connect, sign in, or resolve policy in Aether.'; break;
    case 'BUSY':
      guidance = 'Do not start or re-key another consultation. An exchange is already active. Only inspect an exchange you own.'; break;
    case 'READ_CAPACITY':
      guidance = 'Too many concurrent reads. Stop this retrieval attempt; do not retry, re-key, or start a replacement consultation. The operator can inspect the answer in Comms. Cancel remains available.'; break;
    case 'BUDGET_EXHAUSTED':
      guidance = 'Do not retry or delegate another attempt. Ask the operator to grant more consultations in Aether; a session restart is unnecessary.'; break;
    case 'COOLDOWN':
      guidance = 'Do not automatically retry or paraphrase the request. The operator may request a new consultation after the supplied deadline.'; break;
    case 'RETENTION_FULL':
      guidance = 'Do not retry automatically. Existing answers are retained; the operator can clear an answer or wait for normal expiry.'; break;
    case 'INVALID_INPUT': case 'INPUT_LIMIT': case 'KEY_CONFLICT':
      guidance = 'Do not automatically resubmit. Explain the rejected input to the operator.'; break;
    case 'ALIAS_LIMIT':
      guidance = 'Do not retry or create another alias. Retrieve using a previously accepted request_key or known exchange_id. The new key was not accepted.'; break;
    case 'UNKNOWN_EXCHANGE': case 'EXPIRED':
      guidance = 'No result can be recovered by this call. Do not recreate the consultation automatically.'; break;
    case 'CANCELLED': case 'LEASE_EXPIRED': case 'TIMEOUT': case 'OUTPUT_LIMIT': case 'PROVIDER_FAILED': case 'CLEANUP_FAILED':
      guidance = 'The consultation did not complete successfully. Do not retry; the operator must decide whether to start another.'; break;
    default: { const exhaustive: never = code; throw new Error(`Unknown communication code: ${exhaustive}`); }
  }
  return { schemaVersion: 1, code, guidance };
}
const identifier = /^[A-Za-z0-9_-]{1,64}$/;
const bytes = (value: string) => new TextEncoder().encode(value).length;
export function validateAskCodex(input: unknown): CommunicationErrorCode | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'INVALID_INPUT';
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(k => !['request_key', 'question', 'context'].includes(k))
    || typeof value.request_key !== 'string' || !identifier.test(value.request_key)
    || typeof value.question !== 'string' || !value.question.trim()
    || (value.context !== undefined && typeof value.context !== 'string')) return 'INVALID_INPUT';
  return bytes(value.question) > LIMITS.questionBytes
    || (typeof value.context === 'string' && bytes(value.context) > LIMITS.contextBytes) ? 'INPUT_LIMIT' : null;
}
export function lookupCommunication(state: CommunicationLaunch, lookup: ExchangeLookup): CommunicationExchange | undefined {
  return state.exchanges.find(e => lookup.exchange_id !== undefined
    ? e.metadata.exchangeId === lookup.exchange_id : e.requestKeys.includes(lookup.request_key));
}
function replace(state: CommunicationLaunch, exchange: CommunicationExchange): CommunicationLaunch {
  return { ...state, exchanges: state.exchanges.map(e => e.metadata.exchangeId === exchange.metadata.exchangeId ? exchange : e) };
}
export function rejectCommunicationAsk(state: CommunicationLaunch, code: CommunicationErrorCode, now: number): CommunicationLaunch {
  // Retrieval errors must not be passed through the ask rejection path.
  // INVALID_INPUT deliberately shares the anti-rephrasing cooldown, including a
  // human-requested follow-up in this launch; a malformed model call cannot bypass it.
  if (code === 'COOLDOWN' || code === 'READ_CAPACITY') return state;
  return { ...state, cooldownUntil: Math.max(state.cooldownUntil, now + LIMITS.cooldownMs) };
}
export interface CommunicationAdmission {
  readonly state: CommunicationLaunch;
  readonly exchangeId: string | null;
  readonly duplicate: boolean;
  readonly error: CommunicationErrorCode | null;
}
/** U3 establishes app-wide slot/memory availability before this atomic reservation.
 * Fingerprint must be generated from validated, canonical question/context by main.
 * The returned state is the sole next state; do not merge concurrent snapshots. */
export function acceptCommunicationAsk(state: CommunicationLaunch, input: AskCodexInput,
  prepared: { exchangeId: string; fingerprint: string; now: number; gate: 'DISABLED' | 'NOT_CONNECTED' | 'POLICY_BLOCKED' | null;
    capacity: 'BUSY' | 'RETENTION_FULL' | null }): CommunicationAdmission {
  const reject = (code: CommunicationErrorCode): CommunicationAdmission => ({
    state: rejectCommunicationAsk(state, code, prepared.now), exchangeId: null, duplicate: false, error: code,
  });
  const invalid = validateAskCodex(input);
  if (invalid) return reject(invalid);
  if (prepared.gate) return reject(prepared.gate);
  const keyed = state.exchanges.find(e => e.requestKeys.includes(input.request_key));
  if (keyed && keyed.fingerprint !== prepared.fingerprint) return reject('KEY_CONFLICT');
  const duplicate = keyed ?? state.exchanges.find(e => e.fingerprint === prepared.fingerprint);
  if (duplicate) {
    // Include the original key in the cap. Every successful alias must remain
    // recoverable by key if the acknowledgement carrying its exchange ID is lost.
    if (!keyed && duplicate.requestKeys.length >= LIMITS.requestKeyAliases) return reject('ALIAS_LIMIT');
    const next = keyed ? state : replace(state, { ...duplicate, requestKeys: [...duplicate.requestKeys, input.request_key] });
    return { state: next, exchangeId: duplicate.metadata.exchangeId, duplicate: true, error: null };
  }
  if (!identifier.test(prepared.exchangeId) || !prepared.fingerprint
    || state.exchanges.some(e => e.metadata.exchangeId === prepared.exchangeId)) return reject('INVALID_INPUT');
  if (prepared.now < state.cooldownUntil) return reject('COOLDOWN');
  if (state.exchanges.some(e => !e.cleanupConfirmed) || prepared.capacity === 'BUSY') return reject('BUSY');
  if (prepared.capacity) return reject(prepared.capacity);
  if (communicationCredits(state).remaining < 1) return reject('BUDGET_EXHAUSTED');
  const metadata: CommunicationMetadata = {
    launchId: state.launchId, exchangeId: prepared.exchangeId, providerState: 'accepted', failure: null, cleanup: 'pending',
    acceptedAt: prepared.now, deadlineAt: prepared.now + LIMITS.deadlineMs,
    leaseExpiresAt: prepared.now + LIMITS.leaseMs, finishedAt: null, contentExpiresAt: null,
    observedOutputBytes: null, lastOutputAt: null, usage: null,
    delivery: { availability: 'pending', uniquePagesServed: 0, totalPages: null, clientConnected: true },
  };
  return { state: { ...state, exchanges: [...state.exchanges, {
    metadata, fingerprint: prepared.fingerprint, requestKeys: [input.request_key], credit: 'reserved',
    cleanupConfirmed: false, cancellationReason: null, pageVersion: null, servedPageIndexes: [],
  }] }, exchangeId: prepared.exchangeId, duplicate: false, error: null };
}
/** Operator confirmation is authenticated in U6; never expose this as an MCP tool.
 * Replayed confirmations cannot grant twice. Arithmetic remains a safe integer. */
export function grantCommunicationCredits(state: CommunicationLaunch, confirmationId: string): CommunicationLaunch {
  if (!identifier.test(confirmationId) || state.grantConfirmations.includes(confirmationId)
    || !Number.isSafeInteger(state.granted + LIMITS.grantCredits)) return state;
  return { ...state, granted: state.granted + LIMITS.grantCredits,
    grantConfirmations: [...state.grantConfirmations, confirmationId] };
}
function terminal(e: CommunicationExchange): boolean { return e.metadata.finishedAt !== null; }
function patchExchange(state: CommunicationLaunch, id: string,
  update: (e: CommunicationExchange) => CommunicationExchange): CommunicationLaunch {
  const e = lookupCommunication(state, { exchange_id: id });
  return e ? replace(state, update(e)) : state;
}
/** Call immediately BEFORE invoking a provider turn; failures remain consumed unless
 * the provider can subsequently prove it never submitted that turn. U3 must first
 * apply expireActiveCommunication with the current clock before starting work. */
export function beginCommunicationSubmission(state: CommunicationLaunch, id: string): CommunicationLaunch {
  return patchExchange(state, id, e => terminal(e) || e.cancellationReason || e.credit !== 'reserved'
    ? e : { ...e, credit: 'uncertain' });
}
export function confirmCommunicationSubmission(state: CommunicationLaunch, id: string): CommunicationLaunch {
  return patchExchange(state, id, e => e.credit === 'uncertain' ? { ...e, credit: 'consumed' } : e);
}
export function releaseUnsubmittedCommunication(state: CommunicationLaunch, id: string,
  proof: 'confirmed-not-submitted'): CommunicationLaunch {
  return patchExchange(state, id, e => proof !== 'confirmed-not-submitted' || e.credit === 'consumed'
    || e.metadata.observedOutputBytes !== null
    ? e : { ...e, credit: 'released' });
}
export function advanceCommunicationProvider(state: CommunicationLaunch, id: string,
  phase: 'preparing' | 'waiting' | 'streaming'): CommunicationLaunch {
  const order = ['accepted', 'preparing', 'waiting', 'streaming'];
  return patchExchange(state, id, e => terminal(e) || e.cancellationReason
    || order.indexOf(phase) <= order.indexOf(e.metadata.providerState)
    ? e : { ...e, metadata: { ...e.metadata, providerState: phase } });
}
export function observeCommunicationOutput(state: CommunicationLaunch, id: string, deltaBytes: number,
  now: number): CommunicationLaunch {
  if (!Number.isSafeInteger(deltaBytes) || deltaBytes <= 0) return state;
  const checked = expireActiveCommunication(state, id, now);
  return patchExchange(checked, id, e => {
    if (terminal(e) || e.cancellationReason) return e;
    const count = (e.metadata.observedOutputBytes ?? 0) + deltaBytes;
    return count > LIMITS.answerBytes
      ? { ...e, cancellationReason: 'OUTPUT_LIMIT', metadata: { ...e.metadata, providerState: 'cancelling',
        observedOutputBytes: count, lastOutputAt: now } }
      : { ...e, metadata: { ...e.metadata, providerState: 'streaming', observedOutputBytes: count, lastOutputAt: now } };
  });
}
export function cancelCommunication(state: CommunicationLaunch, id: string,
  reason: CommunicationFailure = 'CANCELLED'): CommunicationLaunch {
  return patchExchange(state, id, e => terminal(e) || e.cancellationReason ? e
    : { ...e, cancellationReason: reason, metadata: { ...e.metadata, providerState: 'cancelling' } });
}
export function expireActiveCommunication(state: CommunicationLaunch, id: string, now: number): CommunicationLaunch {
  const e = lookupCommunication(state, { exchange_id: id });
  if (!e || terminal(e)) return state;
  if (now >= e.metadata.deadlineAt) return cancelCommunication(state, id, 'TIMEOUT');
  if (now >= e.metadata.leaseExpiresAt) return cancelCommunication(state, id, 'LEASE_EXPIRED');
  return state;
}
/** U3 decides which read owns the lease. Followers/UI/aborted returns pass no renewal. */
export function renewCommunicationLease(state: CommunicationLaunch, id: string, now: number,
  evidence: 'owner-admitted' | 'owner-pending-return' | 'follower' | 'aborted' | 'ui'): CommunicationLaunch {
  const checked = expireActiveCommunication(state, id, now);
  if (evidence !== 'owner-admitted' && evidence !== 'owner-pending-return') return checked;
  return patchExchange(checked, id, e => terminal(e) || e.cancellationReason ? e : {
    ...e, metadata: { ...e.metadata, leaseExpiresAt: Math.min(e.metadata.deadlineAt, now + LIMITS.leaseMs) },
  });
}
/** Provider outcome is sticky, but it does NOT release the app slot. U2/U3 must
 * separately confirm process-tree cleanup, even after successful completion. */
export function finishCommunication(state: CommunicationLaunch, id: string, now: number,
  result: { outcome: 'finished' | CommunicationFailure; usage?: CommunicationUsage }): CommunicationLaunch {
  let next = expireActiveCommunication(state, id, now);
  const e = lookupCommunication(next, { exchange_id: id });
  if (!e || terminal(e)) return next;
  const outcome = e.cancellationReason ?? result.outcome;
  // A success without a submitted turn is not an admissible provider callback.
  if (outcome === 'finished' && e.credit !== 'consumed' && e.credit !== 'uncertain') return next;
  const phase: ProviderState = outcome === 'finished' ? 'finished'
    : outcome === 'CANCELLED' ? 'cancelled' : outcome === 'TIMEOUT' ? 'timed-out' : 'failed';
  next = replace(next, { ...e, credit: outcome === 'finished' ? 'consumed' : e.credit,
    metadata: { ...e.metadata, providerState: phase,
    failure: outcome === 'finished' ? null : outcome, finishedAt: now, contentExpiresAt: now + LIMITS.retentionMs,
    usage: result.usage ?? null, delivery: { ...e.metadata.delivery,
      availability: outcome === 'finished' ? 'ready' : 'unavailable' } } });
  return { ...next, cooldownUntil: outcome === 'finished' ? 0 : Math.max(next.cooldownUntil, now + LIMITS.cooldownMs) };
}
export function confirmCommunicationCleanup(state: CommunicationLaunch, id: string): CommunicationLaunch {
  return patchExchange(state, id, e => terminal(e) ? { ...e, cleanupConfirmed: true,
    metadata: { ...e.metadata, cleanup: 'confirmed' } } : e);
}
/** Cleanup failure is independent of the sticky provider outcome. Keep the slot
 * occupied; a later actual process-tree exit may confirm cleanup. */
export function failCommunicationCleanup(state: CommunicationLaunch, id: string): CommunicationLaunch {
  return patchExchange(state, id, e => e.cleanupConfirmed ? e
    : { ...e, metadata: { ...e.metadata, cleanup: 'failed' } });
}
/** Stable page manifests are assembled/bounded in U3. Accounting accepts only that
 * immutable version and valid page indexes, never an arbitrary client cursor. */
export function defineCommunicationPages(state: CommunicationLaunch, id: string, version: string,
  cursors: readonly string[]): CommunicationLaunch {
  if (!version || !cursors.length || new Set(cursors).size !== cursors.length || cursors.some(c => !c)) return state;
  return patchExchange(state, id, e => e.metadata.providerState !== 'finished'
    || e.metadata.delivery.availability !== 'ready' || e.pageVersion !== null ? e : {
      ...e, pageVersion: version, servedPageIndexes: [],
      metadata: { ...e.metadata, delivery: { ...e.metadata.delivery, totalPages: cursors.length } },
    });
}
export function recordCommunicationPageServed(state: CommunicationLaunch, id: string,
  version: string, pageIndex: number): CommunicationLaunch {
  return patchExchange(state, id, e => {
    const total = e.metadata.delivery.totalPages;
    if (e.metadata.delivery.availability !== 'ready' || version !== e.pageVersion || total === null
      || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= total || e.servedPageIndexes.includes(pageIndex)) return e;
    const served = [...e.servedPageIndexes, pageIndex];
    return { ...e, servedPageIndexes: served,
      metadata: { ...e.metadata, delivery: { ...e.metadata.delivery, uniquePagesServed: served.length } } };
  });
}
/** Launch/helper transport connectivity, not an individual get waiter. All retained
 * exchanges in this launch share this transport regardless of the BUSY slot guard. */
export function setCommunicationClientConnected(state: CommunicationLaunch, connected: boolean): CommunicationLaunch {
  return { ...state, exchanges: state.exchanges.map(e => ({ ...e,
    metadata: { ...e.metadata, delivery: { ...e.metadata.delivery, clientConnected: connected } } })) };
}
/** U3 clears associated payloads when this transition expires availability.
 * Retained identities/fingerprints/credits remain usable for duplicate recovery. */
export function expireCommunicationContent(state: CommunicationLaunch, now: number): CommunicationLaunch {
  return { ...state, exchanges: state.exchanges.map(e => e.metadata.contentExpiresAt !== null
    && now >= e.metadata.contentExpiresAt ? { ...e, metadata: { ...e.metadata,
      delivery: { ...e.metadata.delivery, availability: 'expired' } } } : e) };
}
export function communicationStatus(state: CommunicationLaunch, id: string, now: number): CommunicationStatusV1 | null {
  const e = lookupCommunication(state, { exchange_id: id });
  if (!e) return null;
  return { schemaVersion: 1, exchange_id: id, provider_state: e.metadata.providerState,
    failure: e.metadata.failure, cleanup: e.metadata.cleanup, delivery: e.metadata.delivery,
    lease_expires_at: e.metadata.leaseExpiresAt, deadline_at: e.metadata.deadlineAt,
    elapsed_ms: Math.max(0, (e.metadata.finishedAt ?? now) - e.metadata.acceptedAt),
    remaining_deadline_ms: Math.max(0, e.metadata.deadlineAt - now),
    observed_output_bytes: e.metadata.observedOutputBytes, last_output_at: e.metadata.lastOutputAt,
    next_eligible_at: Math.max(now, state.cooldownUntil), remaining_credits: communicationCredits(state).remaining,
    credits: { granted: state.granted, reserved: communicationCredits(state).reserved,
      consumed: communicationCredits(state).consumed } };
}
