// electron/control/controlGateway.ts
//
// Per-socket protocol state for /ctl. The first valid hello cancels the deadline and is answered with a welcome
// whose proof comes from the identity (ControlIdentity.proofFor; the HMAC lives in remoteAuth, never here) and
// whose sessions come from the read port; only then does the socket start receiving state frames. After hello the
// phone may attach/detach a terminal slot (at most one attachment per slot). Anything else, including a second
// hello, attach/detach/in before hello, an unknown verb or an oversize frame, is answered with bye(policy) and closes
// 1008. The only terminal handle held here is a TerminalReadPort (list/attach/onState): this file cannot write,
// resize or start a terminal. A typed `in` frame is only routed, never applied: it must target a slot this socket
// has attached and goes to the injected InputPort (inputRouter owns dedupe, rate limits and the single pty write);
// the gateway only schedules the coalesced ack the port's result calls for, and answers a rejected frame with a nak
// after flushing any pending ack for that slot (so the nak is never followed by an older ack). Without a terminal port every attach is
// a policy violation and welcome.sessions is empty; without an input port every `in` is a policy violation. The nonce, proof, credentials and terminal content are never logged; log lines are
// fixed strings plus the slot id and the identity ref. thread.attach/thread.detach (Claude slot only) route to the injected read-only ThreadReadPort and PromptReadPort: one thread attachment per socket, and prompt frames go only to a socket that has thread-attached. ledger.attach/ledger.detach route to the injected read-only LedgerReadPort: one ledger attachment per socket, ledger.snap goes only to a socket that has ledger-attached, and the snapshot is never logged.
import { CONTROL_ACK_COALESCE_MS, TERMINAL_SLOTS, CONTROL_CTL_MAX_PAYLOAD, CONTROL_HELLO_TIMEOUT_MS } from '../../src/shared/remote/types';
import type { ControlIdentity, ControlSocket, InputPort, InputResult, InputSession, TerminalAttachment, TerminalReadPort, TerminalSlotId, TerminalTap, ThreadReadPort, PromptReadPort, LedgerReadPort } from '../../src/shared/remote/types';
import { encodeAck, encodeBye, encodeLedgerSnap, encodeNak, encodeOut, encodePrompt, encodePromptClosed, encodeSize, encodeSnap, encodeState, encodeThreadEv, encodeThreadSnap, encodeThreadState, encodeWelcome, parsePhoneMessage } from './protocol';
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
  /** Read-only Claude thread feed. Absent = fail closed: thread.attach is a policy violation. */
  threads?: ThreadReadPort;
  /** Pending permission prompts, pushed only to sockets that thread.attach. Read-only. */
  prompts?: PromptReadPort;
  /** Read-only Ledger snapshot feed. Absent = fail closed: ledger.attach is a policy violation. */
  ledger?: LedgerReadPort;
  /** Typed-input router. Absent = fail closed: every `in` frame is a policy violation. */
  input?: InputPort;
  /** Called with the live attached slots (TERMINAL_SLOTS order) after an attach or detach, and with [] once when the socket ends. */
  onAttached?: (ref: string, slots: readonly TerminalSlotId[]) => void;
}

export interface ControlGateway {
  attach(socket: ControlSocket, identity: ControlIdentity): ControlSession;
}

