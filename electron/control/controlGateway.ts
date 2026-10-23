// electron/control/controlGateway.ts
//
// Per-socket protocol state for /ctl. V1 handles hello only: the first valid hello cancels the deadline and is
// answered with a welcome whose proof comes from the identity (ControlIdentity.proofFor; the HMAC lives in
// remoteAuth, never here). Anything else, including a second hello, an unknown verb or an oversize frame, is
// answered with bye(policy) and closes 1008. Nothing here reaches a terminal. The nonce, proof and credentials are
// never logged; log lines are fixed strings plus the identity ref.
import { CONTROL_CTL_MAX_PAYLOAD, CONTROL_HELLO_TIMEOUT_MS } from '../../src/shared/remote/types';
import type { ControlIdentity, ControlSocket } from '../../src/shared/remote/types';
import { encodeBye, encodeWelcome, parsePhoneMessage } from './protocol';
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
}

export interface ControlGateway {
  attach(socket: ControlSocket, identity: ControlIdentity): ControlSession;
}

const CLOSE_NORMAL = 1000;
const CLOSE_POLICY = 1008;

export function createControlGateway(opts: ControlGatewayOptions): ControlGateway {
  const setTimer = opts.setTimeoutFn ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer = opts.clearTimeoutFn ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const helloTimeoutMs = opts.helloTimeoutMs ?? CONTROL_HELLO_TIMEOUT_MS;
  const log = opts.log;

  function attach(socket: ControlSocket, identity: ControlIdentity): ControlSession {
    let closed = false;
    let helloSeen = false;
    let deadline: unknown = null;

    const cancelDeadline = (): void => {
      if (deadline !== null) clearTimer(deadline);
      deadline = null;
    };

    const close = (reason: ByeReason): void => {
      if (closed) return;
      closed = true;
      cancelDeadline();
      socket.send(encodeBye(reason));
      socket.close(reason === 'policy' ? CLOSE_POLICY : CLOSE_NORMAL);
    };

    const violation = (why: string): void => {
      log?.(why, identity.ref);
      close('policy');
    };

    deadline = setTimer(() => {
      deadline = null;
      violation('control: hello deadline expired');
    }, helloTimeoutMs);

    socket.onClose(() => {
      closed = true;
      cancelDeadline();
    });

    socket.onMessage((text) => {
      if (closed) return;
      if (text.length > CONTROL_CTL_MAX_PAYLOAD) return violation('control: oversize frame');
      const msg = parsePhoneMessage(text);
      if (msg === null) return violation('control: invalid frame');
      switch (msg.t) {
        case 'hello':
          if (helloSeen) return violation('control: repeated hello');
          helloSeen = true;
          cancelDeadline();
          socket.send(
            encodeWelcome({
              proof: identity.proofFor(msg.nonce),
              serverTimeMs: opts.now(),
              expiresAtMs: identity.expiresAtMs,
            }),
          );
          log?.('control: hello accepted', identity.ref);
          return;
        default:
          return violation('control: unhandled frame type');
      }
    });

    return { ref: identity.ref, close };
  }

  return { attach };
}
