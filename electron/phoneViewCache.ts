// In-memory store for renderer-derived phone view payloads (privacy section 17). The renderer hands main its derived
// payloads; this holds only the latest one per view id, and only while phone control is on. Nothing is written to disk
// or diag.log. ingest() is inert while the gate says control is off, and clear() empties everything (called on control
// disable and at quit). A payload is re-validated by the view's encoder before it reaches a phone; the cache only bounds it.
import { VIEW_IDS, type ViewId, type ViewReadPort, type ViewTap } from '../src/shared/remote/types';

/** Serialised (UTF-8 JSON) size cap per payload. */
export const PHONE_VIEW_MAX_BYTES = 128 * 1024;
/** Minimum gap between sends to one tap. */
export const PHONE_VIEW_MIN_GAP_MS = 1000;

export type PhoneViewPayload = Record<string, unknown>;

export interface PhoneViewCache {
  /** Stores the payload as the latest for v. Returns false (and stores nothing) when control is off, v is unknown, the payload is not a plain object, is not serialisable, or exceeds the cap. */
  ingest(v: string, payload: unknown): boolean;
  get(v: ViewId): PhoneViewPayload | undefined;
  /** Drops every payload and notifies listeners once per view that held one. */
  clear(): void;
  onChange(cb: (v: ViewId) => void): () => void;
}

const isPlainObject = (x: unknown): x is PhoneViewPayload => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};

export function createPhoneViewCache(gate: () => boolean): PhoneViewCache {
  const held = new Map<ViewId, PhoneViewPayload>();
  const listeners = new Set<(v: ViewId) => void>();
  const emit = (v: ViewId): void => {
    for (const cb of [...listeners]) {
      try { cb(v); } catch { /* a failing listener must not break the others */ }
    }
  };
  return {
    ingest(v, payload) {
      if (!gate()) return false;
      if (!(VIEW_IDS as readonly string[]).includes(v) || !isPlainObject(payload)) return false;
      let json: string;
      try { json = JSON.stringify(payload); } catch { return false; }
      if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > PHONE_VIEW_MAX_BYTES) return false;
      held.set(v as ViewId, payload);
      emit(v as ViewId);
      return true;
    },
    get: v => held.get(v),
    clear() {
      const ids = [...held.keys()];
      held.clear();
      for (const v of ids) emit(v);
    },
    onChange(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
}

/**
 * ViewReadPort over the cache. attach() delivers the current state synchronously (encode(payload), or null when
 * nothing is held or encode returns null/throws), then each change, at most one send per minGapMs per tap: a change
 * inside the gap is sent once the gap ends, carrying the latest value. An emptied cache is delivered at once as null.
 * The feed holds nothing but its taps.
 */
export function createCacheViewFeed(
  cache: PhoneViewCache,
  view: ViewId,
  encode: (payload: PhoneViewPayload) => unknown,
  opts: { now?: () => number; minGapMs?: number } = {},
): ViewReadPort {
  const now = opts.now ?? Date.now;
  const gap = opts.minGapMs ?? PHONE_VIEW_MIN_GAP_MS;
  const current = (): unknown => {
    const p = cache.get(view);
    if (!p) return null;
    try { return encode(p) ?? null; } catch { return null; }
  };
  return {
    attach(tap: ViewTap) {
      let lastSent = Number.NEGATIVE_INFINITY;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let live = true;
      const send = (): void => {
        if (!live) return;
        lastSent = now();
        try { tap.snap(current()); } catch { /* a failing tap must not escape */ }
      };
      send();
      const off = cache.onChange(v => {
        if (v !== view || !live) return;
        if (!cache.get(view)) {
          if (timer) { clearTimeout(timer); timer = null; }
          send();
          return;
        }
        if (timer) return; // a send is already scheduled and will carry the latest value
        const wait = lastSent + gap - now();
        if (wait <= 0) send();
        else {
          timer = setTimeout(() => { timer = null; send(); }, wait);
          timer.unref?.();
        }
      });
      return {
        detach() {
          live = false;
          off();
          if (timer) { clearTimeout(timer); timer = null; }
        },
      };
    },
  };
}
