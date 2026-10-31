// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLiveAgentTracker } from './liveAgentTracker';
import { createThreadFeed } from './threadFeed';
import { cwdToProjectDirName } from '../src/state/projectDirName';
import type { ThreadEvent, ThreadTap } from '../src/shared/remote/types';

const LAUNCH = '33333333-3333-3333-3333-333333333333';
const T0 = Date.parse('2026-10-29T10:00:00.000Z');
const u = (text: string, at = T0): string =>
  JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), message: { role: 'user', content: text } }) + '\n';
const clearRecord = JSON.stringify({ type: 'system', commandRun: { command: 'clear' } }) + '\n';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const texts = (evs: readonly ThreadEvent[]): string[] => evs.map((e) => (e.k === 'tool' ? `tool:${e.name}` : `${e.k}:${e.text}`));

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'aether-rollover-'));
  homes.push(home);
  const dir = join(home, '.claude', 'projects', cwdToProjectDirName(home));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${LAUNCH}.jsonl`), u('old text'));
  await sleep(20);
  const tracker = createLiveAgentTracker(home, { rolloverScanIntervalMs: 0 });
  tracker.notifyPtySpawned(1000, LAUNCH);
  await tracker.tick();
  let cb: (() => void) | null = null;
  const feed = createThreadFeed({
    resolveSession: () => {
      const id = tracker.getPinnedSessionId();
      return id ? { sessionId: id, file: join(dir, `${id}.jsonl`) } : null;
    },
    now: () => T0,
    setIntervalFn: (fn) => ((cb = fn), 'h'),
    clearIntervalFn: () => {},
  });
  const snaps: { q: number; events: readonly ThreadEvent[] }[] = [];
  const tap: ThreadTap = { snap: (e) => void snaps.push(e), events: () => {}, state: () => {} };
  feed.attach('claude', tap);
  const pump = async (cond: () => boolean): Promise<void> => {
    const end = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > end) throw new Error('pump timed out');
      cb!();
      await sleep(5);
    }
  };
  await pump(() => snaps.length >= 2);
  return { dir, tracker, snaps, pump };
}

describe('phone Thread across /clear', () => {
  it('phone Thread gets a fresh snapshot of the successor after /clear', async () => {
    const { dir, tracker, snaps, pump } = await setup();
    expect(texts(snaps[snaps.length - 1].events)).toEqual(['user:old text']);
    const before = snaps[snaps.length - 1].q;
    writeFileSync(
      join(dir, 'succ-id.jsonl'),
      clearRecord + JSON.stringify({ type: 'attachment', session_id: LAUNCH }) + '\n' + u('new text', T0 + 1000),
    );
    await tracker.tick();
    expect(tracker.getPinnedSessionId()).toBe('succ-id');
    await pump(() => snaps.length >= 3);
    const s = snaps[2];
    expect(s.q).toBe(before + 1);
    expect(texts(s.events)).toEqual(['user:new text']);
  });

  it('a concurrent unrelated session does not move the Thread feed', async () => {
    const { dir, tracker, snaps, pump } = await setup();
    writeFileSync(join(dir, 'startup-other.jsonl'), u('other text', T0 + 1000));
    await tracker.tick();
    await tracker.tick();
    await pump(() => true);
    await sleep(30);
    expect(tracker.getPinnedSessionId()).toBe(LAUNCH);
    expect(snaps).toHaveLength(2);
    expect(texts(snaps[1].events)).toEqual(['user:old text']);
  });
});
