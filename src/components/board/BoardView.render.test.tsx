import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { BoardView } from './BoardView';
import type { BoardFeed, BoardFeedResult, BoardPost, BoardSessionSummary } from '../../shared/board/types';

const NOW = Date.now();
const alpha = { key: 'alpha', name: 'alpha', worktree: null };
const beta = { key: 'beta', name: 'beta', worktree: 'feat-x' };

function session(id: string, over: Partial<BoardSessionSummary> = {}): BoardSessionSummary {
  return { projectDir: `dir-${id}`, sessionId: id, project: alpha, lastActiveMs: NOW - 60_000, sizeBytes: 10, subagentCount: 2, ...over };
}
function post(id: string, body: string): BoardPost {
  const party = { kind: 'main' as const, name: 'main', agentId: null };
  return { id, atMs: NOW, kind: 'message', from: party, to: { kind: 'agent', name: 'builder', agentId: null }, startedBy: null, subject: null, body, bodyLength: body.length, truncated: false, status: null };
}
function feedOf(sessionId: string, posts: BoardPost[]): BoardFeedResult {
  const feed: BoardFeed = { ref: { projectDir: `dir-${sessionId}`, sessionId }, project: alpha, posts, capped: false, unreadableFiles: 0 };
  return { ok: true, feed };
}

function mockApi(sessions: BoardSessionSummary[], feed?: (ref: { sessionId: string }) => Promise<BoardFeedResult>) {
  const api = {
    sessions: vi.fn().mockResolvedValue(sessions),
    feed: vi.fn(feed ?? ((ref: { sessionId: string }) => Promise.resolve(feedOf(ref.sessionId, [])))),
  };
  (window as unknown as { aetherElectron: unknown }).aetherElectron = { board: api };
  return api;
}
afterEach(() => { cleanup(); delete (window as unknown as { aetherElectron?: unknown }).aetherElectron; });

