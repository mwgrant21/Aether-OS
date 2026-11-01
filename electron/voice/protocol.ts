import type { VoiceSessionState } from '../../src/shared/voice/types';
import { VOICE_MAX_PAYLOAD, VOICE_TURN_TEXT_CAP } from '../../src/shared/voice/types';

export type ClientMessage =
  | { t: 'turn.start'; turnId: string; text: string; mode: 'voice' }
  | { t: 'turn.cancel'; turnId: string; spokenText: string }
  | { t: 'permission.reply'; id: string; approve: boolean }
  | { t: 'resume'; lastSeq: number; sessionId?: string };

export const ERROR_CODES = [
  'bad_message',
  'busy',
  'session_starting',
  'session_restarting',
  'session_down',
  'session_changed',
  'resume_gap',
  'turn_failed',
  'replaced',
] as const;
export type VoiceErrorCode = (typeof ERROR_CODES)[number];

interface EventBase {
  sessionId: string;
  turnId: string | null;
  seq: number;
}

export type ServerEvent =
  | (EventBase & { t: 'turn.started' })
  | (EventBase & { t: 'response.delta'; text: string })
  | (EventBase & { t: 'response.spoken_done' })
  | (EventBase & { t: 'response.display'; text: string })
  | (EventBase & {
      t: 'turn.completed';
      status: 'completed' | 'interrupted' | 'error' | 'lost';
      spokenText?: string;
    })
  | (EventBase & {
      t: 'status';
      kind: 'tool' | 'agent' | 'session' | 'memory';
      state: string;
    })
  | (EventBase & { t: 'permission.request'; id: string; summary: string })
  | (EventBase & { t: 'error'; code: VoiceErrorCode; retryable: boolean });

const TURN_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseObject(o: Record<string, unknown>): ClientMessage | null {
  switch (o.t) {
    case 'turn.start': {
      const { turnId, text, mode } = o;
      if (typeof turnId !== 'string' || !TURN_ID_RE.test(turnId)) return null;
      if (typeof text !== 'string' || text.length < 1 || text.length > VOICE_TURN_TEXT_CAP) return null;
      if (mode !== 'voice') return null;
      return { t: 'turn.start', turnId, text, mode };
    }
    case 'turn.cancel': {
      const { turnId, spokenText } = o;
      if (typeof turnId !== 'string' || !TURN_ID_RE.test(turnId)) return null;
      if (typeof spokenText !== 'string' || spokenText.length > 2000) return null;
      return { t: 'turn.cancel', turnId, spokenText };
    }
    case 'permission.reply': {
      const { id, approve } = o;
      if (typeof id !== 'string' || id.length < 1 || id.length > 64) return null;
      if (typeof approve !== 'boolean') return null;
      return { t: 'permission.reply', id, approve };
    }
    case 'resume': {
      const { lastSeq, sessionId } = o;
      if (typeof lastSeq !== 'number' || !Number.isSafeInteger(lastSeq) || lastSeq < 0) return null;
      if (sessionId === undefined) return { t: 'resume', lastSeq };
      if (typeof sessionId !== 'string') return null;
      return { t: 'resume', lastSeq, sessionId };
    }
    default:
      return null;
  }
}

/** Closed and total: returns one of the four client messages or null; never throws. */
export function parseClientMessage(text: string): ClientMessage | null {
  try {
    if (typeof text !== 'string' || text.length > VOICE_MAX_PAYLOAD) return null;
    const v: unknown = JSON.parse(text);
    return isObj(v) ? parseObject(v) : null;
  } catch {
    return null;
  }
}

export function encodeEvent(e: ServerEvent): string {
  return JSON.stringify(e);
}

export interface VoiceSocket {
  send(text: string): void;
  close(code: number): void;
  bufferedBytes(): number;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
}

export interface VoiceGatewayCore {
  sessionId(): string;
  state(): VoiceSessionState;
  handle(msg: ClientMessage): void;
  subscribe(listener: (e: ServerEvent) => void): () => void; // live events only
  replayAfter(
    lastSeq: number,
  ): { ok: true; events: ServerEvent[] } | { ok: false; reason: 'gap' | 'ahead' };
  stop(): Promise<void>;
}

export interface VoiceGatewayPort {
  attach(
    socket: VoiceSocket,
    identity: { ref: string },
  ): { close(reason: 'revoked' | 'disabled'): void };
}
