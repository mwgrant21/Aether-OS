// electron/control/controlGateway.ts
//
// Per-socket protocol state for /ctl. The first valid hello cancels the deadline and is answered with a welcome
// whose proof comes from the identity (ControlIdentity.proofFor; the HMAC lives in remoteAuth, never here) and
// whose sessions come from the read port; only then does the socket start receiving state frames. After hello the
// phone may attach/detach a terminal slot (at most one attachment per slot). Anything else, including a second
// hello, attach/detach before hello, an unknown verb or an oversize frame, is answered with bye(policy) and closes
// 1008. The only terminal handle held here is a TerminalReadPort (list/attach/onState): this file cannot write,
// resize or start a terminal. Without a port (the option is optional) every attach is a policy violation and
// welcome.sessions is empty. The read-only thread verbs
// (tattach/tdetach/tget) work the same way through an optional ThreadReadPort: no port = policy violation and no caps
// in the welcome; a thread frame is only ever sent through a tap created by that socket's own tattach for that slot
// (so none before tattach, none after tdetach), and tget for a slot that is not attached is dropped without a reply.
// The three verbs share one token bucket per socket (THREAD_RATE_PER_S, burst THREAD_RATE_BURST); an empty bucket is
// bye(rate-limit). The nonce, proof, credentials and terminal content are never logged; log lines are
// fixed strings plus the slot id and the identity ref.
import { CONTROL_CTL_MAX_PAYLOAD, CONTROL_HELLO_TIMEOUT_MS } from '../../src/shared/remote/types';
import type { ControlIdentity, ControlSocket, TerminalAttachment, TerminalReadPort, TerminalSlotId, TerminalTap } from '../../src/shared/remote/types';
import { THREAD_RATE_BURST, THREAD_RATE_PER_S } from '../../src/shared/remote/threadTypes';
import type { ThreadAttachment, ThreadReadPort, ThreadSlotId, ThreadTap } from '../../src/shared/remote/threadTypes';
import { encodeBye, encodeOut, encodeSize, encodeSnap, encodeState, encodeTadd, encodeTdet, encodeTmeta, encodeTsnap, encodeTupd, encodeWelcome, parsePhoneMessage } from './protocol';
import type { ByeReason } from './protocol';

export interface ControlSession {
  ref: string;
  close(reason: ByeReason): void;
}

export interface ControlGatewayOptions {
  now: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  log?: (msg: string, ref: string) => void;
  helloTimeoutMs?: number;
  /** Read-only terminal access. Absent = fail closed: sessions stay empty and attach is a policy violation. */
  terminals?: TerminalReadPort;
  /** Read-only thread access. Absent = fail closed: no caps in welcome and every thread verb is a policy violation. */
  threads?: ThreadReadPort;
}

export interface ControlGateway {
  attach(socket: ControlSocket, identity: ControlIdentity): ControlSession;
}

const CLOSE_NORMAL = 1000;
const CLOSE_POLICY = 1008;

interface ThreadAttached {
  live: boolean;
  handle: ThreadAttachment | null;
}

interface Attached {
  live: boolean;
  handle: TerminalAttachment | null;
}

