import { createHash, randomBytes as cryptoRandomBytes, randomInt as cryptoRandomInt, timingSafeEqual } from 'node:crypto';
import {
  REMOTE_MAX_SESSIONS,
  REMOTE_SESSION_TTL_MS,
  type RemoteSessionInfo,
} from '../../src/shared/remote/types';
import type { RemoteAuthGate, SessionStorePort, StoredSession } from './types';

const COOKIE_NAME = 'aether_remote';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 60 * 60 * 1000;
const MAX_CODE_FAILURES = 5;
const LAST_SEEN_PERSIST_MS = 5 * 60 * 1000;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface RemoteAuthOptions {
  now?: () => number;
  randomBytes?: (n: number) => Buffer;
  randomInt?: (max: number) => number;
  store?: SessionStorePort;
  ttlMs?: number;
  maxSessions?: number;
  onChange?: () => void;
}

export interface RemoteAuth extends RemoteAuthGate {
  createPairing(): { code: string; expiresAtMs: number };
  list(): RemoteSessionInfo[];
  revokeAll(): void;
  revokeOne(ref: string): boolean;
  counts(): { sessions: number; pairingActive: boolean };
  /** Resolves true when everything is on disk, false when a save failed. Never rejects. */
  flush(): Promise<boolean>;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function normaliseCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-–]/g, '');
}

function isValidStored(s: unknown): s is StoredSession {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.hash === 'string' && HASH_RE.test(o.hash) &&
    Number.isFinite(o.createdAtMs) && Number.isFinite(o.expiresAtMs) && Number.isFinite(o.lastSeenMs)
  );
}

/** Exactly one `aether_remote` cookie, else undefined. Never throws. */
function readToken(cookieHeader: string | undefined): string | undefined {
  if (typeof cookieHeader !== 'string') return undefined;
  const found: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) found.push(part.slice(eq + 1).trim());
  }
  return found.length === 1 && found[0] ? found[0] : undefined;
}

export function isAllowedHost(hostHeader: string | undefined, boundHostPort: string): boolean {
  return typeof hostHeader === 'string' && hostHeader.toLowerCase() === boundHostPort.toLowerCase();
}

export function isAllowedOrigin(origin: string | undefined | null, boundHostPort: string): boolean {
  return typeof origin === 'string' && origin === `http://${boundHostPort}`;
}

