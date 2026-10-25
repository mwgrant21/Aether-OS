// electron/control/protocol.ts
//
// Wire frames for phone CONTROL (/ctl). The phone speaks hello, attach and detach; titan answers with welcome, bye,
// snap, out, size and state. There is no input, start or prompt verb yet. controlBoundary.test.ts reads MESSAGE_TYPES
// below statically and requires the gateway to handle exactly phoneToTitan, so a new verb is a reviewed edit to both
// files. protocol/mobile-protocol.json pins these values from the outside (protocol.test.ts).
import { CONTROL_BYE_REASONS, TERMINAL_SLOTS } from '../../src/shared/remote/types';
import type { TerminalInfo, TerminalSlotId, TerminalSlotState } from '../../src/shared/remote/types';

export const MESSAGE_TYPES = {
  phoneToTitan: ['hello', 'attach', 'detach'],
  titanToPhone: ['welcome', 'bye', 'snap', 'out', 'size', 'state'],
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
export type PhoneMessage = HelloMessage | AttachMessage | DetachMessage;

const APP_MAX = 32;
const EPOCH_RE = /^[0-9a-f]{16}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;

function slotOf(v: unknown): TerminalSlotId | null {
  const hit = TERMINAL_SLOTS.find((x) => x.s === v);
  return hit ? hit.s : null;
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

export function encodeWelcome(o: { proof: string; serverTimeMs: number; expiresAtMs: number; sessions?: readonly TerminalInfo[] }): string {
  return JSON.stringify({
    t: 'welcome',
    v: PROTOCOL_VERSION,
    proof: o.proof,
    serverTimeMs: o.serverTimeMs,
    expiresAtMs: o.expiresAtMs,
    sessions: (o.sessions ?? []).map((x) => ({ s: x.s, label: x.label, state: x.state, cols: x.cols, rows: x.rows, q: x.q })),
    applied: {},
    prompts: [],
  });
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