export function createControlGateway(opts: ControlGatewayOptions): ControlGateway {
  const setTimer = opts.setTimeoutFn ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer = opts.clearTimeoutFn ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const helloTimeoutMs = opts.helloTimeoutMs ?? CONTROL_HELLO_TIMEOUT_MS;
  const log = opts.log;
  const terminals = opts.terminals;
  const threads = opts.threads;

  function attach(socket: ControlSocket, identity: ControlIdentity): ControlSession {
    let closed = false;
    let helloSeen = false;
    let deadline: unknown = null;
    let unsubscribeState: (() => void) | null = null;
    const attachments = new Map<TerminalSlotId, Attached>();
    const threadAttachments = new Map<ThreadSlotId, ThreadAttached>();
    let bucket = THREAD_RATE_BURST;
    let bucketAt = opts.now();
    let tgetBusy = false;

    const cancelDeadline = (): void => {
      if (deadline !== null) clearTimer(deadline);
      deadline = null;
    };

    const releaseThread = (a: ThreadAttached): void => {
      a.live = false;
      const handle = a.handle;
      a.handle = null;
      try {
        handle?.detach();
      } catch {
        // a failing detach must not keep the socket (or the other attachments) from being torn down
      }
    };

    // Token bucket over tattach/tdetach/tget. false = empty.
    const takeToken = (): boolean => {
      const t = opts.now();
      bucket = Math.min(THREAD_RATE_BURST, bucket + (Math.max(0, t - bucketAt) / 1000) * THREAD_RATE_PER_S);
      bucketAt = t;
      if (bucket < 1) return false;
      bucket -= 1;
      return true;
    };

    const release = (a: Attached): void => {
      a.live = false;
      const handle = a.handle;
      a.handle = null;
      try {
        handle?.detach();
      } catch {
        // a failing detach must not keep the socket (or the other attachments) from being torn down
      }
    };

    const teardown = (): void => {
      for (const a of attachments.values()) release(a);
      attachments.clear();
      for (const a of threadAttachments.values()) releaseThread(a);
      threadAttachments.clear();
      const unsub = unsubscribeState;
      unsubscribeState = null;
      try {
        unsub?.();
      } catch {
        // a failing unsubscribe must not skip the bye or the close that follow
      }
    };

    const close = (reason: ByeReason): void => {
      if (closed) return;
      closed = true;
      cancelDeadline();
      teardown();
      try {
        socket.send(encodeBye(reason));
      } finally {
        socket.close(reason === 'policy' ? CLOSE_POLICY : CLOSE_NORMAL);
      }
    };

    const violation = (why: string): void => {
      log?.(why, identity.ref);
      close('policy');
    };

    deadline = setTimer(() => {
      deadline = null;
      if (closed || helloSeen) return;
      violation('control: hello deadline expired');
    }, helloTimeoutMs);

    socket.onClose(() => {
      closed = true;
      cancelDeadline();
      teardown();
    });

    const startAttachment = (slot: TerminalSlotId, lastQ: number | null, port: TerminalReadPort): void => {
      const prior = attachments.get(slot);
      if (prior) release(prior);
      const entry: Attached = { live: true, handle: null };
      attachments.set(slot, entry);
      let mode: 'snap' | 'resume' | null = null;
      const note = (m: 'snap' | 'resume'): void => {
        if (mode !== null) return;
        mode = m;
        log?.(`control: attach slot=${slot} mode=${m}`, identity.ref);
      };
      const tap: TerminalTap = {
        snap: (e) => {
          if (!entry.live || closed) return;
          note('snap');
          socket.send(encodeSnap({ s: slot, q: e.q, cols: e.cols, rows: e.rows, d: e.d }));
        },
        out: (e) => {
          if (!entry.live || closed) return;
          note('resume');
          socket.send(encodeOut({ s: slot, q: e.q, d: e.d }));
        },
        size: (e) => {
          if (!entry.live || closed) return;
          socket.send(encodeSize({ s: slot, cols: e.cols, rows: e.rows }));
        },
      };
      const handle = port.attach(slot, lastQ, tap);
      if (entry.live) entry.handle = handle;
      else {
        // detached or closed while attach() was still replaying synchronously
        try {
          handle.detach();
        } catch {
          // a failing late detach must not escape into the message handler
        }
      }
    };

    // Shared entry check for the three thread verbs. false = the socket was closed (violation or rate limit).
    const threadGate = (beforeHello: string): boolean => {
      if (!helloSeen) return violation(beforeHello), false;
      if (!threads) return violation('control: no thread port'), false;
      if (!takeToken()) {
        log?.('control: thread rate-limit', identity.ref);
        close('rate-limit');
        return false;
      }
      return true;
    };

    const startThread = (slot: ThreadSlotId, port: ThreadReadPort): void => {
      const prior = threadAttachments.get(slot);
      if (prior) releaseThread(prior);
      const entry: ThreadAttached = { live: true, handle: null };
      threadAttachments.set(slot, entry);
      const tap: ThreadTap = {
        snap: (e) => {
          if (!entry.live || closed) return;
          socket.send(encodeTsnap({ s: slot, q: e.q, avail: e.avail, why: e.why, entries: e.entries, m: e.m }));
        },
        add: (q, e) => {
          if (!entry.live || closed) return;
          socket.send(encodeTadd({ s: slot, q, e }));
        },
        upd: (q, e) => {
          if (!entry.live || closed) return;
          socket.send(encodeTupd({ s: slot, q, e }));
        },
        meta: (m) => {
          if (!entry.live || closed) return;
          socket.send(encodeTmeta({ s: slot, m }));
        },
      };
      const handle = port.attach(slot, tap);
      if (entry.live) entry.handle = handle;
      else {
        try {
          handle.detach();
        } catch {
          // a failing late detach must not escape into the message handler
        }
      }
    };

    socket.onMessage((text) => {
      if (closed) return;
      if (text.length > CONTROL_CTL_MAX_PAYLOAD) return violation('control: oversize frame');
      const msg = parsePhoneMessage(text);
      if (msg === null) return violation('control: invalid frame');
      switch (msg.t) {
        case 'hello': {
          if (helloSeen) return violation('control: repeated hello');
          helloSeen = true;
          cancelDeadline();
          socket.send(
            encodeWelcome({
              proof: identity.proofFor(msg.nonce),
              serverTimeMs: opts.now(),
              expiresAtMs: identity.expiresAtMs,
              sessions: terminals ? terminals.list() : [],
              caps: threads ? ['thread'] : [],
            }),
          );
          log?.('control: hello accepted', identity.ref);
          if (terminals) {
            unsubscribeState = terminals.onState((e) => {
              if (closed) return;
              socket.send(encodeState({ s: e.s, state: e.state }));
            });
          }
          return;
        }
        case 'attach':
          if (!helloSeen) return violation('control: attach before hello');
          if (!terminals) return violation('control: no terminal port');
          startAttachment(msg.s, msg.q ?? null, terminals);
          return;
        case 'detach': {
          if (!helloSeen) return violation('control: detach before hello');
          const a = attachments.get(msg.s);
          if (!a) return;
          attachments.delete(msg.s);
          release(a);
          log?.(`control: detach slot=${msg.s}`, identity.ref);
          return;
        }
        case 'tattach': {
          if (!threadGate('control: tattach before hello')) return;
          log?.(`control: thread attach slot=${msg.s}`, identity.ref);
          startThread(msg.s, threads!);
          return;
        }
        case 'tdetach': {
          if (!threadGate('control: tdetach before hello')) return;
          const a = threadAttachments.get(msg.s);
          if (!a) return;
          threadAttachments.delete(msg.s);
          releaseThread(a);
          log?.(`control: thread detach slot=${msg.s}`, identity.ref);
          return;
        }
        case 'tget': {
          if (!threadGate('control: tget before hello')) return;
          // only for a slot this socket attached, and only one at a time; anything else is dropped unanswered
          if (!threadAttachments.has(msg.s) || tgetBusy) return;
          tgetBusy = true;
          try {
            log?.(`control: thread get slot=${msg.s}`, identity.ref);
            const d = threads!.detail(msg.s, msg.id);
            socket.send(encodeTdet({ s: msg.s, id: msg.id, input: d?.input ?? null, inMore: d?.inMore ?? 0, x: d?.x ?? null, more: d?.more ?? 0 }));
          } finally {
            tgetBusy = false;
          }
          return;
        }
        default:
          return violation('control: unhandled frame type');
      }
    });

    return { ref: identity.ref, close };
  }

  return { attach };
}
