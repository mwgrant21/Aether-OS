// Wire protocol between main and the detached pty-owner helper: NDJSON framing, strict
// frame validators, mutual-HMAC proof helpers and the discovery-file codec. Pure module:
// no sockets, no spawn, no electron. The pipe is readable by Everyone, so everything here
// is strict on purpose; a null / thrown / onError result means "destroy the socket".
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TerminalSlotId } from '../../src/shared/remote/types';

export const PROTO = 1;
export const FRAME_MAX_BYTES = 1024 * 1024;
export const RING_MAX = 256 * 1024; // same measure as TERMINAL_RING_BYTES (JSON-escaped length)
export const META_MAX_BYTES = 4096;
export const ENV_MAX_BYTES = 32768;
export const DIM_MAX = 10000;
export const SPEC_FILE = 'powershell.exe';
const PIPE_PREFIX = '\\\\.\\pipe\\';
const SLOT_IDS: readonly string[] = ['claude', 'terminal2', 'codex'] satisfies readonly TerminalSlotId[];

// ---- Types ----
export type Role = 'server' | 'client';
export type Meta = Record<string, unknown>;
export interface LaunchSpec {
  file: string; args: string[]; cwd: string; env: Record<string, string>;
  cols: number; rows: number; writes: string[];
}
export interface SlotInfo {
  slot: TerminalSlotId; state: 'running' | 'exited'; cols: number; rows: number; meta: Meta; startedAt: number;
}
export interface RingChunk { seq: number; d: string }

export type ClientFrame =
  | { t: 'hello'; proto: number; nonceC: string }
  | { t: 'auth'; proofC: string }
  | { t: 'claim' }
  | { t: 'list' }
  | { t: 'spawn'; slot: TerminalSlotId; spec: LaunchSpec; meta: Meta }
  | { t: 'attach'; slot: TerminalSlotId }
  | { t: 'write'; slot: TerminalSlotId; d: string }
  | { t: 'resize'; slot: TerminalSlotId; cols: number; rows: number }
  | { t: 'kill'; slot: TerminalSlotId }
  | { t: 'forget'; slot: TerminalSlotId }
  | { t: 'ping' }
  | { t: 'release' }
  | { t: 'shutdown' };

export type HelperFrame =
  | { t: 'challenge'; nonceS: string; proofS: string }
  | { t: 'ready'; slots: SlotInfo[] }
  | { t: 'slots'; slots: SlotInfo[] }
  | { t: 'attached'; slot: TerminalSlotId; state: 'running' | 'exited'; cols: number; rows: number; meta: Meta;
      startedAt: number; ring: RingChunk[]; seq: number }
  | { t: 'data'; slot: TerminalSlotId; seq: number; d: string }
  | { t: 'exit'; slot: TerminalSlotId }
  | { t: 'pong' }
  | { t: 'busy' }
  | { t: 'displaced' }
  | { t: 'error'; code: string };

