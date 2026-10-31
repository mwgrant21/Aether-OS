// @vitest-environment node
import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createThreadFeed } from './threadFeed';
import { THREAD_SNAPSHOT_MAX_BYTES, THREAD_SNAPSHOT_MAX_EVENTS, THREAD_WORKING_STALE_MS, type ThreadEvent, type ThreadTap } from '../src/shared/remote/types';

const T0 = Date.parse('2026-10-28T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const u = (text: string, at = T0): string => JSON.stringify({ type: 'user', timestamp: iso(at), message: { role: 'user', content: text } }) + '\n';
const a = (text: string, stop: string | undefined, at = T0): string =>
  JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] } }) + '\n';
const tl = (name: string, at = T0): string =>
  JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name, input: {} }] } }) + '\n';
const result = (at = T0): string =>
  JSON.stringify({ type: 'user', timestamp: iso(at), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } }) + '\n';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

let dir: string;
let file: string;
let sid: string | null;
let clock: number;
let cb: (() => void) | null;
let created: number;
let cleared: unknown[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'threadfeed-'));
  file = join(dir, 'a.jsonl');
  sid = 's1';
  clock = T0;
  cb = null;
  created = 0;
  cleared = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Sets the file mtime to the injected clock so an attach-time "last growth" is deterministic.
const stamp = (ms = clock): void => utimesSync(file, ms / 1000, ms / 1000);
const write = (s: string, ms = clock): void => {
  writeFileSync(file, s);
  stamp(ms);
};

function make(over: Partial<Parameters<typeof createThreadFeed>[0]> = {}) {
  const logs: string[] = [];
  const feed = createThreadFeed({
    resolveSession: () => (sid ? { sessionId: sid, file } : null),
    now: () => clock,
    setIntervalFn: (fn) => ((cb = fn), (created++, 'h')),
    clearIntervalFn: (h) => void cleared.push(h),
    log: (l) => logs.push(l),
    ...over,
  });
  return { feed, logs };
}

type Frame =
  | { f: 'snap'; q: number; attached: boolean; working: boolean; workingSinceMs: number | null; events: readonly ThreadEvent[] }
  | { f: 'events'; q: number; events: readonly ThreadEvent[] }
  | { f: 'state'; q: number; working: boolean; workingSinceMs: number | null };
function recorder(): { tap: ThreadTap; frames: Frame[] } {
  const frames: Frame[] = [];
  return {
    frames,
    tap: {
      snap: (e) => void frames.push({ f: 'snap', ...e }),
      events: (e) => void frames.push({ f: 'events', ...e }),
      state: (e) => void frames.push({ f: 'state', ...e }),
    },
  };
}
const snaps = (fr: Frame[]) => fr.filter((x): x is Extract<Frame, { f: 'snap' }> => x.f === 'snap');
const texts = (evs: readonly ThreadEvent[]): string[] => evs.map((e) => (e.k === 'tool' ? `tool:${e.name}` : `${e.k}:${e.text}`));
// Fires the poll callback until cond() holds (an overlapping fire is a no-op while one is in flight).
const pump = (cond: () => boolean): Promise<void> =>
  waitFor(() => {
    cb!();
    return cond();
  });
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) {
    cb!();
    await sleep(5);
  }
};

