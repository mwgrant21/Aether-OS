// @vitest-environment node
// Opt-in: real `claude` CLI, real login, small token cost. Run with
//   AETHER_VOICE_LIVE=1 npx vitest run electron/voice/voiceSession.live.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVoiceSession, type SessionEvent } from './voiceSession';

const LIVE = process.env.AETHER_VOICE_LIVE === '1';

function newestJsonl(root: string): number {
  let newest = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  walk(root);
  return newest;
}
function mtime(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

describe.skipIf(!LIVE)('voiceSession against the real claude CLI', () => {
  it('primes, answers, survives an interrupt, and writes no machine-global state', async () => {
    // The child runs in os.tmpdir(), so a transcript it wrote would land in that project dir.
    // (The whole projects tree is not checked: the session running this test writes there too.)
    const projects = path.join(os.homedir(), '.claude', 'projects', os.tmpdir().replace(/[^A-Za-z0-9]/g, '-'));
    const statusline = path.join(os.homedir(), '.aether-os', 'statusline.json');
    const jsonlBefore = newestJsonl(projects);
    const statuslineBefore = mtime(statusline);

    const events: SessionEvent[] = [];
    const session = createVoiceSession();
    session.on((e) => events.push(e));
    const wait = async (pred: () => boolean, ms = 60_000) => {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > ms) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    try {
      const t0 = Date.now();
      session.start();
      await wait(() => session.state() === 'ready');
      const coldMs = Date.now() - t0;

      const t1 = Date.now();
      expect(session.send('live0001', 'Say hello')).toBe(true);
      await wait(() => events.some((e) => e.k === 'delta' && e.turnId === 'live0001'));
      const warmFirstDeltaMs = Date.now() - t1;
      await wait(() => events.some((e) => e.k === 'result' && e.turnId === 'live0001'));
      expect(events.some((e) => e.k === 'result' && e.turnId === 'live0001' && e.ok)).toBe(true);

      expect(session.send('live0002', 'Count slowly from one to fifty, one number per sentence.')).toBe(true);
      await wait(() => events.some((e) => e.k === 'delta' && e.turnId === 'live0002'));
      session.interrupt();
      await wait(() => events.some((e) => e.k === 'result' && e.turnId === 'live0002'));

      expect(session.send('live0003', 'Say hello again')).toBe(true);
      await wait(() => events.some((e) => e.k === 'result' && e.turnId === 'live0003'));
      expect(events.some((e) => e.k === 'delta' && e.turnId === 'live0003')).toBe(true);

      // eslint-disable-next-line no-console
      console.log('LIVE cold prime ms=' + coldMs + ' warm first delta ms=' + warmFirstDeltaMs);
    } finally {
      await session.stop();
    }
    expect(newestJsonl(projects)).toBe(jsonlBefore);
    expect(mtime(statusline)).toBe(statuslineBefore);
  }, 180_000);
});
