import { readFileSync, statSync } from 'node:fs';
import { writeFileAtomically } from '../atomicWrite';
import type { SessionStorePort, StoredSession } from './types';

// On-disk home of the paired phone sessions. The file holds a digest and three
// timestamps per session and nothing else: every read and every write picks
// those four fields by name, so a caller that passes extra properties cannot
// get them onto disk. The caller owns the (private) directory.

const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 20;
const HASH_RE = /^[0-9a-f]{64}$/;

function isStamp(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

function pick(raw: unknown): StoredSession | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.hash !== 'string' || !HASH_RE.test(r.hash)) return null;
  if (!isStamp(r.createdAtMs) || !isStamp(r.expiresAtMs) || !isStamp(r.lastSeenMs)) return null;
  if (r.expiresAtMs <= r.createdAtMs) return null;
  return {
    hash: r.hash,
    createdAtMs: r.createdAtMs,
    expiresAtMs: r.expiresAtMs,
    lastSeenMs: r.lastSeenMs,
  };
}

export function createSessionStore(filePath: string): SessionStorePort {
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
          const s = pick(item);
          if (s) out.push(s);
          if (out.length >= MAX_ENTRIES) break;
        }
        return out;
      } catch {
        return [];
      }
    },

    save(list: StoredSession[]): Promise<void> {
      const sessions = list.map((s) => ({
        hash: s.hash,
        createdAtMs: s.createdAtMs,
        expiresAtMs: s.expiresAtMs,
        lastSeenMs: s.lastSeenMs,
      }));
      const body = JSON.stringify({ v: 1, sessions });
      const run = chain.then(() => writeFileAtomically(filePath, body));
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
