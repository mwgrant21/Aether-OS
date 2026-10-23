import { readFileSync, statSync } from 'node:fs';
import { writeFileAtomically } from '../atomicWrite';
import type { SessionStorePort, StoredSession } from './types';

// On-disk home of the paired phone sessions. The file holds a digest and three
// timestamps per session and nothing else (plus, for the device file only, a
// tailnet IPv4 `peer`): every read and every write runs each entry through
// pick(), which selects those fields by name AND validates their values (hash
// shape, integer stamps, peer shape), and both directions cap the list
// at MAX_ENTRIES. Extra properties or odd values from a caller cannot reach
// disk. The caller owns the (private) directory.

const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 20;
const HASH_RE = /^[0-9a-f]{64}$/;
const PEER_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function isStamp(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

// Each field is read exactly once into a local and only the locals are
// validated and returned, so a getter or Proxy that answers differently on a
// later read cannot slip a value past the check.
function pick(raw: unknown, withPeer: boolean): StoredSession | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const hash = r.hash;
  const created = r.createdAtMs;
  const expires = r.expiresAtMs;
  const lastSeen = r.lastSeenMs;
  const peer = r.peer;
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) return null;
  if (!isStamp(created) || !isStamp(expires) || !isStamp(lastSeen)) return null;
  if (expires <= created) return null;
  // Viewer file: an entry carrying a peer is a device entry; drop it rather than expose it to the viewer scope.
  if (!withPeer) {
    if (peer !== undefined) return null;
    return { hash, createdAtMs: created, expiresAtMs: expires, lastSeenMs: lastSeen };
  }
  // Device file: an entry without a valid peer is dropped (fail closed).
  if (typeof peer !== 'string' || !PEER_RE.test(peer)) return null;
  return { hash, createdAtMs: created, expiresAtMs: expires, lastSeenMs: lastSeen, peer };
}

export function createSessionStore(filePath: string, opts?: { peer?: boolean }): SessionStorePort {
  const withPeer = opts?.peer === true;
  let chain: Promise<void> = Promise.resolve();

  return {
    load(): StoredSession[] {
      try {
        if (statSync(filePath).size > MAX_BYTES) return [];
        const doc: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
        if (typeof doc !== 'object' || doc === null) return [];
        const d = doc as { v?: unknown; sessions?: unknown };
        if (d.v !== 1 || !Array.isArray(d.sessions)) return [];
        const out: StoredSession[] = [];
        for (const item of d.sessions) {
          const s = pick(item, withPeer);
          if (s) out.push(s);
          if (out.length >= MAX_ENTRIES) break;
        }
        return out;
      } catch {
        return [];
      }
    },

    save(list: StoredSession[]): Promise<void> {
      if (!Array.isArray(list)) return Promise.reject(new TypeError('sessions must be an array'));
      // Snapshot now: nothing the caller does to `list` after this call, and
      // no getter it carries, can change what is written.
      const sessions: StoredSession[] = [];
      for (const item of list) {
        const s = pick(item, withPeer);
        if (s) sessions.push(s);
        if (sessions.length >= MAX_ENTRIES) break;
      }
      const body = JSON.stringify({ v: 1, sessions });
      const run = chain.then(() => writeFileAtomically(filePath, body));
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
