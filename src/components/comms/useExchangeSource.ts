import { useEffect, useRef, useState } from 'react';
import { COMMUNICATION_LIMITS as limits, type CommunicationMetadata, type CommunicationPayload } from '../../shared/communicationTypes';

function payloadCopy(value: unknown): CommunicationPayload | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as CommunicationPayload, bytes = (s: string) => new TextEncoder().encode(s).length;
  if (typeof p.question !== 'string' || typeof p.answer !== 'string' || (p.context !== undefined && typeof p.context !== 'string')
    || bytes(p.question) > limits.questionBytes || bytes(p.answer) > limits.answerBytes
    || (p.context !== undefined && bytes(p.context) > limits.contextBytes)) return null;
  return { question: p.question, answer: p.answer, ...(p.context !== undefined ? { context: p.context } : {}) };
}

/** Only this mounted view owns content. Reads never renew Claude's lease or serve a page. */
export function useExchangeSource(metadata: CommunicationMetadata | null) {
  const key = metadata ? `${metadata.launchId}/${metadata.exchangeId}` : null;
  const expires = metadata?.contentExpiresAt ?? null;
  const expired = metadata?.delivery.availability === 'expired' || (expires !== null && Date.now() >= expires);
  const [result, setResult] = useState<{ key: string | null; payload: CommunicationPayload | null; status: 'loading' | 'ready' | 'missing' | 'error' }>({ key: null, payload: null, status: 'missing' });
  const inFlight = useRef<Promise<unknown> | null>(null);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const valid = () => !stopped && (expires === null || Date.now() < expires);
    setResult({ key, payload: null, status: key && !expired ? 'loading' : 'missing' });
    if (!key || !metadata || expired) return;
    const id = metadata.exchangeId;
    async function pull() {
      // A late read from the previous selection still owns the sole slot.
      if (inFlight.current) await inFlight.current.catch(() => {});
      if (!valid()) return;
      const api = window.aetherElectron?.communication;
      if (!api) { setResult({ key, payload: null, status: 'error' }); return; }
      const operation = Promise.resolve().then(() => api.readPayload(id));
      inFlight.current = operation;
      try {
        const raw = await operation;
        if (valid()) {
          const payload = payloadCopy(raw);
          setResult({ key, payload, status: payload ? 'ready' : raw === undefined ? 'missing' : 'error' });
        }
      } catch { if (valid()) setResult({ key, payload: null, status: 'error' }); }
      finally {
        if (inFlight.current === operation) inFlight.current = null;
        if (valid()) timer = setTimeout(pull, 500);
      }
    }
    void pull();
    if (expires !== null) expiryTimer = setTimeout(() => {
      stopped = true; clearTimeout(timer); setResult({ key, payload: null, status: 'missing' });
    }, Math.max(0, expires - Date.now()));
    return () => { stopped = true; clearTimeout(timer); clearTimeout(expiryTimer); };
  }, [key, expires, expired]);
  if (!key || expired) return { payload: null, status: 'missing' as const };
  return result.key === key ? result : { payload: null, status: 'loading' as const };
}