describe('attach and ordering', () => {
  it('delivers a snap synchronously inside attach, then a seeded snap with q+1', async () => {
    write(u('hello') + a('hi', 'end_turn', T0 + 1000));
    const { feed } = make();
    const r = recorder();
    feed.attach('claude', r.tap);
    expect(r.frames).toHaveLength(1); // synchronous: nothing has been read yet
    expect(r.frames[0]).toMatchObject({ f: 'snap', q: 0, attached: false, events: [] });
    await waitFor(() => r.frames.length >= 2);
    const s = r.frames[1] as Extract<Frame, { f: 'snap' }>;
    expect(s).toMatchObject({ f: 'snap', q: 1, attached: true, working: false, workingSinceMs: null });
    expect(texts(s.events)).toEqual(['user:hello', 'claude:hi']);
  });

  it('a second attach gets the current ring immediately, before any live frame', async () => {
    write(u('one'));
    const { feed } = make();
    const r1 = recorder();
    feed.attach('claude', r1.tap);
    await waitFor(() => r1.frames.length >= 2);
    const r2 = recorder();
    feed.attach('claude', r2.tap);
    expect(r2.frames).toHaveLength(1);
    expect(r2.frames[0]).toMatchObject({ f: 'snap', q: 1, attached: true });
    expect(texts((r2.frames[0] as Extract<Frame, { f: 'snap' }>).events)).toEqual(['user:one']);
  });

  it('live lines arrive as one events frame per poll batch; q is strictly +1 per frame', async () => {
    write(u('one'));
    const { feed } = make();
    const r = recorder();
    feed.attach('claude', r.tap);
    await waitFor(() => r.frames.length >= 2);
    appendFileSync(file, a('two', 'tool_use', T0 + 1000) + tl('Bash', T0 + 2000));
    clock += 2000;
    await pump(() => r.frames.some((f) => f.f === 'events'));
    const ev = r.frames.find((f) => f.f === 'events') as Extract<Frame, { f: 'events' }>;
    expect(texts(ev.events)).toEqual(['claude:two', 'tool:Bash']);
    await settle();
    const qs = r.frames.map((f) => f.q);
    expect(qs.slice(1)).toEqual(qs.slice(1).map((_, i) => qs[1] + i)); // consecutive after the attach snap
    for (let i = 2; i < qs.length; i++) expect(qs[i]).toBe(qs[i - 1] + 1);
  });

  it('tool_result lines emit no event frame', async () => {
    write(u('one'));
    const { feed } = make();
    const r = recorder();
    feed.attach('claude', r.tap);
    await waitFor(() => r.frames.length >= 2);
    appendFileSync(file, result());
    await settle();
    expect(r.frames.filter((f) => f.f === 'events')).toHaveLength(0);
  });
});

describe('working state (D4)', () => {
  it('true while the last mark is busy and the file is fresh; since = the streak start', async () => {
    write(u('go', T0) + tl('Bash', T0 + 1000) + result(T0 + 2000));
    const { feed } = make();
    const r = recorder();
    feed.attach('claude', r.tap);
    await waitFor(() => snaps(r.frames).length >= 2);
    expect(snaps(r.frames)[1]).toMatchObject({ working: true, workingSinceMs: T0 });
  });

  it('stays working across tool_result lines, flips to idle on the final assistant text', async () => {
    write(u('go', T0));
    const { feed } = make();
    const r = recorder();
    feed.attach('claude', r.tap);
    await waitFor(() => snaps(r.frames).length >= 2);
    appendFileSync(file, tl('Bash', T0 + 1000) + result(T0 + 2000));
    clock = T0 + 2000;
    await pump(() => r.frames.some((f) => f.f === 'events'));
    await settle();
    expect(r.frames.filter((f) => f.f === 'state')).toHaveLength(0); // never left working
    appendFileSync(file, a('Unit tests pass.', 'end_turn', T0 + 3000));
    clock = T0 + 3000;
    await pump(() => r.frames.some((f) => f.f === 'state'));
    expect(r.frames.find((f) => f.f === 'state')).toMatchObject({ working: false, workingSinceMs: null });
  });

  it('mid-turn assistant text (stop_reason tool_use) does not flip to idle', async () => {
    write(u('go', T0) + a('looking', 'tool_use', T0 + 1000));
    const { feed } = make();
    const r = recorder();
    feed.attach('claude', r.tap);
    await waitFor(() => snaps(r.frames).length >= 2);
    expect(snaps(r.frames)[1]).toMatchObject({ working: true, workingSinceMs: T0 });
  });

  it('an interrupt marker ends the turn', async () => {
    write(u('go', T0));
    const { feed } = make();
    const r = recorder();
    feed.attach('claude', r.tap);
    await waitFor(() => snaps(r.frames).length >= 2);
    appendFileSync(file, u('[Request interrupted by user]', T0 + 500));
    clock = T0 + 500;
    await pump(() => r.frames.some((f) => f.f === 'state'));
    expect(r.frames.find((f) => f.f === 'state')).toMatchObject({ working: false });
  });

  it('goes stale after THREAD_WORKING_STALE_MS without growth, emitting state once', async () => {
    write(u('go', T0));
    const { feed } = make();
    const r = recorder();
    feed.attach('claude', r.tap);
    await waitFor(() => snaps(r.frames).length >= 2);
    clock = T0 + THREAD_WORKING_STALE_MS; // exactly at the limit: still working
    await settle();
    expect(r.frames.filter((f) => f.f === 'state')).toHaveLength(0);
    clock = T0 + THREAD_WORKING_STALE_MS + 1;
    await pump(() => r.frames.some((f) => f.f === 'state'));
    await settle();
    expect(r.frames.filter((f) => f.f === 'state')).toEqual([{ f: 'state', q: 2, working: false, workingSinceMs: null }]);
  });

  it('a stale file at attach time starts not-working', async () => {
    write(u('go', T0), T0 - 10 * 60 * 1000);
    const { feed } = make();
    const r = recorder();
    feed.attach('claude', r.tap);
    await waitFor(() => snaps(r.frames).length >= 2);
    expect(snaps(r.frames)[1]).toMatchObject({ working: false, workingSinceMs: null });
  });
});

