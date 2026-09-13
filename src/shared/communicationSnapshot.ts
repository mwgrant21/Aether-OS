import type { CommunicationBridgeSnapshot } from '../../electron/communicationBridge/mainIntegration';
import { projectCommunicationSessionStatus } from './communicationSessionStatus';
import type { CommunicationMetadata } from './communicationTypes';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const nullableCount = (value: unknown) => value === null || count(value);
export const communicationId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const cleanup = (value: unknown) => ['pending', 'confirmed', 'failed'].includes(value as string);

/** Copy only operational fields. TypeScript types do not strip extra IPC properties. */
export function projectCommunicationSnapshot(value: unknown): CommunicationBridgeSnapshot | null {
  if (!object(value) || typeof value.enabled !== 'boolean' || !cleanup(value.cleanup)
    || !['disabled', 'waiting', 'authenticated', 'ready', 'disconnected'].includes(value.readiness as string)
    || !Array.isArray(value.metadata) || value.metadata.length > 20) return null;
  const sessionStatus = projectCommunicationSessionStatus(value.sessionStatus);
  if (!sessionStatus) return null;
  const metadata: CommunicationMetadata[] = [], seen = new Set<string>();
  for (const raw of value.metadata) {
    if (!object(raw) || !communicationId(raw.exchangeId) || !communicationId(raw.launchId) || seen.has(raw.exchangeId)
      || !['accepted', 'preparing', 'waiting', 'streaming', 'cancelling', 'finished', 'cancelled', 'timed-out', 'failed'].includes(raw.providerState as string)
      || !(raw.failure === null || ['CANCELLED', 'LEASE_EXPIRED', 'TIMEOUT', 'OUTPUT_LIMIT', 'PROVIDER_FAILED', 'CLEANUP_FAILED'].includes(raw.failure as string))
      || !cleanup(raw.cleanup) || !count(raw.acceptedAt) || !count(raw.deadlineAt) || !count(raw.leaseExpiresAt)
      || !nullableCount(raw.finishedAt) || !nullableCount(raw.contentExpiresAt)
      || !nullableCount(raw.observedOutputBytes) || !nullableCount(raw.lastOutputAt)) return null;
    if (!(raw.usage === null || (object(raw.usage) && nullableCount(raw.usage.inputTokens) && nullableCount(raw.usage.outputTokens)))) return null;
    const delivery = raw.delivery;
    if (!object(delivery) || !['pending', 'ready', 'unavailable', 'expired'].includes(delivery.availability as string)
      || !count(delivery.uniquePagesServed) || !nullableCount(delivery.totalPages) || typeof delivery.clientConnected !== 'boolean'
      || (typeof delivery.totalPages === 'number' && delivery.uniquePagesServed > delivery.totalPages)) return null;
    const m = raw as unknown as CommunicationMetadata;
    seen.add(m.exchangeId);
    metadata.push({ launchId: m.launchId, exchangeId: m.exchangeId, providerState: m.providerState,
      failure: m.failure, cleanup: m.cleanup, acceptedAt: m.acceptedAt, deadlineAt: m.deadlineAt,
      leaseExpiresAt: m.leaseExpiresAt, finishedAt: m.finishedAt, contentExpiresAt: m.contentExpiresAt,
      observedOutputBytes: m.observedOutputBytes, lastOutputAt: m.lastOutputAt,
      usage: m.usage === null ? null : { inputTokens: m.usage.inputTokens, outputTokens: m.usage.outputTokens },
      delivery: { availability: m.delivery.availability, uniquePagesServed: m.delivery.uniquePagesServed,
        totalPages: m.delivery.totalPages, clientConnected: m.delivery.clientConnected } });
  }
  const snapshot = value as unknown as CommunicationBridgeSnapshot;
  return { sessionStatus, enabled: snapshot.enabled, readiness: snapshot.readiness, cleanup: snapshot.cleanup, metadata,
    ...(count(snapshot.remainingCredits) ? { remainingCredits: snapshot.remainingCredits } : {}) };
}

const errors = new Set(['SHUTTING_DOWN', 'DISPOSED', 'CLEANUP_FAILED', 'SHUTDOWN_TIMEOUT',
  'Communication is available in the desktop app.', 'Could not read communication status.',
  'Could not synchronize communication preference.']);
export function safeCommunicationError(value: unknown): string | null {
  return value === null ? null : typeof value === 'string' && errors.has(value)
    ? value : 'Could not synchronize communication preference.';
}
