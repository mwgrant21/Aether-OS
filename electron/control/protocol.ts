// electron/control/protocol.ts
//
// Wire frames for phone CONTROL (/ctl). The phone speaks hello, attach, detach and in (typed input); titan answers with welcome,
// bye, snap, out, size, state and ack. There is no start or prompt verb yet. controlBoundary.test.ts reads MESSAGE_TYPES
// below statically and requires the gateway to handle exactly phoneToTitan, so a new verb is a reviewed edit to both
// files. protocol/mobile-protocol.json pins these values from the outside (protocol.test.ts).
import { CONTROL_BYE_REASONS, CONTROL_INPUT_MAX_BYTES, TERMINAL_SLOTS } from '../../src/shared/remote/types';
import type { TerminalInfo, TerminalSlotId, TerminalSlotState } from '../../src/shared/remote/types';

export const MESSAGE_TYPES = {
  phoneToTitan: ['hello', 'attach', 'detach', 'in'],
  titanToPhone: ['welcome', 'bye', 'snap', 'out', 'size', 'state', 'ack'],
} as const;

export const PROTOCOL_VERSION = 1;

export type ByeReason = (typeof CONTROL_BYE_REASONS)[number];

export interface HelloMessage {
  t: 'hello';
  v: 1;
  app: string;
  epoch: string;
  nonce: string;
}
export interface AttachMessage {
  t: 'attach';
  s: TerminalSlotId;
  q?: number;
}
export interface DetachMessage {
  t: 'detach';
  s: TerminalSlotId;
}
export interface InMessage {
  t: 'in';
  s: TerminalSlotId;
  c: number;
  d: string;
}
export type PhoneMessage = HelloMessage | AttachMessage | DetachMessage | InMessage;

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const APP_MAX = 32;
const EPOCH_RE = /^[0-9a-f]{16}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;

function slotOf(v: unknown): TerminalSlotId | null {
  const hit = TERMINAL_SLOTS.find((x) => x.s === v);
  return hit ? hit.s : null;
}

/**
 * Returns d iff it is a string of 1..CONTROL_INPUT_MAX_BYTES UTF-8 bytes with no lone surrogate; otherwise throws
 * RangeError. Every other control character (ESC, ^C, DEL, NUL) is valid: they are keystrokes.
 */
export function validateInput(d: unknown): string {
  if (typeof d !== 'string') throw new RangeError('input is not a string');
  if (d.length === 0) throw new RangeError('input is empty');
  if (d.length > CONTROL_INPUT_MAX_BYTES) throw new RangeError('input too long'); // a UTF-16 unit is >= 1 byte
  if (LONE_SURROGATE.test(d)) throw new RangeError('input has a lone surrogate');
  if (Buffer.byteLength(d, 'utf8') > CONTROL_INPUT_MAX_BYTES) throw new RangeError('input too long');
  return d;
}

/** Parse one text frame from the phone. null = not a valid frame of a known type (extra keys are ignored). */
export function parsePhoneMessage(text: string): PhoneMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const kind = o.t;
  if (typeof kind !== 'string' || !(MESSAGE_TYPES.phoneToTitan as readonly string[]).includes(kind)) return null;
  if (kind === 'in') {
    const s = slotOf(o.s);
    if (s === null) return null;
    const c = o.c;
    if (typeof c !== 'number' || !Number.isSafeInteger(c) || c < 1) return null;
    try {
      return { t: 'in', s, c, d: validateInput(o.d) };
    } catch {
      return null;
    }
  }
  if (kind === 'attach' || kind === 'detach') {
    const s = slotOf(o.s);
    if (s === null) return null;
    if (kind === 'detach') return { t: 'detach', s };
    const q = o.q;
    if (q === undefined) return { t: 'attach', s };
    if (typeof q !== 'number' || !Number.isSafeInteger(q) || q < 0) return null;
    return { t: 'attach', s, q: q === 0 ? 0 : q }; // JSON "-0" parses to -0: normalise so the port never sees it
  }
  const { v, app, epoch, nonce } = o;
  if (v !== PROTOCOL_VERSION) return null;
  if (typeof app !== 'string' || app.length > APP_MAX) return null;
  if (typeof epoch !== 'string' || !EPOCH_RE.test(epoch)) return null;
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return null;
  return { t: 'hello', v: PROTOCOL_VERSION, app, epoch, nonce };
}

export function encodeWelcome(o: { proof: string; serverTimeMs: number; expiresAtMs: number; sessions?: readonly TerminalInfo[]; applied?: Record<string, number> }): string {
  return JSON.stringify({
    t: 'welcome',
    v: PROTOCOL_VERSION,
    proof: o.proof,
    serverTimeMs: o.serverTimeMs,
    expiresAtMs: o.expiresAtMs,
    sessions: (o.sessions ?? []).map((x) => ({ s: x.s, label: x.label, state: x.state, cols: x.cols, rows: x.rows, q: x.q })),
    applied: o.applied ?? {},
    prompts: [],
  });
}

export function encodeAck(o: { s: TerminalSlotId; c: number }): string {
  return JSON.stringify({ t: 'ack', s: o.s, c: o.c });
}

export function encodeBye(reason: ByeReason): string {
  return JSON.stringify({ t: 'bye', reason });
}

export function encodeSnap(o: { s: TerminalSlotId; q: number; cols: number; rows: number; d: string }): string {
  return JSON.stringify({ t: 'snap', s: o.s, q: o.q, cols: o.cols, rows: o.rows, d: o.d });
}

export function encodeOut(o: { s: TerminalSlotId; q: number; d: string }): string {
  return JSON.stringify({ t: 'out', s: o.s, q: o.q, d: o.d });
}

export function encodeSize(o: { s: TerminalSlotId; cols: number; rows: number }): string {
  return JSON.stringify({ t: 'size', s: o.s, cols: o.cols, rows: o.rows });
}

export function encodeState(o: { s: TerminalSlotId; state: TerminalSlotState }): string {
  return JSON.stringify({ t: 'state', s: o.s, state: o.state });
}
