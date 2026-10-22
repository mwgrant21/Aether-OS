// @vitest-environment node
import { readFileSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatFeed } from './chatFeed';
import { createReplayBuffer } from './replayBuffer';
import type { ChatEvent, ServerMessage } from './types';

const TS = '2026-10-21T10:00:00.000Z';
const KEY = 'sk-ant-api03-' + 'A1b2C3d4'.repeat(5);
const u = (text: string): string => JSON.stringify({ type: 'user', timestamp: TS, message: { role: 'user', content: text } }) + '\n';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let dir: string;
let file: string;
let sid: string | null;
let cb: (() => void) | null;
let cleared: unknown[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chatfeed-'));
  file = join(dir, 'a.jsonl');
  sid = 's1';
  cb = null;
  cleared = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function make(over: Partial<Parameters<typeof createChatFeed>[0]> = {}) {
  const logs: string[] = [];
  const buffer = createReplayBuffer();
  const feed = createChatFeed({
    resolveSession: () => (sid ? { sessionId: sid, file } : null),
    readTitle: async () => 'T',
    setIntervalFn: (fn) => ((cb = fn), 'h'),
    clearIntervalFn: (h) => void cleared.push(h),
    log: (l) => logs.push(l),
    buffer,
    ...over,
  });
  return { feed, buffer, logs };
}
const tick = async (): Promise<void> => {
  cb!();
  await sleep(120);
};
const texts = (evs: ChatEvent[]): string[] => evs.map((e) => (e.k === 'msg' ? e.text : e.text));
function collect(feed: ReturnType<typeof make>['feed']) {
  const msgs: ServerMessage[] = [];
  const j = feed.join((m) => msgs.push(m));
  const history = () => [...msgs].reverse().find((m) => m.t === 'history') as Extract<ServerMessage, { t: 'history' }> | undefined;
  const live = () => msgs.filter((m) => m.t === 'event').map((m) => (m as Extract<ServerMessage, { t: 'event' }>).event);
  return { msgs, j, history, live };
}

describe('chatFeed', () => {
  it('joins before any session with attached:false and empty history, synchronously', () => {
    const { feed } = make();
    const c = collect(feed);
    expect(c.msgs).toEqual([{ t: 'session', attached: false, title: null }, { t: 'history', events: [] }]);
  });

  it('seeds from the tail of a file larger than seedBytes at a line boundary', async () => {
    let s = '';
    for (let i = 0; i < 200; i++) s += u(`message number ${i} ${'x'.repeat(50)}`);
    writeFileSync(file, s);
    const { feed } = make({ seedBytes: 2000 });
    feed.start();
    await sleep(120);
    const c = collect(feed);
    const t = texts(c.history()!.events);
    expect(t.length).toBeGreaterThan(5);
    expect(t.length).toBeLessThan(200);
    expect(t[t.length - 1]).toMatch(/^message number 199 /);
    expect(t[0]).toMatch(/^message number \d+ x{50}$/); // whole line, not a cut-off one
    expect(c.msgs[0]).toEqual({ t: 'session', attached: true, title: 'T' });
    feed.stop();
  });

  it('delivers appended lines as ordered events and holds a partial last line until its newline', async () => {
    writeFileSync(file, u('one'));
    const { feed } = make();
    feed.start();
    await sleep(120);
    const c = collect(feed);
    appendFileSync(file, u('two') + u('three').slice(0, 30));
    await tick();
    expect(texts(c.live())).toEqual(['two']);
    appendFileSync(file, u('three').slice(30) + u('four'));
    await tick();
    expect(texts(c.live())).toEqual(['two', 'three', 'four']);
    feed.stop();
  });

  it('a join between two appends gets each event exactly once across history and live', async () => {
    writeFileSync(file, u('a'));
    const { feed } = make();
    feed.start();
    await sleep(120);
    appendFileSync(file, u('b'));
    await tick();
    const c = collect(feed); // joins after b was consumed, before c is appended
    appendFileSync(file, u('c'));
    await tick();
    const all = [...c.history()!.events, ...c.live()];
    expect(texts(all)).toEqual(['a', 'b', 'c']);
    expect(new Set(all.map((e) => e.id)).size).toBe(3);
    feed.stop();
  });

  it('lines appended while the seed read is in flight are neither lost nor duplicated', async () => {
    writeFileSync(file, u('a') + u('b'));
    const realOpen = fsp.open.bind(fsp);
    let appended = false;
    vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const fh = await realOpen(...args);
      if (!appended) {
        appended = true;
        appendFileSync(file, u('late'));
      }
      return fh;
    });
    const { feed } = make();
    const c = collect(feed);
    feed.start();
    await sleep(120);
    await tick();
    const all = [...c.history()!.events, ...c.live()];
    expect(texts(all)).toEqual(['a', 'b', 'late']);
    feed.stop();
  });

  it('a session switch clears the buffer and re-announces with none of the old events', async () => {
    writeFileSync(file, u('old'));
    const file2 = join(dir, 'b.jsonl');
    writeFileSync(file2, u('fresh'));
    let cur = { sessionId: 's1', file };
    const { feed, buffer } = make({ resolveSession: () => cur });
    feed.start();
    await sleep(120);
    const c = collect(feed);
    cur = { sessionId: 's2', file: file2 };
    await tick();
    expect(texts(c.history()!.events)).toEqual(['fresh']);
    expect(texts(buffer.snapshot())).toEqual(['fresh']);
    feed.stop();
  });

  it('re-seeds when the file is truncated', async () => {
    writeFileSync(file, u('one') + u('two') + u('three'));
    const { feed } = make();
    feed.start();
    await sleep(120);
    const c = collect(feed);
    writeFileSync(file, u('n'));
    await tick();
    expect(texts(c.history()!.events)).toEqual(['n']);
    feed.stop();
  });

  it('a transcript that does not exist yet attaches empty, logs once, and picks the file up when it appears', async () => {
    const { feed, logs } = make();
    feed.start();
    await sleep(120);
    await tick();
    expect(logs).toEqual(['remote: transcript unreadable']);
    const c = collect(feed);
    expect(c.msgs[0]).toMatchObject({ t: 'session', attached: true });
    writeFileSync(file, u('hello'));
    await tick();
    expect(texts(c.live())).toEqual(['hello']);
    feed.stop();
  });

  it('a resolver returning null reports attached:false', async () => {
    writeFileSync(file, u('x'));
    const { feed } = make();
    feed.start();
    await sleep(120);
    const c = collect(feed);
    sid = null;
    await tick();
    expect(c.msgs.slice(-2)).toEqual([{ t: 'session', attached: false, title: null }, { t: 'history', events: [] }]);
    feed.stop();
  });

  it('jumps to the tail, at a line boundary, when more than maxReadBytes was appended', async () => {
    writeFileSync(file, u('first'));
    const { feed } = make({ maxReadBytes: 1000 });
    feed.start();
    await sleep(120);
    const c = collect(feed);
    let s = '';
    for (let i = 0; i < 100; i++) s += u(`line ${i} ${'y'.repeat(40)}`);
    appendFileSync(file, s);
    await tick();
    const t = texts(c.live());
    expect(t.length).toBeGreaterThan(3);
    expect(t[t.length - 1]).toMatch(/^line 99 /);
    for (const x of t) expect(x).toMatch(/^line \d+ y{40}$/);
    feed.stop();
  });

  it('never exposes seeded secrets in the buffer, history or events, and stays under 64 KB', async () => {
    let s = '';
    for (let i = 0; i < 1500; i++) s += u(`note ${i} ${KEY} password=hunter2hunter2 ${'z'.repeat(150)}`);
    writeFileSync(file, s);
    expect(s.length).toBeGreaterThan(300 * 1024);
    const { feed, buffer } = make();
    feed.start();
    await sleep(100);
    const c = collect(feed);
    appendFileSync(file, u(`live ${KEY} password=hunter2hunter2`));
    await tick();
    expect(buffer.bytes).toBeLessThanOrEqual(65536);
    const dump = JSON.stringify([buffer.snapshot(), c.msgs]);
    expect(dump).toContain('[redacted]');
    expect(dump).not.toMatch(/sk-ant|hunter2/);
    feed.stop();
  });

  it('treats pushed events as immutable', async () => {
    writeFileSync(file, u('a'));
    const { feed, buffer } = make();
    feed.start();
    await sleep(120);
    const [e] = buffer.snapshot();
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as { text: string }).text = 'changed';
    }).toThrow();
    feed.stop();
  });

  it('stop() clears the timer and buffer, drops listeners, and does no further stat', async () => {
    writeFileSync(file, u('a'));
    const { feed, buffer } = make();
    feed.start();
    await sleep(120);
    const c = collect(feed);
    const stat = vi.spyOn(fsp, 'stat');
    feed.stop();
    expect(cleared).toEqual(['h']);
    expect(buffer.snapshot()).toEqual([]);
    cb!();
    appendFileSync(file, u('b'));
    cb!();
    await sleep(120);
    expect(stat).not.toHaveBeenCalled();
    expect(c.live()).toEqual([]);
    expect(collect(feed).history()!.events).toEqual([]);
  });

  it('stop() during an in-flight read publishes nothing', async () => {
    writeFileSync(file, u('a'));
    const { feed, buffer } = make({ readTitle: () => sleep(50).then(() => 'T') });
    const c = collect(feed);
    feed.start();
    await sleep(10);
    feed.stop();
    await sleep(100);
    expect(buffer.snapshot()).toEqual([]);
    expect(c.msgs).toEqual([{ t: 'session', attached: false, title: null }, { t: 'history', events: [] }]);
  });

  it('drops a listener that throws without affecting others', async () => {
    writeFileSync(file, u('a'));
    const { feed } = make();
    feed.start();
    await sleep(120);
    let n = 0;
    feed.join(() => {
      if (++n > 2) throw new Error('boom');
    });
    const c = collect(feed);
    appendFileSync(file, u('b') + u('c'));
    await tick();
    expect(n).toBe(3);
    expect(texts(c.live())).toEqual(['b', 'c']);
    feed.stop();
  });

  it('leave() is idempotent and stops delivery', async () => {
    writeFileSync(file, u('a'));
    const { feed } = make();
    feed.start();
    await sleep(120);
    const c = collect(feed);
    c.j.leave();
    c.j.leave();
    appendFileSync(file, u('b'));
    await tick();
    expect(c.live()).toEqual([]);
    feed.stop();
  });

  it('puts no file path in any message or log line', async () => {
    const { feed, logs } = make();
    const c = collect(feed);
    feed.start();
    await sleep(120);
    await tick();
    writeFileSync(file, u('a'));
    await tick();
    expect(JSON.stringify([c.msgs, logs])).not.toContain(dir);
    feed.stop();
  });

  it('start() twice creates one timer', () => {
    const { feed } = make();
    let n = 0;
    const f2 = createChatFeed({ resolveSession: () => null, setIntervalFn: () => (n++, 'x'), clearIntervalFn: () => {} });
    f2.start();
    f2.start();
    f2.stop();
    expect(n).toBe(1);
    expect(feed).toBeDefined();
  });

  it('reads through bounded fs.promises calls only and never writes', () => {
    const src = readFileSync(join(__dirname, 'chatFeed.ts'), 'utf8');
    expect(src).not.toMatch(/writeFile|appendFile|createWriteStream|rename|unlink|mkdir|rmSync|\.rm\(|readFileSync|createReadStream/);
  });
});
