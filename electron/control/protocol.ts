// electron/control/protocol.ts
//
// Wire frames for phone CONTROL (/ctl). V1 speaks hello (phone) and welcome / bye (titan) only; there is no
// terminal, input or prompt verb. controlBoundary.test.ts reads MESSAGE_TYPES below statically and requires the
// gateway to handle exactly phoneToTitan, so a new verb is a reviewed edit to both files. protocol/mobile-protocol.json
// pins these values from the outside (protocol.test.ts).
import { CONTROL_BYE_REASONS } from '../../src/shared/remote/types';

export const MESSAGE_TYPES = {
  phoneToTitan: ['hello'],
  titanToPhone: ['welcome', 'bye'],
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
export type PhoneMessage = HelloMessage;

const APP_MAX = 32;
const EPOCH_RE = /^[0-9a-f]{16}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;

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
  const { v, app, epoch, nonce } = o;
  if (v !== PROTOCOL_VERSION) return null;
  if (typeof app !== 'string' || app.length > APP_MAX) return null;
  if (typeof epoch !== 'string' || !EPOCH_RE.test(epoch)) return null;
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return null;
  return { t: 'hello', v: PROTOCOL_VERSION, app, epoch, nonce };
}

export function encodeWelcome(o: { proof: string; serverTimeMs: number; expiresAtMs: number }): string {
  return JSON.stringify({
    t: 'welcome',
    v: PROTOCOL_VERSION,
    proof: o.proof,
    serverTimeMs: o.serverTimeMs,
    expiresAtMs: o.expiresAtMs,
    sessions: [],
    applied: {},
    prompts: [],
  });
}

export function encodeBye(reason: ByeReason): string {
  return JSON.stringify({ t: 'bye', reason });
}