describe('BoardView', () => {
  it('lists sessions, selects the newest with agents, and renders posts in the order received', async () => {
    const api = mockApi(
      [session('newest-empty', { subagentCount: 0, lastActiveMs: NOW }), session('old', { lastActiveMs: NOW - 9000 }), session('new', { lastActiveMs: NOW - 1000 })],
      (ref) => Promise.resolve(feedOf(ref.sessionId, [post('p3', 'third'), post('p1', 'first'), post('p2', 'second')])),
    );
    render(<BoardView />);
    await waitFor(() => expect(screen.getAllByTestId('post')).toHaveLength(3));
    expect(api.feed).toHaveBeenCalledWith({ projectDir: 'dir-new', sessionId: 'new' });
    expect(screen.getAllByTestId('post').map((p) => p.textContent)).toEqual([
      expect.stringContaining('third'), expect.stringContaining('first'), expect.stringContaining('second'),
    ]);
  });

  it('project filter hides sessions of other projects and shows an empty state when none match', async () => {
    mockApi([session('a1'), session('b1', { project: beta })]);
    render(<BoardView />);
    await screen.findByText(/^beta · feat-x/);
    fireEvent.click(screen.getByRole('button', { name: 'beta' }));
    expect(screen.queryByText(/^alpha ·/)).toBeNull();
    expect(screen.getByText(/^beta · feat-x/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'beta' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('a filter that matches no visible session shows an explicit empty state', async () => {
    mockApi([session('a1'), session('b1', { project: beta, subagentCount: 0 })]);
    render(<BoardView />);
    await screen.findByText(/^alpha ·/);
    fireEvent.click(screen.getByRole('button', { name: 'beta' }));
    expect(screen.getByText('No sessions match this filter.')).toBeTruthy();
  });

  it('sessions without agents are hidden until the toggle is on', async () => {
    mockApi([session('busy'), session('idle', { project: beta, subagentCount: 0 })]);
    render(<BoardView />);
    await screen.findByText(/^alpha ·/);
    expect(screen.queryByText(/^beta ·/)).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show sessions without agents' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/^beta · feat-x · .* · 0 agents/)).toBeTruthy();
  });

  it('null-project sessions appear under All projects and under a No project option, never by projectDir', async () => {
    mockApi([session('home', { project: null, projectDir: 'C--Users-Matt' }), session('a1')]);
    render(<BoardView />);
    const homeRow = await screen.findByText(/^No project ·/);
    expect(homeRow).toBeTruthy();
    expect(screen.queryByText(/C--Users-Matt/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'No project' }));
    expect(screen.getByText(/^No project ·/)).toBeTruthy();
    expect(screen.queryByText(/^alpha ·/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All projects' }));
    expect(screen.getByText(/^alpha ·/)).toBeTruthy();
  });

  it('selecting another session calls feed with that ref', async () => {
    const api = mockApi([session('s1', { lastActiveMs: NOW }), session('s2', { lastActiveMs: NOW - 5000 })]);
    render(<BoardView />);
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(1));
    const rows = screen.getAllByRole('button').filter((b) => /agents/.test(b.textContent ?? '') && b.textContent !== 'Show sessions without agents');
    fireEvent.click(rows[1]);
    expect(api.feed).toHaveBeenLastCalledWith({ projectDir: 'dir-s2', sessionId: 's2' });
  });

  it('Refresh re-fetches sessions and the selected feed', async () => {
    const api = mockApi([session('s1')]);
    render(<BoardView />);
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(2));
    expect(api.feed).toHaveBeenCalledTimes(2);
    expect(api.feed).toHaveBeenLastCalledWith({ projectDir: 'dir-s1', sessionId: 's1' });
  });

  it('ignores a stale feed response', async () => {
    const resolvers: Record<string, (r: BoardFeedResult) => void> = {};
    const api = mockApi([session('s1', { lastActiveMs: NOW }), session('s2', { lastActiveMs: NOW - 5000 })], (ref) => new Promise((res) => { resolvers[ref.sessionId] = res; }));
    render(<BoardView />);
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(1)); // s1 auto-selected
    const rows = screen.getAllByRole('button').filter((b) => /agents/.test(b.textContent ?? '') && b.textContent !== 'Show sessions without agents');
    fireEvent.click(rows[1]); // s2
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(2));
    resolvers.s2(feedOf('s2', [post('x', 'from second')]));
    await screen.findByText('from second');
    resolvers.s1(feedOf('s1', [post('y', 'from first')]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('from first')).toBeNull();
    expect(screen.getByText('from second')).toBeTruthy();
  });

  it('a zero-post session shows an explicit empty state', async () => {
    mockApi([session('s1')], (ref) => Promise.resolve(feedOf(ref.sessionId, [])));
    render(<BoardView />);
    expect(await screen.findByText('No agent traffic in this session.')).toBeTruthy();
  });

  it('a failed feed shows the error in an alert', async () => {
    mockApi([session('s1')], () => Promise.resolve({ ok: false, error: 'Session not found.' }));
    render(<BoardView />);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Session not found.')).toBeTruthy();
  });

  it('no sessions at all shows an explicit empty state', async () => {
    mockApi([]);
    render(<BoardView />);
    expect(await screen.findByText('No sessions found.')).toBeTruthy();
  });

  it('zero sessions shows one empty state, not the select-a-session prompt too', async () => {
    mockApi([]);
    render(<BoardView />);
    await screen.findByText('No sessions found.');
    expect(screen.queryByText('Select a session to see its agent traffic.')).toBeNull();
  });

  it('selects nothing and fetches no feed when no session has agents', async () => {
    const api = mockApi([session('a', { subagentCount: 0 }), session('b', { subagentCount: 0 })]);
    render(<BoardView />);
    await screen.findByText('Select a session to see its agent traffic.');
    expect(api.feed).not.toHaveBeenCalled();
    expect(screen.queryByTestId('post')).toBeNull();
  });

  it('date header appears once for same-day posts and again across a local midnight', async () => {
    const at = (p: BoardPost, ms: number): BoardPost => ({ ...p, atMs: ms });
    const d1 = new Date(2026, 9, 20, 10, 0).getTime();
    const d1b = new Date(2026, 9, 20, 23, 59).getTime();
    const d2 = new Date(2026, 9, 21, 0, 1).getTime();
    mockApi([session('s1')], (ref) => Promise.resolve(feedOf(ref.sessionId, [at(post('p1', 'a'), d1), at(post('p2', 'b'), d1b)])));
    const { unmount } = render(<BoardView />);
    await waitFor(() => expect(screen.getAllByTestId('post')).toHaveLength(2));
    expect(screen.getAllByTestId('day-header')).toHaveLength(1);
    unmount();
    mockApi([session('s1')], (ref) => Promise.resolve(feedOf(ref.sessionId, [at(post('p1', 'a'), d1), at(post('p2', 'b'), d1b), at(post('p3', 'c'), d2)])));
    render(<BoardView />);
    await waitFor(() => expect(screen.getAllByTestId('post')).toHaveLength(3));
    const heads = screen.getAllByTestId('day-header');
    expect(heads).toHaveLength(2);
    expect(heads[1].textContent).toBe(new Date(d2).toLocaleDateString());
  });

  describe('races', () => {
    type Deferred = { p: Promise<BoardFeedResult>; res: (v: BoardFeedResult) => void };
    const defer = (): Deferred => { let res!: (v: BoardFeedResult) => void; const p = new Promise<BoardFeedResult>((r) => { res = r; }); return { p, res }; };
    const sessionRows = () => screen.getAllByRole('button').filter((b) => /agents?$/.test(b.textContent ?? '') && !/Show sessions/.test(b.textContent ?? ''));
    const settle = () => new Promise((r) => setTimeout(r, 30));
    function feedsByRef() {
      const feeds: Record<string, Deferred[]> = { s1: [], s2: [] };
      const feed = (ref: { sessionId: string }) => { const d = defer(); feeds[ref.sessionId].push(d); return d.p; };
      return { feeds, feed };
    }

    it('Refresh then select: the older refresh resolving last is dropped', async () => {
      const { feeds, feed } = feedsByRef();
      const api = mockApi([session('s1', { lastActiveMs: NOW }), session('s2', { lastActiveMs: NOW - 5000 })], feed);
      render(<BoardView />);
      await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(2));
      fireEvent.click(sessionRows()[1]);
      await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(3));
      feeds.s2[0].res(feedOf('s2', [post('b', 'B-feed')]));
      await screen.findByText('B-feed');
      feeds.s1[1].res(feedOf('s1', [post('a', 'A-refresh')]));
      feeds.s1[0].res(feedOf('s1', [post('a', 'A-first')]));
      await settle();
      expect(screen.queryByText('A-refresh')).toBeNull();
      expect(screen.queryByText('A-first')).toBeNull();
      expect(screen.getByText('B-feed')).toBeTruthy();
      expect(screen.queryByText('Loading...')).toBeNull();
    });

    it('select then Refresh: the older response for the same session is dropped', async () => {
      const { feeds, feed } = feedsByRef();
      const api = mockApi([session('s1', { lastActiveMs: NOW }), session('s2', { lastActiveMs: NOW - 5000 })], feed);
      render(<BoardView />);
      await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(1));
      fireEvent.click(sessionRows()[1]);
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(3));
      feeds.s2[1].res(feedOf('s2', [post('n', 'NEW')]));
      await screen.findByText('NEW');
      feeds.s2[0].res(feedOf('s2', [post('o', 'OLD')]));
      feeds.s1[0].res(feedOf('s1', [post('a', 'A-stale')]));
      await settle();
      expect(screen.getByText('NEW')).toBeTruthy();
      expect(screen.queryByText('OLD')).toBeNull();
      expect(screen.queryByText('A-stale')).toBeNull();
    });

    it('sessions list: an older response resolving last is dropped and does not auto-select', async () => {
      const lists: { res: (v: BoardSessionSummary[]) => void }[] = [];
      const api = {
        sessions: vi.fn(() => new Promise<BoardSessionSummary[]>((res) => { lists.push({ res }); })),
        feed: vi.fn((ref: { sessionId: string }) => Promise.resolve(feedOf(ref.sessionId, []))),
      };
      (window as unknown as { aetherElectron: unknown }).aetherElectron = { board: api };
      render(<BoardView />);
      await waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(2));
      lists[1].res([session('new', { project: beta })]);
      await screen.findByText(/^beta · feat-x ·/);
      lists[0].res([session('old')]);
      await settle();
      expect(screen.queryByText(/^alpha ·/)).toBeNull();
      expect(api.feed).toHaveBeenCalledTimes(1);
      expect(api.feed).toHaveBeenCalledWith({ projectDir: 'dir-new', sessionId: 'new' });
    });
  });

  it('without window.aetherElectron renders the desktop-app message', () => {
    render(<BoardView />);
    expect(screen.getByText('Traffic needs the desktop app.')).toBeTruthy();
  });

  it('view source never imports the store', () => {
    for (const f of ['useBoard.ts', 'BoardView.tsx']) {
      const src = fs.readFileSync(path.resolve(process.cwd(), 'src/components/board', f), 'utf8');
      expect(src).not.toMatch(/useAetherStore|persistence|localStorage|setInterval/);
    }
  });
});