// ---- Field checks ----
type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => !!x && typeof x === 'object' && !Array.isArray(x);
const exact = (o: Rec, keys: string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(o, k));
};
const isInt = (x: unknown, min: number, max = Number.MAX_SAFE_INTEGER): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= min && x <= max;
const isSlot = (x: unknown): x is TerminalSlotId => typeof x === 'string' && SLOT_IDS.includes(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isDim = (x: unknown): x is number => isInt(x, 1, DIM_MAX);
const HEX_NONCE = /^[0-9a-f]{32}$/;
const HEX_PROOF = /^[0-9a-f]{64}$/;
const HEX_SECRET = /^[0-9a-f]{64}$/;
const isNonce = (x: unknown): x is string => isStr(x) && HEX_NONCE.test(x);
const isProof = (x: unknown): x is string => isStr(x) && HEX_PROOF.test(x);

function isMeta(x: unknown): x is Meta {
  if (!isRec(x)) return false;
  try { return Buffer.byteLength(JSON.stringify(x)) <= META_MAX_BYTES; } catch { return false; }
}
function isEnv(x: unknown): x is Record<string, string> {
  if (!isRec(x)) return false;
  let bytes = 0;
  for (const [k, v] of Object.entries(x)) {
    if (!isStr(v) || k.length === 0 || k.includes('=') || k.includes('\0') || v.includes('\0')) return false;
    bytes += Buffer.byteLength(k) + Buffer.byteLength(v);
    if (bytes > ENV_MAX_BYTES) return false;
  }
  return true;
}
function parseSpec(x: unknown, home: string): LaunchSpec | null {
  if (!isRec(x) || !exact(x, ['file', 'args', 'cwd', 'env', 'cols', 'rows', 'writes'])) return null;
  if (x.file !== SPEC_FILE || !Array.isArray(x.args) || x.args.length !== 0) return null;
  if (!isStr(home) || home.length === 0 || x.cwd !== home) return null;
  if (!isEnv(x.env) || !isDim(x.cols) || !isDim(x.rows)) return null;
  if (!Array.isArray(x.writes) || !x.writes.every(isStr)) return null;
  return { file: SPEC_FILE, args: [], cwd: home, env: { ...x.env }, cols: x.cols, rows: x.rows, writes: [...x.writes] };
}
function parseSlotInfo(x: unknown): SlotInfo | null {
  if (!isRec(x) || !exact(x, ['slot', 'state', 'cols', 'rows', 'meta', 'startedAt'])) return null;
  if (!isSlot(x.slot) || (x.state !== 'running' && x.state !== 'exited')) return null;
  if (!isDim(x.cols) || !isDim(x.rows) || !isMeta(x.meta) || !isInt(x.startedAt, 0)) return null;
  return { slot: x.slot, state: x.state, cols: x.cols, rows: x.rows, meta: x.meta, startedAt: x.startedAt };
}
function parseSlots(x: unknown): SlotInfo[] | null {
  if (!Array.isArray(x) || x.length > SLOT_IDS.length) return null;
  const out: SlotInfo[] = [];
  for (const e of x) { const s = parseSlotInfo(e); if (!s) return null; out.push(s); }
  return out;
}

/** Validates a client -> helper frame. `home` is the helper's own os.homedir(); spec.cwd must equal it. */
export function parseClientFrame(x: unknown, home: string): ClientFrame | null {
  if (!isRec(x) || !isStr(x.t)) return null;
  switch (x.t) {
    case 'hello':
      return exact(x, ['t', 'proto', 'nonceC']) && isInt(x.proto, 0) && isNonce(x.nonceC)
        ? { t: 'hello', proto: x.proto, nonceC: x.nonceC } : null;
    case 'auth':
      return exact(x, ['t', 'proofC']) && isProof(x.proofC) ? { t: 'auth', proofC: x.proofC } : null;
    case 'claim': case 'list': case 'ping': case 'release': case 'shutdown':
      return exact(x, ['t']) ? { t: x.t } : null;
    case 'spawn': {
      if (!exact(x, ['t', 'slot', 'spec', 'meta']) || !isSlot(x.slot) || !isMeta(x.meta)) return null;
      const spec = parseSpec(x.spec, home);
      return spec ? { t: 'spawn', slot: x.slot, spec, meta: x.meta } : null;
    }
    case 'attach': case 'kill': case 'forget':
      return exact(x, ['t', 'slot']) && isSlot(x.slot) ? { t: x.t, slot: x.slot } : null;
    case 'write':
      return exact(x, ['t', 'slot', 'd']) && isSlot(x.slot) && isStr(x.d) ? { t: 'write', slot: x.slot, d: x.d } : null;
    case 'resize':
      return exact(x, ['t', 'slot', 'cols', 'rows']) && isSlot(x.slot) && isDim(x.cols) && isDim(x.rows)
        ? { t: 'resize', slot: x.slot, cols: x.cols, rows: x.rows } : null;
    default: return null;
  }
}

/** Validates a helper -> client frame. */
export function parseHelperFrame(x: unknown): HelperFrame | null {
  if (!isRec(x) || !isStr(x.t)) return null;
  switch (x.t) {
    case 'challenge':
      return exact(x, ['t', 'nonceS', 'proofS']) && isNonce(x.nonceS) && isProof(x.proofS)
        ? { t: 'challenge', nonceS: x.nonceS, proofS: x.proofS } : null;
    case 'ready': case 'slots': {
      if (!exact(x, ['t', 'slots'])) return null;
      const slots = parseSlots(x.slots);
      return slots ? { t: x.t, slots } : null;
    }
    case 'attached': {
      if (!exact(x, ['t', 'slot', 'state', 'cols', 'rows', 'meta', 'startedAt', 'ring', 'seq'])) return null;
      if (!isSlot(x.slot) || (x.state !== 'running' && x.state !== 'exited')) return null;
      if (!isDim(x.cols) || !isDim(x.rows) || !isMeta(x.meta) || !isInt(x.startedAt, 0) || !isInt(x.seq, 0)) return null;
      if (!Array.isArray(x.ring)) return null;
      const ring: RingChunk[] = [];
      for (const c of x.ring) {
        if (!isRec(c) || !exact(c, ['seq', 'd']) || !isInt(c.seq, 0) || !isStr(c.d)) return null;
        ring.push({ seq: c.seq, d: c.d });
      }
      return { t: 'attached', slot: x.slot, state: x.state, cols: x.cols, rows: x.rows, meta: x.meta,
        startedAt: x.startedAt, ring, seq: x.seq };
    }
    case 'data':
      return exact(x, ['t', 'slot', 'seq', 'd']) && isSlot(x.slot) && isInt(x.seq, 0) && isStr(x.d)
        ? { t: 'data', slot: x.slot, seq: x.seq, d: x.d } : null;
    case 'exit':
      return exact(x, ['t', 'slot']) && isSlot(x.slot) ? { t: 'exit', slot: x.slot } : null;
    case 'pong': case 'busy': case 'displaced':
      return exact(x, ['t']) ? { t: x.t } : null;
    case 'error':
      return exact(x, ['t', 'code']) && isStr(x.code) && /^[a-z0-9_-]{1,64}$/.test(x.code)
        ? { t: 'error', code: x.code } : null;
    default: return null;
  }
}

// ---- Framing ----
export type FrameError = 'oversize' | 'utf8' | 'json' | 'shape';
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Byte-bounded NDJSON reader. After the first error it is dead: further pushes are ignored. */
export function createFrameReader(onFrame: (frame: Rec) => void, onError: (reason: FrameError) => void):
  { push(chunk: Uint8Array | string): void } {
  let buf: Buffer = Buffer.alloc(0);
  let dead = false;
  const fail = (r: FrameError): void => { dead = true; buf = Buffer.alloc(0); onError(r); };
  return {
    push(chunk) {
      if (dead) return;
      buf = Buffer.concat([buf, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk]);
      for (;;) {
        const end = buf.indexOf(10);
        if (end < 0) { if (buf.length > FRAME_MAX_BYTES) fail('oversize'); return; }
        if (end > FRAME_MAX_BYTES) { fail('oversize'); return; }
        const line = buf.subarray(0, end); buf = buf.subarray(end + 1);
        let parsed: unknown;
        try { parsed = decoder.decode(line); } catch { fail('utf8'); return; }
        try { parsed = JSON.parse(parsed as string); } catch { fail('json'); return; }
        if (!isRec(parsed)) { fail('shape'); return; }
        onFrame(parsed);
        if (dead) return;
      }
    },
  };
}

/** One NDJSON line (with the trailing newline). Throws if the encoded frame exceeds the cap. */
export function encodeFrame(obj: unknown): string {
  const json = JSON.stringify(obj);
  if (typeof json !== 'string' || Buffer.byteLength(json) > FRAME_MAX_BYTES) throw new Error('frame too large');
  return `${json}\n`;
}

// ---- Mutual HMAC ----
export const newNonce = (): string => randomBytes(16).toString('hex');
export const newSecret = (): string => randomBytes(32).toString('hex');

/** HMAC-SHA256(secret, role + "\n" + nonce), hex. Role-bound so a server proof can never pass as a client proof. */
export function signProof(secretHex: string, role: Role, nonceHex: string): string {
  if (!HEX_SECRET.test(secretHex) || !HEX_NONCE.test(nonceHex) || (role !== 'server' && role !== 'client')) {
    throw new Error('bad proof input');
  }
  return createHmac('sha256', Buffer.from(secretHex, 'hex')).update(`${role}\n${nonceHex}`).digest('hex');
}
/** Constant-time check; any malformed input is simply false. */
export function verifyProof(secretHex: string, role: Role, nonceHex: string, proofHex: unknown): boolean {
  if (!isProof(proofHex) || !HEX_SECRET.test(secretHex) || !HEX_NONCE.test(nonceHex)) return false;
  if (role !== 'server' && role !== 'client') return false;
  const want = Buffer.from(signProof(secretHex, role, nonceHex), 'hex');
  return timingSafeEqual(want, Buffer.from(proofHex, 'hex'));
}

// ---- Discovery file ----
export interface Discovery { v: 1; pipe: string; pid: number; startedAt: number; secret: string }
export const encodeDiscovery = (d: Discovery): string =>
  JSON.stringify({ v: 1, pipe: d.pipe, pid: d.pid, startedAt: d.startedAt, secret: d.secret });
export function decodeDiscovery(text: string): Discovery | null {
  let x: unknown;
  try { x = JSON.parse(text); } catch { return null; }
  if (!isRec(x) || !exact(x, ['v', 'pipe', 'pid', 'startedAt', 'secret'])) return null;
  if (x.v !== 1 || !isStr(x.pipe) || x.pipe.length > 256 || !x.pipe.startsWith(PIPE_PREFIX)
    || x.pipe.length === PIPE_PREFIX.length || !isInt(x.pid, 1) || !isInt(x.startedAt, 0)
    || !isStr(x.secret) || !HEX_SECRET.test(x.secret)) return null;
  return { v: 1, pipe: x.pipe, pid: x.pid, startedAt: x.startedAt, secret: x.secret };
}
export function discoveryFileName(userDataPath: string, proto: number): string {
  if (!isInt(proto, 1)) throw new Error('bad proto');
  const key = createHash('sha256').update(userDataPath).digest('hex').slice(0, 8);
  return `pty-owner-${key}-p${proto}.json`;
}
