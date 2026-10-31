// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createAgentsDiagFeed, type FleetRowIn } from './agentsDiagFeed';
import { createPhoneViewCache } from './phoneViewCache';

const spec = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../protocol/mobile-protocol.json'), 'utf8'));
const roster = (): Record<string, unknown> => JSON.parse(spec.frames.viewSnapAgents).d;
const row = (o: Partial<FleetRowIn> = {}): FleetRowIn => ({ sessionId: 'sess-0001-RAW', pid: 7, projectName: 'C:\\Users\\Jo Doe\\proj\\aether-os', kind: 'interactive', status: 'busy', name: 'worker', startedAtMs: 1000, ...o });
const snapshot = (o: Record<string, unknown> = {}) => ({
  toolCalls: [{ toolUseId: 'LEAK-T', toolName: 'Edit', filePathRel: 'Users\\Jo Doe\\proj\\a.ts', startedAtMs: 1, closedAtMs: 3000 }],
  dispatches: [], anomalies: [], ...o,
});

function setup() {
  const cache = createPhoneViewCache(() => true);
  const feed = createAgentsDiagFeed(cache, { salt: 's1', minGapMs: 0 });
  const got: any[] = [];
  feed.port.attach({ snap: d => { got.push(d); } });
  return { cache, feed, got };
}

describe('agents diag feed', () => {
  it('merges: fleet and timeline are null until the collector is read, then ride the roster; a collector change re-sends', () => {
    const { cache, feed, got } = setup();
    expect(got).toEqual([null]); // no roster published yet
    cache.ingest('agents', roster());
    expect(got[1].fleet).toBeNull();
    expect(got[1].timeline).toBeNull();
    feed.setFleet([row()]);
    feed.setDiagnostics(snapshot());
    const last = got[got.length - 1];
    expect(last.running).toHaveLength(2);
    expect(last.fleet[0]).toMatchObject({ title: 'aether-os', name: 'worker', status: 'busy', kind: 'interactive', pid: 7 });
    expect(last.timeline).toEqual([{ k: 'tool', atMs: 3000, label: 'Edit a.ts', tokens: null, toolUses: null, durationMs: null }]);
  });
  it('null means collector absent, [] means present but empty, and an unchanged reading is not re-sent', () => {
    const { cache, feed, got } = setup();
    cache.ingest('agents', roster());
    feed.setFleet([]);
    feed.setDiagnostics({ toolCalls: [], dispatches: [], anomalies: [] });
    expect([got[got.length - 1].fleet, got[got.length - 1].timeline]).toEqual([[], []]);
    const n = got.length;
    feed.setFleet([]);
    expect(got).toHaveLength(n);
    feed.setFleet(null);
    feed.setDiagnostics(null);
    expect([got[got.length - 1].fleet, got[got.length - 1].timeline]).toEqual([null, null]);
  });
  it('turns a session id into an opaque salted key: no raw id, stable within a run, different under another salt', () => {
    const { cache, feed, got } = setup();
    cache.ingest('agents', roster());
    feed.setFleet([row(), row({ sessionId: 'sess-0002-RAW', startedAtMs: 2000 })]);
    const f = got[got.length - 1].fleet;
    expect(JSON.stringify(got[got.length - 1])).not.toMatch(/sess-000|RAW|Jo Doe|Users/);
    expect(f[0].key).toMatch(/^[0-9a-f]{16}$/);
    expect(f[0].key).not.toBe(f[1].key);
    const cache2 = createPhoneViewCache(() => true);
    const feed2 = createAgentsDiagFeed(cache2, { salt: 's2', minGapMs: 0 });
    const got2: any[] = [];
    feed2.port.attach({ snap: d => { got2.push(d); } });
    cache2.ingest('agents', roster());
    feed2.setFleet([row()]);
    expect(got2[got2.length - 1].fleet[0].key).not.toBe(f[0].key);
  });
  it('no path-bearing collector field reaches the frame: filePathRel directories, source_file_rel, cwd, ids', () => {
    const { cache, feed, got } = setup();
    cache.ingest('agents', roster());
    feed.setFleet([{ ...row(), cwd: 'C:\\LEAK\\cwd' } as FleetRowIn]);
    feed.setDiagnostics(snapshot({ toolCalls: [{ toolUseId: 'LEAK-T', toolName: 'Read', filePathRel: 'C--Users-LEAK\\sub dir\\x.ts', source_file_rel: 'C--Users-Matt-LEAK/y.jsonl', startedAtMs: 1, closedAtMs: 3000 }], anomalies: [{ kind: 'reReadLoop', toolUseId: 'LEAK-A', detail: 'C:\\Users\\Jo Doe\\LEAK\\z.ts read 3 times', detectedAtMs: 4000 }] }));
    const json = JSON.stringify(got[got.length - 1]);
    expect(json).not.toMatch(/LEAK|Jo Doe|sub dir|source_file|sess-0001/);
    expect(json).toContain('Read x.ts');
    expect(json).toContain('z.ts read 3 times');
  });
  it('a throwing encode input fails closed to null for that source and never throws', () => {
    const { cache, feed, got } = setup();
    cache.ingest('agents', roster());
    expect(() => feed.setFleet({ get length(): number { throw new Error('boom'); } } as any)).not.toThrow();
    expect(() => feed.setDiagnostics({ get toolCalls(): unknown { throw new Error('boom'); } })).not.toThrow();
    expect([got[got.length - 1].fleet, got[got.length - 1].timeline]).toEqual([null, null]);
  });
  it('retention is inert while the gate is off, and starts once it flips on', () => {
    let on = false;
    const cache = createPhoneViewCache(() => true);
    const feed = createAgentsDiagFeed(cache, { salt: 's1', minGapMs: 0, gate: () => on });
    const got: any[] = [];
    feed.port.attach({ snap: d => { got.push(d); } });
    cache.ingest('agents', roster());
    feed.setFleet([row()]);
    feed.setDiagnostics(snapshot());
    expect([got[got.length - 1].fleet, got[got.length - 1].timeline]).toEqual([null, null]);
    on = true;
    feed.setFleet([row()]);
    feed.setDiagnostics(snapshot());
    expect(got[got.length - 1].fleet).toHaveLength(1);
    expect(got[got.length - 1].timeline).toHaveLength(1);
    feed.clear();
    on = false;
    feed.setFleet([row()]);
    expect([got[got.length - 1].fleet, got[got.length - 1].timeline]).toEqual([null, null]);
  });
  it('clear() forgets the encoded fleet and timeline and tells attached taps', () => {
    const { cache, feed, got } = setup();
    cache.ingest('agents', roster());
    feed.setFleet([row()]);
    feed.setDiagnostics(snapshot());
    feed.clear();
    expect([got[got.length - 1].fleet, got[got.length - 1].timeline]).toEqual([null, null]);
  });
  it('clearing the roster cache sends null; the feed holds no roster of its own', () => {
    const { cache, feed, got } = setup();
    cache.ingest('agents', roster());
    feed.setFleet([row()]);
    cache.clear();
    expect(got[got.length - 1]).toBeNull();
  });
});
