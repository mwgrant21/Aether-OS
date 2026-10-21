import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildBoardFeed, listBoardSessions, type BoardFeedDeps } from './boardFeed';
import type { BoardFeed, BoardPost } from '../../src/shared/board/types';

const ROOT = path.join(__dirname, '__fixtures__', 'projects');
const deps: BoardFeedDeps = {
  projectOf: (cwd) => (cwd ? { key: path.basename(cwd), name: path.basename(cwd), worktree: null } : null),
};
const REF = { projectDir: 'proj-alpha', sessionId: 'sess-1' };

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

function tmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'board-feed-'));
  tmpDirs.push(d);
  return d;
}
function copyFixture(): string {
  const d = tmpRoot();
  fs.cpSync(ROOT, d, { recursive: true });
  return d;
}
const ts = (s: number): string => `2026-10-20T10:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000Z`;
const assistant = (s: number | null, id: string, name: string, input: unknown): string =>
  JSON.stringify({
    type: 'assistant', ...(s === null ? {} : { timestamp: ts(s) }), sessionId: 's', cwd: '/work/tmp', uuid: `u${id}`,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
const user = (s: number, content: string, origin: unknown): string =>
  JSON.stringify({ type: 'user', timestamp: ts(s), sessionId: 's', cwd: '/work/tmp', uuid: `uu${s}`, origin, message: { role: 'user', content } });
function writeSession(root: string, main: string[], agents: Record<string, { lines: string[]; meta?: string }> = {}): void {
  const dir = path.join(root, 'p');
  fs.mkdirSync(path.join(dir, 's', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 's.jsonl'), main.join('\n') + '\n');
  for (const [id, a] of Object.entries(agents)) {
    fs.writeFileSync(path.join(dir, 's', 'subagents', `agent-${id}.jsonl`), a.lines.join('\n') + '\n');
    if (a.meta !== undefined) fs.writeFileSync(path.join(dir, 's', 'subagents', `agent-${id}.meta.json`), a.meta);
  }
}
const TMP_REF = { projectDir: 'p', sessionId: 's' };
async function feedOf(root: string, ref = TMP_REF, d: BoardFeedDeps = deps): Promise<BoardFeed> {
  const r = await buildBoardFeed(root, ref, d);
  if (!r.ok) throw new Error(r.error);
  return r.feed;
}
const row = (p: BoardPost): unknown[] => [p.kind, p.from.name, p.to.name, p.startedBy, p.subject];
const notification = (task: string | null, tuid: string | null, status: string | null, summary: string, result: string): string =>
  '<task-notification>' + (task === null ? '' : `<task-id>${task}</task-id>`) + (tuid === null ? '' : `<tool-use-id>${tuid}</tool-use-id>`) +
  (status === null ? '' : `<status>${status}</status>`) + `<summary>${summary}</summary><result>${result}</result></task-notification>`;

describe('buildBoardFeed', () => {
  it('acceptance: fixture session renders the exact ordered feed', async () => {
    const feed = await feedOf(ROOT, REF);
    expect(feed.posts.map(row)).toEqual([
      ['dispatch', 'main', 'builder', null, 'Implement parser'],
      ['dispatch', 'main', 'refuter', null, 'Review'],
      ['message', 'builder', 'refuter', 'main', 'ready'],
      ['dispatch', 'builder', 'Explore', 'main', 'Find usages'],
      ['message', 'main', 'builder', null, 'tests too'],
      ['message', 'agent', 'main', null, null],
      ['message', 'main', 'all', null, null],
      ['message', 'main', 'unknown', null, null],
      ['handback', 'builder', 'main', 'main', 'Implement parser'],
      ['handback', 'refuter', 'main', 'main', 'Agent "Review" finished'],
    ]);
    const at = feed.posts.map((p) => p.atMs);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(new Set(feed.posts.map((p) => p.id)).size).toBe(10);
    expect(feed.capped).toBe(false);
    expect(feed.unreadableFiles).toBe(0);
    expect(feed.project).toEqual({ key: 'alpha', name: 'alpha', worktree: null });
    expect(feed.posts[0].to.agentId).toBe('aaa111');
    expect(feed.posts[1].to.agentId).toBe('bbb222');
    expect(feed.posts[3].to.agentId).toBeNull();
    expect(feed.posts[8].body).toBe('Parser done, 12 tests');
    expect(feed.posts[9]).toMatchObject({ status: 'completed', body: 'REWORK: 2 issues' });
    expect(feed.posts[6].to.kind).toBe('all');
  });

  it('masks secrets before capping', async () => {
    const feed = await feedOf(ROOT, REF);
    expect(feed.posts[0].body).not.toContain('SUPERSECRET123456');
    expect(feed.posts[0].body).toContain('api_key=[redacted]');
  });

  it("names an agent with no meta as 'agent' and an unseen id as unknown", async () => {
    const feed = await feedOf(ROOT, REF);
    expect(feed.posts[5].from).toMatchObject({ kind: 'agent', name: 'agent', agentId: 'ccc333' });
    expect(feed.posts[7].to).toMatchObject({ kind: 'unknown', name: 'unknown' });
  });

  it('skips stub notifications, non-string messages, duplicate tool_use ids, coordinator lines, malformed lines', async () => {
    const feed = await feedOf(ROOT, REF);
    expect(feed.posts).toHaveLength(10);
    expect(feed.posts.filter((p) => p.subject === 'Implement parser' && p.kind === 'dispatch')).toHaveLength(1);
    expect(feed.posts.some((p) => p.body.includes('shutdown') || p.body.includes('delivered to you'))).toBe(false);
  });

  it('caps long bodies', async () => {
    const root = copyFixture();
    const file = path.join(root, 'proj-alpha', 'sess-1.jsonl');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Review the branch', 'x'.repeat(9000)));
    const feed = await feedOf(root, REF);
    expect(feed.posts[1].body).toHaveLength(8000);
    expect(feed.posts[1]).toMatchObject({ bodyLength: 9000, truncated: true });
  });

  it('MAX_POSTS keeps the newest and flags capped', async () => {
    const root = tmpRoot();
    const lines = Array.from({ length: 1005 }, (_, i) => assistant(i, `toolu_${i}`, 'SendMessage', { to: 'main', message: `m${i}` }));
    writeSession(root, lines);
    const feed = await feedOf(root);
    expect(feed.posts).toHaveLength(1000);
    expect(feed.capped).toBe(true);
    expect(feed.posts[0].body).toBe('m5');
  });

  it('oversize file is unreadable but the feed still returns', async () => {
    const r = await buildBoardFeed(ROOT, REF, { ...deps, maxFileBytes: 10 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feed.unreadableFiles).toBeGreaterThanOrEqual(1);
  });

  it('missing subagents dir and malformed meta.json do not throw', async () => {
    const beta = await feedOf(ROOT, { projectDir: 'proj-beta', sessionId: 'sess-2' });
    expect(beta.posts.map(row)).toEqual([['dispatch', 'main', 'builder', null, 'Beta job']]);
    const root = tmpRoot();
    writeSession(root, [assistant(1, 'toolu_X', 'SendMessage', { to: 'main', message: 'hi' })], {
      zzz999: { lines: [assistant(2, 'toolu_Y', 'SendMessage', { to: 'main', message: 'from agent' })], meta: 'not json' },
    });
    const feed = await feedOf(root);
    expect(feed.posts.map((p) => p.from.name)).toEqual(['main', 'agent']);
  });

  it("lines without timestamps inherit the previous line's time within the file and 0 when first", async () => {
    const root = tmpRoot();
    writeSession(root, [
      assistant(null, 'toolu_A', 'SendMessage', { to: 'main', message: 'first' }),
      assistant(30, 'toolu_B', 'SendMessage', { to: 'main', message: 'second' }),
      assistant(null, 'toolu_C', 'SendMessage', { to: 'main', message: 'third' }),
    ]);
    const feed = await feedOf(root);
    expect(feed.posts.map((p) => [p.body, p.atMs])).toEqual([
      ['first', 0],
      ['second', Date.parse(ts(30))],
      ['third', Date.parse(ts(30))],
    ]);
  });

  it('drops a task-notification that is not an agent hand-back (MUST-HANDLE 1)', async () => {
    const root = tmpRoot();
    writeSession(root, [
      assistant(1, 'toolu_D1', 'Agent', { subagent_type: 'builder', description: 'Job', prompt: 'p' }),
      user(5, notification('bash9', 'toolu_SHELL', 'completed', 'Background command finished', 'exit 0'), { kind: 'task-notification' }),
      user(6, notification(null, null, null, 'Monitor event', 'tick'), { kind: 'task-notification' }),
      user(7, notification('agentX1', 'toolu_D1', 'failed', 'Agent "Job" failed', 'boom'), { kind: 'task-notification' }),
    ]);
    const feed = await feedOf(root);
    expect(feed.posts.map((p) => [p.kind, p.from.name, p.status])).toEqual([
      ['dispatch', 'main', null],
      ['handback', 'builder', 'failed'],
    ]);
  });

  it('skips a peer message whose fromAgentId is unknown to this session (MUST-HANDLE 2)', async () => {
    const root = tmpRoot();
    const peer = (s: number, from: string): string =>
      user(s, `<agent-message from="${from}">quoted</agent-message>`, { kind: 'peer', from, name: 'someone' });
    writeSession(root, [peer(1, 'zzz999'), peer(2, 'aaa111')], { aaa111: { lines: [assistant(0, 'toolu_Q', 'SendMessage', { to: 'main', message: 'x' })] } });
    const feed = await feedOf(root);
    expect(feed.posts.map((p) => [p.from.agentId, p.body])).toEqual([
      ['aaa111', 'x'],
      ['aaa111', 'quoted'],
    ]);
  });

  it("treats an empty 'to' as unresolved and never links an empty toolUseId (MUST-HANDLE 3)", async () => {
    const root = tmpRoot();
    writeSession(
      root,
      [
        assistant(1, 'toolu_E', 'SendMessage', { message: 'nobody' }),
        assistant(2, '', 'Agent', { description: 'No id', prompt: 'p' }),
        user(3, notification('aaa111', '', 'completed', 'Agent finished', 'done'), { kind: 'task-notification' }),
      ],
      { aaa111: { lines: [assistant(0, 'toolu_Q', 'SendMessage', { to: 'main', message: 'x' })], meta: JSON.stringify({ agentType: 'builder' }) } },
    );
    const feed = await feedOf(root);
    const msg = feed.posts.find((p) => p.body === 'nobody') as BoardPost;
    expect(msg.to).toMatchObject({ kind: 'unknown', name: 'unknown' });
    const dispatch = feed.posts.find((p) => p.kind === 'dispatch') as BoardPost;
    expect(dispatch.to).toMatchObject({ name: 'agent', agentId: null });
    // taskId matches a known agent file, so the notification still counts; it just has no launcher.
    const hb = feed.posts.find((p) => p.kind === 'handback') as BoardPost;
    expect(hb).toMatchObject({ startedBy: null });
    expect(hb.from.agentId).toBe('aaa111');
  });

  it('links an unmetadata agent through meta added to a copy (nested startedBy)', async () => {
    const root = copyFixture();
    fs.writeFileSync(
      path.join(root, 'proj-alpha', 'sess-1', 'subagents', 'agent-ccc333.meta.json'),
      JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_D3' }),
    );
    const feed = await feedOf(root, REF);
    expect(feed.posts[3].to).toMatchObject({ name: 'Explore', agentId: 'ccc333' });
    expect(feed.posts[5].from.name).toBe('Explore');
    expect(feed.posts[5].startedBy).toBe('builder');
  });

  it('rejects unsafe refs without touching a missing session', async () => {
    expect(await buildBoardFeed(ROOT, { projectDir: '..', sessionId: 'sess-1' }, deps)).toMatchObject({ ok: false });
    expect(await buildBoardFeed(ROOT, { projectDir: 'proj-alpha', sessionId: 'a/b' }, deps)).toMatchObject({ ok: false });
    expect(await buildBoardFeed(ROOT, { projectDir: 'proj-alpha', sessionId: '..\\x' }, deps)).toMatchObject({ ok: false });
    const r = await buildBoardFeed(ROOT, { projectDir: 'proj-alpha', sessionId: 'nope' }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain(ROOT);
      expect(r.error).not.toMatch(/[\\/]/);
    }
  });
});

describe('listBoardSessions', () => {
  it('lists sessions newest first with project, size and subagent count', async () => {
    const list = await listBoardSessions(ROOT, deps, { maxAgeMs: Infinity });
    expect(list).toHaveLength(2);
    expect(list[0].lastActiveMs).toBeGreaterThanOrEqual(list[1].lastActiveMs);
    const alpha = list.find((s) => s.sessionId === 'sess-1');
    const beta = list.find((s) => s.sessionId === 'sess-2');
    expect(alpha).toMatchObject({ projectDir: 'proj-alpha', subagentCount: 3, project: { name: 'alpha' } });
    expect(beta).toMatchObject({ projectDir: 'proj-beta', subagentCount: 0, project: { name: 'beta' } });
    expect(alpha!.sizeBytes).toBeGreaterThan(0);
  });

  it('honours limit, maxAgeMs and skips empty files', async () => {
    expect(await listBoardSessions(ROOT, deps, { maxAgeMs: Infinity, limit: 1 })).toHaveLength(1);
    expect(await listBoardSessions(ROOT, { ...deps, now: () => Date.now() + 10 * 24 * 3600 * 1000 }, { maxAgeMs: 0 })).toEqual([]);
    const root = copyFixture();
    fs.writeFileSync(path.join(root, 'proj-beta', 'empty.jsonl'), '');
    const list = await listBoardSessions(root, deps, { maxAgeMs: Infinity });
    expect(list.map((s) => s.sessionId).sort()).toEqual(['sess-1', 'sess-2']);
  });
});
