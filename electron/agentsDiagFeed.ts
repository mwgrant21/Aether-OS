// Phone Agents view feed (privacy section 17). The `agents` view has two sources: the renderer-fed roster, held by the
// phone view cache, and the collector-fed fleet and timeline, set here from the same reads the desktop cards use
// (readFleetSessions / readDiagnostics, called by main's scans). This feed merges them: it wraps the cache so a change in
// either source re-sends through createCacheViewFeed (same attach-now, one send per gap behaviour), and encodes with the
// single encodeAgentsView. It keeps only the ENCODED fleet and timeline (at most 50 and 60 rows, masked, capped, no paths,
// no session ids); the raw collector rows are dropped as soon as they are encoded. A fleet session id never leaves this
// file: it becomes an opaque key, a salted hash that differs on every app run. Lives outside electron/control/ (hashing
// needs node:crypto, which the control boundary does not allow there). Nothing is logged or written.
import { createHash, randomBytes } from 'node:crypto';
import type { ViewReadPort } from '../src/shared/remote/types';
import { createCacheViewFeed, type PhoneViewCache } from './phoneViewCache';
import { encodeAgentsView, encodeFleetRows, encodeTimelineRows, type AgentsDiagWire } from './control/viewWire';

/** The fields of a collector fleet row this feed reads (structural, so the control boundary needs no collector import). */
export interface FleetRowIn {
  sessionId: string;
  pid: number | null;
  projectName: string;
  kind: string;
  status: string;
  name: string;
  startedAtMs: number;
}

export interface AgentsDiagFeed {
  port: ViewReadPort;
  /** rows from readFleetSessions, or null when the collector is absent or stale. */
  setFleet(rows: readonly FleetRowIn[] | null): void;
  /** snapshot from readDiagnostics (structurally a DiagnosticsSnapshot), or null when the collector is absent or stale. */
  setDiagnostics(snap: unknown): void;
}

export function createAgentsDiagFeed(cache: PhoneViewCache, opts: { salt?: string; now?: () => number; minGapMs?: number } = {}): AgentsDiagFeed {
  const salt = opts.salt ?? randomBytes(16).toString('hex');
  let diag: AgentsDiagWire = { fleet: null, timeline: null };
  const listeners = new Set<(v: 'agents') => void>();
  const changed = (): void => {
    for (const cb of [...listeners]) {
      try { cb('agents'); } catch { /* a failing listener must not break the others */ }
    }
  };
  // The roster cache plus this feed's own change signal. get() is the roster alone; its absence still means "no data".
  const merged: PhoneViewCache = {
    ...cache,
    onChange(cb) {
      const off = cache.onChange(cb);
      listeners.add(cb as (v: 'agents') => void);
      return () => { off(); listeners.delete(cb as (v: 'agents') => void); };
    },
  };
  const update = (next: AgentsDiagWire): void => {
    if (JSON.stringify(next) === JSON.stringify(diag)) return;
    diag = next;
    changed();
  };
  return {
    port: createCacheViewFeed(merged, 'agents', p => encodeAgentsView(p, diag), { now: opts.now, minGapMs: opts.minGapMs }),
    setFleet(rows) {
      let fleet: AgentsDiagWire['fleet'] = null;
      try {
        if (rows) {
          fleet = encodeFleetRows(rows.map(r => ({ key: createHash('sha256').update(`${salt}\0${r.sessionId}`).digest('hex').slice(0, 16), projectName: r.projectName, name: r.name, startedAtMs: r.startedAtMs, status: r.status, kind: r.kind, pid: r.pid })));
        }
      } catch { fleet = null; }
      update({ fleet, timeline: diag.timeline });
    },
    setDiagnostics(snap) {
      let timeline: AgentsDiagWire['timeline'] = null;
      try { timeline = snap ? encodeTimelineRows(snap) : null; } catch { timeline = null; }
      update({ fleet: diag.fleet, timeline });
    },
  };
}
