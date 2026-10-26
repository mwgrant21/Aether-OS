// src/shared/remote/threadTypes.ts
//
// Renderer-safe (no node imports) types and constants for the control-scoped session THREAD feed (V3-A3).
// protocol/mobile-protocol.json pins every constant and golden frame from the outside (mobileProtocol.test.ts and
// ControlProtocolTest.kt). Wire keys are short, v1 style. Entry text is redacted by electron/thread before it gets here.

export const THREAD_SLOTS = ['claude', 'terminal2'] as const;
export type ThreadSlotId = (typeof THREAD_SLOTS)[number];

export const THREAD_HISTORY_ENTRIES = 200;
/** JSON text length of the snapshot's `entries` array; the oldest entries are dropped to fit. */
export const THREAD_SNAPSHOT_BYTES = 131072;
export const THREAD_TEXT_CAP = 4000;
export const THREAD_LABEL_CAP = 80;
export const THREAD_DIFF_INLINE_LINES = 8;
export const THREAD_DETAIL_BYTES = 4096;
export const THREAD_DETAIL_LINES = 60;
/** Tapped tool INPUT (S7): full command / path / pattern / edit arguments, capped smaller than the output. */
export const THREAD_INPUT_BYTES = 2048;
export const THREAD_INPUT_LINES = 30;
export const THREAD_DETAIL_STORE_BYTES = 1048576;
export const THREAD_POLL_MS = 1000;
export const THREAD_QUIET_MS = 10000;
export const THREAD_PERM_CLEAR_MS = 900000;
export const THREAD_RATE_PER_S = 5;
export const THREAD_RATE_BURST = 10;

export type ThreadToolState = 'run' | 'ok' | 'err';
export type ThreadDiffLine = readonly ['-' | '+', string];

export interface ThreadUserEntry {
  id: string;
  ts: number;
  k: 'u';
  x: string;
  tr: boolean;
}
export interface ThreadAssistantEntry {
  id: string;
  ts: number;
  k: 'a';
  x: string;
  tr: boolean;
}
export interface ThreadToolEntry {
  id: string;
  ts: number;
  k: 't';
  n: string;
  l: string;
  st: ThreadToolState;
  sz: number | null;
  d: boolean;
  df?: readonly ThreadDiffLine[];
  dn?: number;
}
export interface ThreadThinkingEntry {
  id: string;
  ts: number;
  k: 'th';
  ms: number | null;
  d: boolean;
}
export type ThreadEntry = ThreadUserEntry | ThreadAssistantEntry | ThreadToolEntry | ThreadThinkingEntry;

export type ThreadWork = 'working' | 'idle' | 'unknown';
export type ThreadWait = null | 'perm' | 'quiet';
export interface ThreadMeta {
  ctxTok: number | null;
  ctxPct: number | null;
  work: ThreadWork;
  since: number | null;
  tok: number | null;
  last: number | null;
  wait: ThreadWait;
}

export type ThreadWhy = 'no-session' | 'starting' | 'unreadable';
export interface ThreadSnapshot {
  q: number;
  avail: boolean;
  why: ThreadWhy | null;
  entries: readonly ThreadEntry[];
  m: ThreadMeta;
}

/** Reply to `tget` (S7): the redacted tool INPUT first, then the redacted output / thinking text. Null text = none. */
export interface ThreadDetail {
  input: string | null;
  inMore: number;
  x: string | null;
  more: number;
}

/** Receives one phone's view of a slot's thread. `snap` is delivered synchronously inside `attach`, then add/upd/meta in order. */
export interface ThreadTap {
  snap(s: ThreadSnapshot): void;
  add(q: number, e: ThreadEntry): void;
  upd(q: number, e: ThreadEntry): void;
  meta(m: ThreadMeta): void;
}
export interface ThreadAttachment {
  detach(): void;
}
export interface ThreadReadPort {
  attach(slot: ThreadSlotId, tap: ThreadTap): ThreadAttachment;
  /** null = unknown/evicted id or no detail. */
  detail(slot: ThreadSlotId, id: string): ThreadDetail | null;
  noteNotification(sessionId: string, type: string): void;
  stopAll(): void;
}
