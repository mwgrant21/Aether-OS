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