describe('lifecycle', () => {
  it('polls only while attached: the last detach clears the timer and the ring', async () => {
    write(u('one'));
    const { feed } = make();
    expect(created).toBe(0);
    const r1 = recorder();
    const h1 = feed.attach('claude', r1.tap);
    const r2 = recorder();
    const h2 = feed.attach('claude', r2.tap);
    expect(created).toBe(1);
    await waitFor(() => r1.frames.length >= 2);
    h1.detach();
    expect(cleared).toHaveLength(0);
    h2.detach();
    h2.detach(); // idempotent
    expect(cleared).toEqual(['h']);
    const r3 = recorder();
    feed.attach('claude', r3.tap);
    expect(r3.frames[0]).toMatchObject({ f: 'snap', attached: false, working: false, events: [] }); // ring was dropped
    expect(created).toBe(2);
  });

  it('a session-id change resets the ring and emits a fresh snap with q+1', async () => {
    write(u('old'));
    const { feed } = make();
    const r = recorder();
    feed.attach('claude', r.tap);
    await waitFor(() => snaps(r.frames).length >= 2);
    const before = r.frames[r.frames.length - 1].q;
    sid = 's2';
    file = join(dir, 'b.jsonl');
    write(u('new'));
    await pump(() => snaps(r.frames).length >= 3);
    const s = snaps(r.frames)[2];
    expect(s.q).toBe(before + 1);
    expect(texts(s.events)).toEqual(['user:new']);
  });

  it('a truncated file re-snaps from the start', async () => {
    write(u('first') + u('second'));
    const { feed } = make();
    const r = recorder();
    feed.attach('claude', r.tap);
    await waitFor(() => snaps(r.frames).length >= 2);
    truncateSync(file, 0);
    appendFileSync(file, u('x'));
    await pump(() => snaps(r.frames).length >= 3);
    expect(texts(snaps(r.frames)[2].events)).toEqual(['user:x']);
  });

  it('a replaced file (same path, new inode) re-snaps', async () => {
    write(u('first') + u('second') + u('third'));
    const { feed } = make();
    const r = recorder();
    feed.attach('claude', r.tap);
    await waitFor(() => snaps(r.frames).length >= 2);
    const other = join(dir, 'other.jsonl');
    writeFileSync(other, u('swapped') + u('swapped2') + u('swapped3') + u('swapped4'));
    renameSync(other, file);
    await pump(() => snaps(r.frames).length >= 3);
    expect(texts(snaps(r.frames)[2].events)).toEqual(['user:swapped', 'user:swapped2', 'user:swapped3', 'user:swapped4']);
  });

  it('a line over 1 MiB is discarded without stopping the feed', async () => {
    write(u('before'));
    const { feed } = make();
    const r = recorder();
    feed.attach('claude', r.tap);
    await waitFor(() => snaps(r.frames).length >= 2);
    appendFileSync(file, u('x'.repeat(1024 * 1024 + 10)));
    appendFileSync(file, u('after'));
    await pump(() => r.frames.some((f) => f.f === 'events'));
    const all = r.frames.flatMap((f) => (f.f === 'events' ? texts(f.events) : []));
    expect(all).toEqual(['user:after']);
  });

  it('unreadable transcript is logged once with a fixed string and the feed keeps going', async () => {
    const { feed, logs } = make();
    const r = recorder();
    feed.attach('claude', r.tap); // file does not exist yet
    await waitFor(() => snaps(r.frames).length >= 2);
    expect(snaps(r.frames)[1]).toMatchObject({ attached: true, events: [] });
    await settle();
    expect(logs).toEqual(['control: thread transcript unreadable']);
    write(u('late'));
    await pump(() => r.frames.some((f) => f.f === 'events'));
  });
});

