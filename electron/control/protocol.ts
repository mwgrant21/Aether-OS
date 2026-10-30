// electron/control/protocol.ts
//
// Wire frames for phone CONTROL (/ctl). The phone speaks hello, attach, detach, in (typed input), thread.attach, thread.detach, ledger.attach and ledger.detach; titan answers with welcome,
// bye, snap, out, size, state, ack, nak, thread.snap, thread.ev, thread.state, prompt, prompt.closed and ledger.snap. There is no start verb and no answer-a-prompt verb yet. controlBoundary.test.ts reads MESSAGE_TYPES
// below statically and requires the gateway to handle exactly phoneToTitan, so a new verb is a reviewed edit to both
// files. protocol/mobile-protocol.json pins these values from the outside (protocol.test.ts).
import { CONTROL_BYE_REASONS, CONTROL_INPUT_MAX_BYTES, LEDGER_TIERS, TERMINAL_SLOTS } from '../../src/shared/remote/types';
import type { LedgerWire, NakReason, PromptCloseReason, PromptInfo, TerminalInfo, TerminalSlotId, TerminalSlotState, ThreadEvent, ThreadSlotId } from '../../src/shared/remote/types';

export const MESSAGE_TYPES = {
  phoneToTitan: ['hello', 'attach', 'detach', 'in', 'thread.attach', 'thread.detach', 'ledger.attach', 'ledger.detach'],
  titanToPhone: ['welcome', 'bye', 'snap', 'out', 'size', 'state', 'ack', 'nak', 'thread.snap', 'thread.ev', 'thread.state', 'prompt', 'prompt.closed', 'ledger.snap'],
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
export interface ThreadAttachMessage {
  t: 'thread.attach';
  s: ThreadSlotId;
}
export interface ThreadDetachMessage {
  t: 'thread.detach';
  s: ThreadSlotId;
}
export interface LedgerAttachMessage {
  t: 'ledger.attach';
}
export interface LedgerDetachMessage {
  t: 'ledger.detach';
}
export type PhoneMessage = HelloMessage | AttachMessage | DetachMessage | InMessage | ThreadAttachMessage | ThreadDetachMessage | LedgerAttachMessage | LedgerDetachMessage;

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
  if (kind === 'thread.attach' || kind === 'thread.detach') {
    if (o.s !== 'claude') return null; // the thread exists for the Claude slot only
    return { t: kind, s: 'claude' };
  }
  if (kind === 'ledger.attach' || kind === 'ledger.detach') return { t: kind };
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

export function encodeNak(o: { s: TerminalSlotId; c: number; reason: NakReason }): string {
  return JSON.stringify({ t: 'nak', s: o.s, c: o.c, reason: o.reason });
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

export function encodeThreadSnap(o: { s: ThreadSlotId; q: number; attached: boolean; working: boolean; workingSinceMs: number | null; events: readonly ThreadEvent[] }): string {
  return JSON.stringify({ t: 'thread.snap', s: o.s, q: o.q, attached: o.attached, working: o.working, workingSinceMs: o.workingSinceMs, events: o.events.map(shapeEvent) });
}

export function encodeThreadEv(o: { s: ThreadSlotId; q: number; events: readonly ThreadEvent[] }): string {
  return JSON.stringify({ t: 'thread.ev', s: o.s, q: o.q, events: o.events.map(shapeEvent) });
}

export function encodeThreadState(o: { s: ThreadSlotId; q: number; working: boolean; workingSinceMs: number | null }): string {
  return JSON.stringify({ t: 'thread.state', s: o.s, q: o.q, working: o.working, workingSinceMs: o.workingSinceMs });
}

export function encodePrompt(o: PromptInfo): string {
  return JSON.stringify({ t: 'prompt', id: o.id, tool: o.tool, risk: o.risk, summary: o.summary, ttlMs: o.ttlMs });
}

export function encodePromptClosed(o: { id: string; reason: PromptCloseReason }): string {
  return JSON.stringify({ t: 'prompt.closed', id: o.id, reason: o.reason });
}

// Fixed key order and no stray keys, whatever object the feed hands over.
function shapeEvent(e: ThreadEvent): Record<string, unknown> {
  if (e.k === 'tool') return { k: 'tool', id: e.id, at: e.at, name: e.name, target: e.target ?? null, add: e.add ?? null, del: e.del ?? null };
  return { k: e.k, id: e.id, at: e.at, text: e.text, truncated: e.truncated };
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const cost = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const count = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;

/**
 * Fail-closed: the payload is rebuilt field by field in the golden's key order (no spread, no pass-through). If any
 * number or tier fails its check the whole frame degrades to {"t":"ledger.snap","ledger":null}; never a partial payload.
 */
export function encodeLedgerSnap(l: LedgerWire | null): string {
  const empty = JSON.stringify({ t: 'ledger.snap', ledger: null });
  if (l === null || typeof l !== 'object') return empty;
  const { total, tiers, rollups, cache } = l;
  if (!total || !rollups || !cache || !Array.isArray(tiers)) return empty;
  const roll = (x: unknown): number | null | undefined => (x === null ? null : cost(x) ? r4(x) : undefined);
  const today = roll(rollups.today);
  const week = roll(rollups.week);
  const month = roll(rollups.month);
  if (
    !count(l.computedAtMs) ||
    !cost(total.usd) || !cost(total.input) || !cost(total.output) || !cost(total.cacheCreation) || !cost(total.cacheRead) ||
    today === undefined || week === undefined || month === undefined ||
    !count(cache.readTokens) || !cost(cache.wouldHaveUsd) || !cost(cache.actualUsd) || !cost(cache.savedUsd) ||
    !cost(cache.hitRate) || cache.hitRate > 1 ||
    !tiers.every((t) => (LEDGER_TIERS as readonly unknown[]).includes(t))
  ) {
    return empty;
  }
  return JSON.stringify({
    t: 'ledger.snap',
    ledger: {
      computedAtMs: l.computedAtMs,
      total: { usd: r4(total.usd), input: r4(total.input), output: r4(total.output), cacheCreation: r4(total.cacheCreation), cacheRead: r4(total.cacheRead) },
      tiers: [...tiers],
      rollups: { today, week, month },
      cache: { readTokens: cache.readTokens, wouldHaveUsd: r4(cache.wouldHaveUsd), actualUsd: r4(cache.actualUsd), savedUsd: r4(cache.savedUsd), hitRate: r4(cache.hitRate) },
    },
  });
}