const CLOSE_NORMAL = 1000;
const CLOSE_POLICY = 1008;

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
  const input = opts.input;
  const threads = opts.threads;
  const prompts = opts.prompts;
  const ledger = opts.ledger;

  function attach(socket: ControlSocket, identity: ControlIdentity): ControlSession {
    let closed = false;
    let helloSeen = false;
    let deadline: unknown = null;
    let unsubscribeState: (() => void) | null = null;
    const attachments = new Map<TerminalSlotId, Attached>();
    let inputSession: InputSession | null = null;
    let threadAtt: { live: boolean; handles: { detach(): void }[] } | null = null;
    let ledgerAtt: { live: boolean; handle: { detach(): void } | null } | null = null;
    const ackTimers = new Map<TerminalSlotId, { handle: unknown; c: number }>();

    const cancelDeadline = (): void => {
      if (deadline !== null) clearTimer(deadline);
      deadline = null;
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

    const detachQuietly = (h: { detach(): void }): void => {
      try {
        h.detach();
      } catch {
        // a failing detach must not escape into the message handler
      }
    };

    const releaseThread = (): void => {
      const a = threadAtt;
      threadAtt = null;
      if (!a) return;
      a.live = false;
      for (const h of a.handles) {
        try {
          h.detach();
        } catch {
          // a failing detach must not keep the socket (or the other attachments) from being torn down
        }
      }
    };

    const releaseLedger = (): void => {
      const a = ledgerAtt;
      ledgerAtt = null;
      if (!a) return;
      a.live = false;
      const h = a.handle;
      a.handle = null;
      if (h) detachQuietly(h);
    };

    const reportAttached = (): void => {
      const live = TERMINAL_SLOTS.map(x => x.s).filter(s => attachments.has(s));
      try {
        opts.onAttached?.(identity.ref, live);
      } catch {
        // a failing observer must not break message handling or teardown
      }
    };

    let tornDown = false;
    const teardown = (): void => {
      for (const a of attachments.values()) release(a);
      attachments.clear();
      releaseThread();
      releaseLedger();
      if (!tornDown) {
        tornDown = true; // close() then the socket close event both land here; only the first reports, so a superseding session's slots are never cleared late
        reportAttached();
      }
      for (const t of ackTimers.values()) clearTimer(t.handle);
      ackTimers.clear();
      const is = inputSession;
      inputSession = null;
      try {
        is?.close();
      } catch {
        // a failing session close must not skip the unsubscribe, bye or close that follow
      }
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

    const startThread = (port: ThreadReadPort): void => {
      releaseThread();
      const entry = { live: true, handles: [] as { detach(): void }[] };
      threadAtt = entry;
      const h = port.attach('claude', {
        snap: (e) => {
          if (!entry.live || closed) return;
          socket.send(encodeThreadSnap({ s: 'claude', q: e.q, attached: e.attached, working: e.working, workingSinceMs: e.workingSinceMs, events: e.events }));
        },
        events: (e) => {
          if (!entry.live || closed) return;
          socket.send(encodeThreadEv({ s: 'claude', q: e.q, events: e.events }));
        },
        state: (e) => {
          if (!entry.live || closed) return;
          socket.send(encodeThreadState({ s: 'claude', q: e.q, working: e.working, workingSinceMs: e.workingSinceMs }));
        },
      });
      if (!entry.live) {
        // detached or closed while attach() was still replaying synchronously: releaseThread() already walked a list without this handle
        detachQuietly(h);
        return;
      }
      entry.handles.push(h);
      if (prompts) {
        const ph = prompts.attach({
          opened: (p) => {
            if (!entry.live || closed) return;
            socket.send(encodePrompt(p));
          },
          closed: (e) => {
            if (!entry.live || closed) return;
            socket.send(encodePromptClosed(e));
          },
        });
        if (!entry.live) detachQuietly(ph); // same race for the prompt tap; h was already released by releaseThread()
        else entry.handles.push(ph);
      }
    };

    const startLedger = (port: LedgerReadPort): void => {
      releaseLedger();
      const entry: { live: boolean; handle: { detach(): void } | null } = { live: true, handle: null };
      ledgerAtt = entry;
      const h = port.attach({
        snap: (l) => {
          if (!entry.live || closed) return;
          socket.send(encodeLedgerSnap(l));
        },
      });
      if (!entry.live) {
        // detached or closed while attach() was still replaying synchronously: releaseLedger() ran before this handle existed
        detachQuietly(h);
        return;
      }
      entry.handle = h;
    };

    // Trailing coalesce: one pending timer per slot; the ack carries the newest cseq seen before it fires.
    const scheduleAck = (slot: TerminalSlotId, c: number): void => {
      const pending = ackTimers.get(slot);
      if (pending) {
        pending.c = Math.max(pending.c, c); // a late duplicate carries a lower cumulative value; an ack never regresses
        return;
      }
      const entry = { handle: null as unknown, c };
      ackTimers.set(slot, entry);
      entry.handle = setTimer(() => {
        if (ackTimers.get(slot) !== entry) return;
        ackTimers.delete(slot);
        if (closed) return;
        socket.send(encodeAck({ s: slot, c: entry.c }));
      }, CONTROL_ACK_COALESCE_MS);
    };

    // Send the pending ack for a slot now, so a frame sent after it (a nak) cannot be followed by an older ack.
    const flushAck = (slot: TerminalSlotId): void => {
      const pending = ackTimers.get(slot);
      if (!pending) return;
      clearTimer(pending.handle);
      ackTimers.delete(slot);
      socket.send(encodeAck({ s: slot, c: pending.c }));
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
          inputSession = input ? input.open(identity.ref, msg.epoch) : null;
          socket.send(
            encodeWelcome({
              proof: identity.proofFor(msg.nonce),
              serverTimeMs: opts.now(),
              expiresAtMs: identity.expiresAtMs,
              sessions: terminals ? terminals.list() : [],
              applied: inputSession ? inputSession.applied() : {},
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
          reportAttached();
          return;
        case 'detach': {
          if (!helloSeen) return violation('control: detach before hello');
          const a = attachments.get(msg.s);
          if (!a) return;
          attachments.delete(msg.s);
          release(a);
          log?.(`control: detach slot=${msg.s}`, identity.ref);
          reportAttached();
          return;
        }
        case 'thread.attach':
          if (!helloSeen) return violation('control: thread before hello');
          if (!threads) return violation('control: no thread port');
          startThread(threads);
          log?.('control: thread attach', identity.ref);
          return;
        case 'thread.detach':
          if (!helloSeen) return violation('control: thread before hello');
          if (!threadAtt) return;
          releaseThread();
          log?.('control: thread detach', identity.ref);
          return;
        case 'ledger.attach':
          if (!helloSeen) return violation('control: ledger before hello');
          if (!ledger) return violation('control: no ledger port');
          startLedger(ledger);
          log?.('control: ledger attach', identity.ref);
          return;
        case 'ledger.detach':
          if (!helloSeen) return violation('control: ledger before hello');
          if (!ledgerAtt) return;
          releaseLedger();
          log?.('control: ledger detach', identity.ref);
          return;
        case 'in': {
          if (!helloSeen) return violation('control: input before hello');
          if (!input || !inputSession) return violation('control: no input port');
          if (!attachments.has(msg.s)) return violation('control: input to unattached slot');
          let r: InputResult;
          try {
            r = inputSession.input(msg.s, msg.c, msg.d);
          } catch {
            return violation('control: input failed'); // a throwing router closes this socket, never the gateway; nothing is logged from it
          }
          if (r.kind === 'violation') return violation(r.why);
          if (r.kind === 'rate-limit') {
            log?.('control: input rate limit', identity.ref);
            return close('rate-limit');
          }
          if (r.kind === 'rejected') {
            flushAck(msg.s);
            socket.send(encodeNak({ s: msg.s, c: r.c, reason: r.reason }));
            return;
          }
          scheduleAck(msg.s, r.ack);
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
