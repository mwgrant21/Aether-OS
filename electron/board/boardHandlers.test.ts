import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createBoardHandlers } from './boardHandlers';

const ROOT = path.join(__dirname, '__fixtures__', 'projects');
const projectOf = (cwd: string | null) => (cwd ? { key: path.basename(cwd), name: path.basename(cwd), worktree: null } : null);
const REF = { projectDir: 'proj-alpha', sessionId: 'sess-1' };

afterEach(() => vi.restoreAllMocks());

describe('createBoardHandlers', () => {
  it('feed returns the fixture feed for a valid ref', async () => {
    const r = await createBoardHandlers({ projectsRoot: ROOT, projectOf }).feed(REF);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feed.posts).toHaveLength(10);
  });

  it('feed rejects non-object, missing fields, non-string fields, ".." and separators without touching fs', async () => {
    const stat = vi.spyOn(fs.promises, 'stat');
    const open = vi.spyOn(fs.promises, 'open');
    const readdir = vi.spyOn(fs.promises, 'readdir');
    const h = createBoardHandlers({ projectsRoot: ROOT, projectOf });
    const bad: unknown[] = [
      null, undefined, 'x', 42, [], {}, { projectDir: 'proj-alpha' }, { sessionId: 'sess-1' },
      { projectDir: 1, sessionId: 'sess-1' }, { projectDir: 'proj-alpha', sessionId: {} },
      { projectDir: '..', sessionId: '..\\x' }, { projectDir: '..', sessionId: 'sess-1' },
      { projectDir: 'proj-alpha', sessionId: '../sess-1' }, { projectDir: 'a/b', sessionId: 'sess-1' },
      { projectDir: 'proj-alpha', sessionId: 'a\\b' }, { projectDir: '.', sessionId: 'sess-1' },
    ];
    for (const b of bad) expect(await h.feed(b)).toEqual({ ok: false, error: 'Invalid session.' });
    expect(stat).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
  });

  it('sessions calls beforeList first and returns the two fixture sessions', async () => {
    const order: string[] = [];
    const beforeList = vi.fn(() => { order.push('before'); });
    const h = createBoardHandlers({
      projectsRoot: ROOT,
      projectOf: (c) => { order.push('projectOf'); return projectOf(c); },
      beforeList,
    });
    const list = await h.sessions();
    expect(beforeList).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe('before');
    expect(list).toHaveLength(2);
  });

  it('handlers keep no state between calls', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-handlers-'));
    try {
      fs.cpSync(ROOT, tmp, { recursive: true });
      const h = createBoardHandlers({ projectsRoot: tmp, projectOf });
      const first = await h.feed(REF);
      fs.writeFileSync(path.join(tmp, 'proj-alpha', 'sess-1.jsonl'), '');
      const second = await h.feed(REF);
      expect(first.ok && first.feed.posts.length).toBeGreaterThan(0);
      expect(second.ok && second.feed.posts.length).toBeLessThan(first.ok ? first.feed.posts.length : 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