describe('snapshot bounds', () => {
  it('serves at most THREAD_SNAPSHOT_MAX_EVENTS events', async () => {
    write(Array.from({ length: THREAD_SNAPSHOT_MAX_EVENTS + 50 }, (_, i) => u(`m${i}`)).join(''));
    const { feed } = make();
    const r = recorder();
    feed.attach('claude', r.tap);
    await waitFor(() => snaps(r.frames).length >= 2);
    const ev = snaps(r.frames)[1].events;
    expect(ev).toHaveLength(THREAD_SNAPSHOT_MAX_EVENTS);
    expect((ev[ev.length - 1] as { text: string }).text).toBe(`m${THREAD_SNAPSHOT_MAX_EVENTS + 49}`);
  });

  it('drops oldest events until the snap fits THREAD_SNAPSHOT_MAX_BYTES', async () => {
    write(Array.from({ length: 60 }, (_, i) => u(`${i}`.padEnd(7000, 'z'))).join(''));
    const { feed } = make();
    const r = recorder();
    feed.attach('claude', r.tap);
    await waitFor(() => snaps(r.frames).length >= 2);
    const ev = snaps(r.frames)[1].events;
    expect(JSON.stringify(ev).length).toBeLessThanOrEqual(THREAD_SNAPSHOT_MAX_BYTES);
    expect(ev.length).toBeLessThan(60);
    expect((ev[ev.length - 1] as { text: string }).text.startsWith('59')).toBe(true);
  });
});

describe('throwing taps', () => {
  it('a tap whose snap throws is not registered: no timer is started and nothing leaks', async () => {
    write(u('one'));
    const { feed } = make();
    const bad: ThreadTap = { snap: () => { throw new Error('socket dead'); }, events: () => {}, state: () => {} };
    const h = feed.attach('claude', bad);
    expect(created).toBe(0);
    h.detach(); // safe no-op
    expect(cleared).toHaveLength(0);
    // a later good tap still works and the dead one never receives anything
    const r = recorder();
    feed.attach('claude', r.tap);
    expect(created).toBe(1);
    await waitFor(() => snaps(r.frames).length >= 2);
  });

  it('a tap that throws on a live frame is dropped without disturbing the others', async () => {
    write(u('one'));
    const { feed } = make();
    let badCalls = 0;
    const bad: ThreadTap = {
      snap: () => {},
      events: () => { badCalls++; throw new Error('dead'); },
      state: () => { badCalls++; throw new Error('dead'); },
    };
    const good = recorder();
    feed.attach('claude', good.tap);
    feed.attach('claude', bad);
    await waitFor(() => snaps(good.frames).length >= 2);
    appendFileSync(file, u('two'));
    await pump(() => good.frames.some((f) => f.f === 'events'));
    appendFileSync(file, u('three'));
    await pump(() => good.frames.filter((f) => f.f === 'events').length >= 2);
    expect(badCalls).toBe(1); // dropped after its first throw
  });

  it('when the only tap throws on a live frame the feed stops itself', async () => {
    write(u('one'));
    const { feed } = make();
    let live = false;
    const bad: ThreadTap = {
      snap: () => { if (live) throw new Error('dead'); },
      events: () => { throw new Error('dead'); },
      state: () => { throw new Error('dead'); },
    };
    feed.attach('claude', bad);
    await settle();
    expect(created).toBe(1);
    live = true;
    appendFileSync(file, u('two'));
    await pump(() => cleared.length === 1);
  });
});
