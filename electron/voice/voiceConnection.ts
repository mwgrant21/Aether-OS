import {
  encodeEvent,
  parseClientMessage,
  type ServerEvent,
  type VoiceErrorCode,
  type VoiceGatewayCore,
  type VoiceGatewayPort,
  type VoiceSocket,
} from './protocol';

export interface VoiceConnectionDeps {
  gateway: VoiceGatewayCore;
  log?: (line: string) => void;
  slowConsumerBytes?: number;
}

export type VoiceConnections = VoiceGatewayPort & {
  count(): number;
  closeAll(reason: 'revoked' | 'disabled'): void;
};

const DEFAULT_SLOW_BYTES = 1024 * 1024;
const CLOSE_BAD_MESSAGE = 1008;
const CLOSE_SLOW = 1013;
const CLOSE_REPLACED = 4000;
const CLOSE_CODE = { disabled: 1001, revoked: 4001 } as const;

interface Conn {
  socket: VoiceSocket;
  ref: string;
  unsub: (() => void) | null;
  closed: boolean;
}

export function createVoiceConnections(deps: VoiceConnectionDeps): VoiceConnections {
  const { gateway } = deps;
  const log = deps.log ?? (() => {});
  const slowBytes = deps.slowConsumerBytes ?? DEFAULT_SLOW_BYTES;
  let current: Conn | null = null;
  // Best-effort in-flight turn: set by turn.start we forward or turn.started we deliver,
  // cleared by a matching turn.completed. Used only to drop a turn lost to a resume gap;
  // a stale value is harmless because the gateway ignores a cancel for a finished turn.
  let inflight: string | null = null;

  function noteEvent(e: ServerEvent): void {
    if (e.t === 'turn.started' && e.turnId) inflight = e.turnId;
    else if (e.t === 'turn.completed' && e.turnId === inflight) inflight = null;
  }

  function teardown(c: Conn): void {
    if (c.closed) return;
    c.closed = true;
    if (c.unsub) {
      c.unsub();
      c.unsub = null;
    }
    if (current === c) current = null;
    log(`voice: connection closed ref=${c.ref}`);
  }

  function closeWith(c: Conn, code: number): void {
    if (c.closed) return;
    teardown(c);
    c.socket.close(code);
  }

  /** Send one text frame unless the consumer is too slow (then close 1013). */
  function push(c: Conn, text: string): boolean {
    if (c.closed) return false;
    if (c.socket.bufferedBytes() > slowBytes) {
      log(`voice: slow consumer ref=${c.ref}`);
      closeWith(c, CLOSE_SLOW);
      return false;
    }
    c.socket.send(text);
    return true;
  }

  function direct(c: Conn, body: { t: 'status'; kind: 'session'; state: string } | { t: 'error'; code: VoiceErrorCode; retryable: boolean }): boolean {
    // Direct frames sit outside the sequence (seq 0) and are never logged or replayed.
    return push(c, JSON.stringify({ ...body, sessionId: gateway.sessionId(), turnId: null, seq: 0 }));
  }

  function live(c: Conn): void {
    c.unsub = gateway.subscribe((e) => {
      noteEvent(e);
      push(c, encodeEvent(e));
    });
  }

  function resume(c: Conn, lastSeq: number, sessionId: string | undefined): void {
    if (sessionId !== undefined && sessionId !== gateway.sessionId()) {
      direct(c, { t: 'error', code: 'session_changed', retryable: false });
      return;
    }
    // Detach live delivery, replay, then reattach in one synchronous step so each event
    // reaches the socket exactly once: either in the replay or live, never both, never neither.
    if (c.unsub) {
      c.unsub();
      c.unsub = null;
    }
    const r = gateway.replayAfter(lastSeq);
    if (r.ok) {
      for (const e of r.events) {
        noteEvent(e);
        if (!push(c, encodeEvent(e))) return;
      }
    } else if (r.reason === 'gap') {
      direct(c, { t: 'error', code: 'resume_gap', retryable: true });
      if (inflight) {
        const turnId = inflight;
        inflight = null;
        gateway.handle({ t: 'turn.cancel', turnId, spokenText: '' });
      }
    } else {
      direct(c, { t: 'error', code: 'bad_message', retryable: false });
    }
    if (!c.closed) live(c);
  }

  function onMessage(c: Conn, text: string): void {
    if (c.closed) return;
    const msg = parseClientMessage(text);
    if (!msg) {
      log(`voice: bad message ref=${c.ref}`);
      direct(c, { t: 'error', code: 'bad_message', retryable: false });
      closeWith(c, CLOSE_BAD_MESSAGE);
      return;
    }
    if (msg.t === 'resume') {
      resume(c, msg.lastSeq, msg.sessionId);
      return;
    }
    if (msg.t === 'turn.start') inflight = msg.turnId;
    gateway.handle(msg);
  }

  function attach(socket: VoiceSocket, identity: { ref: string }) {
    if (current) {
      const old = current;
      direct(old, { t: 'error', code: 'replaced', retryable: false });
      log(`voice: connection replaced ref=${old.ref}`);
      closeWith(old, CLOSE_REPLACED);
    }
    const c: Conn = { socket, ref: identity.ref, unsub: null, closed: false };
    current = c;
    log(`voice: connection attached ref=${c.ref}`);
    direct(c, { t: 'status', kind: 'session', state: gateway.state() });
    if (!c.closed) live(c);
    socket.onMessage((text) => onMessage(c, text));
    socket.onClose(() => teardown(c));
    return {
      close(reason: 'revoked' | 'disabled'): void {
        closeWith(c, CLOSE_CODE[reason]);
      },
    };
  }

  return {
    attach,
    count: () => (current ? 1 : 0),
    closeAll(reason) {
      if (current) closeWith(current, CLOSE_CODE[reason]);
    },
  };
}
