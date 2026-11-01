import { randomUUID } from 'node:crypto';
import { VOICE_REPLAY_BYTES } from '../../src/shared/voice/types';
import { createReplayBuffer } from '../remote/replayBuffer';
import type { ServerEvent } from './protocol';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ServerEventBody = DistributiveOmit<ServerEvent, 'sessionId' | 'turnId' | 'seq'>;

export type AfterResult = { ok: true; events: ServerEvent[] } | { ok: false; reason: 'gap' | 'ahead' };

export interface EventLog {
  readonly sessionId: string;
  readonly lastSeq: number;
  append(turnId: string | null, body: ServerEventBody): ServerEvent;
  after(lastSeq: number): AfterResult;
  clear(): void;
}

/** Stamps events with sessionId/seq and keeps the newest maxBytes for resume. Memory only. */
export function createEventLog(opts: { maxBytes?: number; newId?: () => string } = {}): EventLog {
  const sessionId = (opts.newId ?? randomUUID)();
  const buf = createReplayBuffer<ServerEvent>(opts.maxBytes ?? VOICE_REPLAY_BYTES);
  let lastSeq = 0;
  return {
    sessionId,
    get lastSeq() {
      return lastSeq;
    },
    append(turnId, body) {
      const e = { ...body, sessionId, turnId, seq: ++lastSeq } as ServerEvent;
      buf.push(e);
      return e;
    },
    after(n) {
      if (n > lastSeq) return { ok: false, reason: 'ahead' };
      if (n === lastSeq) return { ok: true, events: [] };
      // seqs are unique and increasing, so a full count means every seq in (n, lastSeq] is held.
      const events = buf.snapshot().filter((e) => e.seq > n);
      if (events.length !== lastSeq - n) return { ok: false, reason: 'gap' };
      return { ok: true, events };
    },
    clear() {
      buf.clear();
    },
  };
}