export function createRemoteAuth(opts: RemoteAuthOptions = {}): RemoteAuth {
  const now = opts.now ?? Date.now;
  const rand = opts.randomBytes ?? ((n: number) => cryptoRandomBytes(n));
  const randInt = opts.randomInt ?? ((max: number) => cryptoRandomInt(max));
  const ttlMs = opts.ttlMs ?? REMOTE_SESSION_TTL_MS;
  const maxSessions = opts.maxSessions ?? REMOTE_MAX_SESSIONS;
  const store = opts.store;

  let sessions: StoredSession[] = [];
  const persistedLastSeen = new Map<string, number>();

  // Pairing state lives in memory only.
  let code: { normalised: string; expiresAtMs: number } | null = null;
  let failures = 0;
  let burned = false;

  // Coalesced saving: one save in flight, at most one more queued behind it.
  let inFlight: Promise<void> | null = null;
  let dirty = false;

  function changed(): void {
    try { opts.onChange?.(); } catch { /* listener errors never break auth */ }
  }

  function runSave(): Promise<void> {
    dirty = false;
    const snapshot = sessions.map(s => ({
      hash: s.hash, createdAtMs: s.createdAtMs, expiresAtMs: s.expiresAtMs, lastSeenMs: s.lastSeenMs,
    }));
    let p: Promise<void>;
    try {
      p = Promise.resolve(store!.save(snapshot));
    } catch (e) {
      p = Promise.reject(e);
    }
    let ok = true;
    const tracked: Promise<void> = p.then(
      () => { for (const s of snapshot) persistedLastSeen.set(s.hash, s.lastSeenMs); },
      () => { ok = false; /* swallowed: auth keeps working */ },
    ).then(() => {
      if (!ok) {
        // Stay dirty so the next persist() or flush() retries; no retry loop here.
        dirty = true;
        inFlight = null;
        return undefined;
      }
      if (dirty) return runSave();
      inFlight = null;
      return undefined;
    });
    inFlight = tracked;
    return tracked;
  }

  function persist(): void {
    if (!store) return;
    if (inFlight) { dirty = true; return; }
    void runSave();
  }

  if (store) {
    let loaded: unknown[] = [];
    try {
      const raw = store.load();
      loaded = Array.isArray(raw) ? raw : [];
    } catch {
      loaded = [];
    }
    const t = now();
    sessions = loaded
      .filter(isValidStored)
      .filter(s => s.expiresAtMs > t && s.expiresAtMs > s.createdAtMs)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, maxSessions)
      .map(s => ({ hash: s.hash, createdAtMs: s.createdAtMs, expiresAtMs: s.expiresAtMs, lastSeenMs: s.lastSeenMs }));
    for (const s of sessions) persistedLastSeen.set(s.hash, s.lastSeenMs);
  }

  function activeCode(): typeof code {
    if (code && now() >= code.expiresAtMs) code = null;
    return code;
  }

  function findByHash(hash: string): StoredSession | undefined {
    const want = Buffer.from(hash, 'hex');
    let hit: StoredSession | undefined;
    for (const s of sessions) {
      if (safeEqual(Buffer.from(s.hash, 'hex'), want)) hit = s;
    }
    return hit;
  }

  function removeSession(hash: string): void {
    sessions = sessions.filter(s => s.hash !== hash);
    persistedLastSeen.delete(hash);
  }

  return {
    createPairing() {
      let out = '';
      for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randInt(CODE_ALPHABET.length)];
      const expiresAtMs = now() + CODE_TTL_MS;
      code = { normalised: out, expiresAtMs };
      failures = 0;
      burned = false;
      changed();
      return { code: `${out.slice(0, 4)}-${out.slice(4)}`, expiresAtMs };
    },

    redeem(input: unknown) {
      if (burned) return { ok: false, status: 429 };
      if (typeof input !== 'string') return { ok: false, status: 401 };
      const active = activeCode();
      if (!active) return { ok: false, status: 401 };
      const given = Buffer.from(normaliseCode(input), 'utf8');
      const want = Buffer.from(active.normalised, 'utf8');
      if (!safeEqual(given, want)) {
        failures += 1;
        if (failures >= MAX_CODE_FAILURES) {
          code = null;
          burned = true;
          changed();
        }
        return { ok: false, status: 401 };
      }
      code = null;
      failures = 0;
      const token = rand(32).toString('base64url');
      const t = now();
      sessions.push({ hash: sha256Hex(token), createdAtMs: t, expiresAtMs: t + ttlMs, lastSeenMs: t });
      while (sessions.length > maxSessions) {
        let oldest = 0;
        // The entry just issued is last and is never the eviction candidate.
        for (let i = 1; i < sessions.length - 1; i++) {
          if (sessions[i].createdAtMs < sessions[oldest].createdAtMs) oldest = i;
        }
        removeSession(sessions[oldest].hash);
      }
      persist();
      changed();
      return {
        ok: true,
        cookie: `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}`,
      };
    },

    isAuthenticated(cookieHeader, o) {
      try {
        const token = readToken(cookieHeader);
        if (!token) return false;
        const session = findByHash(sha256Hex(token));
        if (!session) return false;
        const t = now();
        if (t >= session.expiresAtMs) {
          removeSession(session.hash);
          persist();
          changed();
          return false;
        }
        if (o?.touch === true) {
          session.lastSeenMs = t;
          const prior = persistedLastSeen.get(session.hash) ?? 0;
          if (t - prior >= LAST_SEEN_PERSIST_MS) persist();
        }
        return true;
      } catch {
        return false;
      }
    },

    list() {
      return [...sessions]
        .sort((a, b) => b.createdAtMs - a.createdAtMs)
        .map(s => ({
          ref: s.hash.slice(0, 12),
          createdAtMs: s.createdAtMs,
          expiresAtMs: s.expiresAtMs,
          lastSeenMs: s.lastSeenMs,
        }));
    },

    revokeOne(ref: string) {
      if (typeof ref !== 'string' || ref.length === 0) return false;
      const matches = sessions.filter(s => s.hash.slice(0, 12) === ref);
      if (matches.length !== 1) return false;
      removeSession(matches[0].hash);
      persist();
      changed();
      return true;
    },

    revokeAll() {
      sessions = [];
      persistedLastSeen.clear();
      persist();
      changed();
    },

    counts() {
      return { sessions: sessions.length, pairingActive: activeCode() !== null };
    },

    async flush() {
      if (!store) return true;
      if (!inFlight && dirty) void runSave();
      while (inFlight) await inFlight;
      return !dirty;
    },
  };
}
