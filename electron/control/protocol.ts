// electron/control/protocol.ts
//
// Wire frames for phone CONTROL (/ctl). The phone speaks hello, attach, detach and the read-only thread verbs tattach,
// tdetach and tget; titan answers with welcome, bye, snap, out, size, state and the thread frames tsnap, tadd, tupd,
// tmeta and tdet. There is no input, start or prompt verb yet. controlBoundary.test.ts reads MESSAGE_TYPES
// below statically and requires the gateway to handle exactly phoneToTitan, so a new verb is a reviewed edit to both
// files. protocol/mobile-protocol.json pins these values from the outside (protocol.test.ts).
import { CONTROL_BYE_REASONS, TERMINAL_SLOTS } from '../../src/shared/remote/types';
import { THREAD_SLOTS } from '../../src/shared/remote/threadTypes';
import type { ThreadEntry, ThreadMeta, ThreadSlotId, ThreadWhy } from '../../src/shared/remote/threadTypes';
import type { TerminalInfo, TerminalSlotId, TerminalSlotState } from '../../src/shared/remote/types';

export const MESSAGE_TYPES = {
  phoneToTitan: ['hello', 'attach', 'detach', 'tattach', 'tdetach', 'tget'],
  titanToPhone: ['welcome', 'bye', 'snap', 'out', 'size', 'state', 'tsnap', 'tadd', 'tupd', 'tmeta', 'tdet'],
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
export interface TattachMessage {
  t: 'tattach';
  s: ThreadSlotId;
}
export interface TdetachMessage {
  t: 'tdetach';
  s: ThreadSlotId;
}
export interface TgetMessage {
  t: 'tget';
  s: ThreadSlotId;
  id: string;
}
export type PhoneMessage = HelloMessage | AttachMessage | DetachMessage | TattachMessage | TdetachMessage | TgetMessage;

const APP_MAX = 32;
const EPOCH_RE = /^[0-9a-f]{16}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const THREAD_ID_RE = /^[0-9]{1,12}:[0-9]{1,4}$/;

function slotOf(v: unknown): TerminalSlotId | null {
  const hit = TERMINAL_SLOTS.find((x) => x.s === v);
  return hit ? hit.s : null;
}

function threadSlotOf(v: unknown): ThreadSlotId | null {
  return (THREAD_SLOTS as readonly unknown[]).includes(v) ? (v as ThreadSlotId) : null;
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
  if (kind === 'tattach' || kind === 'tdetach' || kind === 'tget') {
    const s = threadSlotOf(o.s);
    if (s === null) return null;
    if (kind === 'tget') {
      if (typeof o.id !== 'string' || !THREAD_ID_RE.test(o.id)) return null;
      return { t: 'tget', s, id: o.id };
    }
    return { t: kind, s };
  }
  const { v, app, epoch, nonce } = o;
  if (v !== PROTOCOL_VERSION) return null;
  if (typeof app !== 'string' || app.length > APP_MAX) return null;
  if (typeof epoch !== 'string' || !EPOCH_RE.test(epoch)) return null;
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return null;
  return { t: 'hello', v: PROTOCOL_VERSION, app, epoch, nonce };
}

export function encodeWelcome(o: { proof: string; serverTimeMs: number; expiresAtMs: number; sessions?: readonly TerminalInfo[]; caps?: readonly string[] }): string {
  const frame: Record<string, unknown> = {
    t: 'welcome',
    v: PROTOCOL_VERSION,
    proof: o.proof,
    serverTimeMs: o.serverTimeMs,
    expiresAtMs: o.expiresAtMs,
    sessions: (o.sessions ?? []).map((x) => ({ s: x.s, label: x.label, state: x.state, cols: x.cols, rows: x.rows, q: x.q })),
    applied: {},
    prompts: [],
  };
  if (o.caps && o.caps.length > 0) frame.caps = [...o.caps]; // appended last so a caps-less welcome stays byte-identical
  return JSON.stringify(frame);
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

// --- thread frames (read-only; sent only after the phone's tattach) ---
// Entries are rebuilt key by key so a stray property on an input object can never reach the wire, and the key order
// is fixed (the goldens in mobile-protocol.json are compared byte for byte).
function entryWire(e: ThreadEntry): Record<string, unknown> {
  switch (e.k) {
    case 'u':
    case 'a':
      return { id: e.id, ts: e.ts, k: e.k, x: e.x, tr: e.tr };
    case 't': {
      const o: Record<string, unknown> = { id: e.id, ts: e.ts, k: 't', n: e.n, l: e.l, st: e.st, sz: e.sz, d: e.d };
      if (e.df !== undefined) o.df = e.df.map((p) => [p[0], p[1]]);
      if (e.dn !== undefined) o.dn = e.dn;
      return o;
    }
    case 'th':
      return { id: e.id, ts: e.ts, k: 'th', ms: e.ms, d: e.d };
  }
}

function metaWire(m: ThreadMeta): Record<string, unknown> {
  return { ctxTok: m.ctxTok, ctxPct: m.ctxPct, work: m.work, since: m.since, tok: m.tok, last: m.last, wait: m.wait };
}

/** JSON text length of an entries array: the unit THREAD_SNAPSHOT_BYTES is measured in. */
export function threadEntriesJsonLength(entries: readonly ThreadEntry[]): number {
  return JSON.stringify(entries.map(entryWire)).length;
}

export function encodeTsnap(o: { s: ThreadSlotId; q: number; avail: boolean; why: ThreadWhy | null; entries: readonly ThreadEntry[]; m: ThreadMeta }): string {
  return JSON.stringify({ t: 'tsnap', s: o.s, q: o.q, avail: o.avail, why: o.why, entries: o.avail ? o.entries.map(entryWire) : [], m: metaWire(o.m) });
}

export function encodeTadd(o: { s: ThreadSlotId; q: number; e: ThreadEntry }): string {
  return JSON.stringify({ t: 'tadd', s: o.s, q: o.q, e: entryWire(o.e) });
}

export function encodeTupd(o: { s: ThreadSlotId; q: number; e: ThreadEntry }): string {
  return JSON.stringify({ t: 'tupd', s: o.s, q: o.q, e: entryWire(o.e) });
}

export function encodeTmeta(o: { s: ThreadSlotId; m: ThreadMeta }): string {
  return JSON.stringify({ t: 'tmeta', s: o.s, m: metaWire(o.m) });
}

/** Reply to tget. input/x null = nothing to show; inMore/more = omitted line counts (S7: the tool input comes first). */
export function encodeTdet(o: { s: ThreadSlotId; id: string; input: string | null; inMore: number; x: string | null; more: number }): string {
  return JSON.stringify({ t: 'tdet', s: o.s, id: o.id, input: o.input, inMore: o.inMore, x: o.x, more: o.more });
}
