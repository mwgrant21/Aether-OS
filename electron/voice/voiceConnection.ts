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
  held: boolean;
  buf: ServerEvent[];
  bufBytes: number;
  maxSent: number;
}

export function createVoiceConnections(deps: VoiceConnectionDeps): VoiceConnections {
  const { gateway } = deps;
  const log = deps.log ?? (() => {});
  const slowBytes = deps.slowConsumerBytes ?? DEFAULT_SLOW_BYTES;
  let current: Conn | null = null;
  // Best-effort in-flight turn: set by turn.started events seen from the gateway,
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

  /** Send a sequenced event once: anything at or below the high-water mark was already delivered. */
  function deliver(c: Conn, e: ServerEvent): void {
    if (e.seq <= c.maxSent) return;
    if (push(c, encodeEvent(e))) c.maxSent = e.seq;
  }

  /** Stop holding: flush what was buffered while held (in order), then deliver live. */
  function release(c: Conn): void {
    c.held = false;
    const buf = c.buf;
    c.buf = [];
    c.bufBytes = 0;
    for (const e of buf) deliver(c, e);
  }

  // Live events are held from attach until the first inbound frame is handled, so the
  // client's first resume (replay of everything logged) cannot double-deliver or reorder them.
  function startLive(c: Conn): void {
    c.unsub = gateway.subscribe((e) => {
      noteEvent(e);
      if (c.closed) return;
      if (!c.held) {
        deliver(c, e);
        return;
      }
      c.buf.push(e);
      c.bufBytes += encodeEvent(e).length;
      if (c.bufBytes > slowBytes) {
        log(`voice: slow consumer ref=${c.ref}`);
        closeWith(c, CLOSE_SLOW);
      }
    });
  }

  function resume(c: Conn, lastSeq: number, sessionId: string | undefined): void {
    if (sessionId !== undefined && sessionId !== gateway.sessionId()) {
      direct(c, { t: 'error', code: 'session_changed', retryable: false });
      release(c);
      return;
    }
    // Hold live delivery, replay, release in one synchronous step. The replay is
    // authoritative for everything logged so far, so the held buffer is dropped when it ok;
    // maxSent keeps a stale second resume from re-sending what this socket already has.
    c.held = true;
    const r = gateway.replayAfter(lastSeq);
    if (r.ok) {
      c.buf = [];
      c.bufBytes = 0;
      for (const e of r.events) {
        noteEvent(e);
        deliver(c, e);
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
    if (!c.closed) release(c);
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
    gateway.handle(msg);
    if (c.held && !c.closed) release(c);
  }

  function attach(socket: VoiceSocket, identity: { ref: string }) {
    if (current) {
      const old = current;
      direct(old, { t: 'error', code: 'replaced', retryable: false });
      log(`voice: connection replaced ref=${old.ref}`);
      closeWith(old, CLOSE_REPLACED);
    }
    const c: Conn = { socket, ref: identity.ref, unsub: null, closed: false, held: true, buf: [], bufBytes: 0, maxSent: 0 };
    current = c;
    log(`voice: connection attached ref=${c.ref}`);
    direct(c, { t: 'status', kind: 'session', state: gateway.state() });
    if (!c.closed) startLive(c);
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
