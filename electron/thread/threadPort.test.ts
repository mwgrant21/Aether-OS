// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ThreadMeta, ThreadSlotId, ThreadSnapshot, ThreadTap } from '../../src/shared/remote/threadTypes';
import { createThreadPort } from './threadPort';

const prompt = (text: string): string =>
  JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z', isSidechain: false, message: { role: 'user', content: text } }) + '\n';

const dirs: string[] = [];
function setup(opts: { terminal2: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-port-'));
  dirs.push(dir);
  const files = { claude: path.join(dir, 'c.jsonl'), terminal2: path.join(dir, 't.jsonl') };
  fs.writeFileSync(files.claude, prompt('from claude'));
  fs.writeFileSync(files.terminal2, prompt('from terminal2'));
  const timers: { fn: () => void; cleared: boolean }[] = [];
  const clock = { t: 5_000_000 };
  const port = createThreadPort({
    resolve: (slot) =>
      slot === 'claude' ? { sessionId: 'sess-c', file: files.claude } : opts.terminal2 ? { sessionId: 'sess-t', file: files.terminal2 } : null,
    statuslineCtx: (slot) => (slot === 'claude' ? { pct: 12.5 } : null),
    now: () => clock.t,
    setIntervalFn: (fn) => {
      const h = { fn, cleared: false };
      timers.push(h);
      return h;
    },
    clearIntervalFn: (h) => {
      h.cleared = true;
    },
  });
  const tap = (): { tap: ThreadTap; snaps: ThreadSnapshot[]; metas: ThreadMeta[] } => {
    const snaps: ThreadSnapshot[] = [];
    const metas: ThreadMeta[] = [];
    return { tap: { snap: (s) => void snaps.push(s), add() {}, upd() {}, meta: (m) => void metas.push(m) }, snaps, metas };
  };
  return { port, timers, clock, files, tap, live: () => timers.filter((t) => !t.cleared).length };
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('threadPort', () => {
  it('routes each slot to its own session; terminal2 has no statusline percentage', async () => {
    const s = setup({ terminal2: true });
    const c = s.tap();
    const t = s.tap();
    s.port.attach('claude', c.tap);
    s.port.attach('terminal2', t.tap);
    await s.port.tick('claude');
    await s.port.tick('terminal2');
    expect(c.snaps.at(-1)!.entries).toMatchObject([{ x: 'from claude' }]);
    expect(t.snaps.at(-1)!.entries).toMatchObject([{ x: 'from terminal2' }]);
    expect(c.snaps.at(-1)!.m.ctxPct).toBe(12.5);
    expect(t.snaps.at(-1)!.m.ctxPct).toBeNull();
  });

  it('terminal2 without a known session is avail:false no-session', async () => {
    const s = setup({ terminal2: false });
    const t = s.tap();
    s.port.attach('terminal2', t.tap);
    await s.port.tick('terminal2');
    expect(t.snaps.at(-1)).toMatchObject({ avail: false, why: 'no-session', entries: [] });
  });

  it('an unknown slot attaches to nothing and starts no timer', () => {
    const s = setup({ terminal2: true });
    const t = s.tap();
    const a = s.port.attach('codex' as ThreadSlotId, t.tap);
    a.detach();
    expect(t.snaps).toHaveLength(0);
    expect(s.timers).toHaveLength(0);
    expect(s.port.detail('codex' as ThreadSlotId, '0:0')).toBeNull();
  });

  it('serves detail per slot only while attached, and the last detach frees it', async () => {
    const s = setup({ terminal2: true });
    fs.writeFileSync(s.files.claude, JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'echo hi' } }], stop_reason: 'tool_use' } }) + '\n');
    const c = s.tap();
    const a = s.port.attach('claude', c.tap);
    await s.port.tick('claude');
    const id = c.snaps.at(-1)!.entries[0]!.id;
    expect(s.port.detail('claude', id)).toMatchObject({ input: 'echo hi' });
    expect(s.port.detail('terminal2', id)).toBeNull();
    a.detach();
    expect(s.live()).toBe(0);
    expect(s.port.detail('claude', id)).toBeNull();
  });

  it('routes a notification to the matching session only; stopAll clears every timer', async () => {
    const s = setup({ terminal2: true });
    const c = s.tap();
    const t = s.tap();
    s.port.attach('claude', c.tap);
    s.port.attach('terminal2', t.tap);
    await s.port.tick('claude');
    await s.port.tick('terminal2');
    s.port.noteNotification('sess-t', 'permission_prompt');
    s.clock.t += 1000;
    await s.port.tick('claude');
    await s.port.tick('terminal2');
    expect(c.metas).toHaveLength(0);
    expect(t.metas.at(-1)).toMatchObject({ wait: 'perm' });
    expect(s.live()).toBe(2);
    s.port.stopAll();
    expect(s.live()).toBe(0);
  });
});
