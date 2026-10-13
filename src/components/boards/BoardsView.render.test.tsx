import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BoardsView } from './BoardsView';
import type { BoardsListing, RefreshResponse } from '../../shared/dashboards/types';

const listing: BoardsListing = {
  collectorAvailable: true,
  boards: [
    { id: 'spend-cache', title: 'Spend & cache', error: null, panels: [
      { id: 'today', title: 'Spend today', type: 'stat', range: '24h', sql: 'SELECT 1', costBasis: 'exact', x: null, y: ['usd'] },
      { id: 'disp', title: 'Dispatch spend', type: 'table', range: '7d', sql: 'SELECT 2', costBasis: 'estimated', x: null, y: [] },
    ] },
    { id: 'broken', title: 'broken', error: 'invalid JSON: Unexpected token', panels: [] },
  ],
};
const refreshed: RefreshResponse = { ok: true, panels: [
  { panelId: 'today', columns: ['period', 'usd'], rows: [{ period: 'last 24h', usd: null }], truncated: false, unpricedRows: 2, error: null, errorKind: null, refreshedAt: 1, definition: 'd' },
  { panelId: 'disp', columns: ['day', 'usdApprox'], rows: [{ day: '2026-10-11', usdApprox: 1.5 }], truncated: false, unpricedRows: 0, error: null, errorKind: null, refreshedAt: 1, definition: 'd' },
] };

function mockApi(overrides: Partial<BoardsListing> = {}) {
  const api = {
    list: vi.fn().mockResolvedValue({ ...listing, ...overrides }),
    refresh: vi.fn().mockResolvedValue(refreshed),
    remove: vi.fn().mockResolvedValue({ ok: true }),
    copyRegisterCommand: vi.fn().mockResolvedValue({ ok: true }),
    onChanged: vi.fn().mockReturnValue(() => {}),
  };
  (window as unknown as { aetherElectron: unknown }).aetherElectron = { dashboards: api };
  return api;
}
afterEach(() => { cleanup(); delete (window as unknown as { aetherElectron?: unknown }).aetherElectron; });

describe('BoardsView', () => {
  it('renders boards as tabs, refreshes the first, and shows null cost as "no data" not $0.00', async () => {
    const api = mockApi();
    render(<BoardsView />);
    expect(await screen.findByText('Spend & cache')).toBeTruthy();
    expect(await screen.findByText('no data')).toBeTruthy();
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(screen.getByText(/2 rows unpriced/)).toBeTruthy();
    expect(screen.getByText('~$1.50')).toBeTruthy();
    expect(api.refresh).toHaveBeenCalledWith('spend-cache', undefined);
  });

  it('an invalid board shows its error', async () => {
    mockApi();
    render(<BoardsView />);
    fireEvent.click(await screen.findByText('broken'));
    expect(await screen.findByText(/invalid: invalid JSON/)).toBeTruthy();
  });

  it('shows the no-collector banner', async () => {
    mockApi({ collectorAvailable: false });
    render(<BoardsView />);
    expect(await screen.findByText(/No collector data/)).toBeTruthy();
  });

  it('delete needs an in-page confirmation', async () => {
    const api = mockApi();
    render(<BoardsView />);
    fireEvent.click(await screen.findByText('Delete board'));
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Confirm delete'));
    expect(api.remove).toHaveBeenCalledWith('spend-cache');
  });

  it('the + tab copies the register command', async () => {
    const api = mockApi();
    render(<BoardsView />);
    fireEvent.click(await screen.findByLabelText('New board'));
    fireEvent.click(screen.getByText('Copy register command'));
    expect(api.copyRegisterCommand).toHaveBeenCalled();
    expect(await screen.findByText(/Copied/)).toBeTruthy();
  });

  it('shows the listing-level error above the tabs', async () => {
    mockApi({ boards: [], error: 'Boards folder is not usable.' });
    render(<BoardsView />);
    expect((await screen.findByRole('alert')).textContent).toContain('Boards folder is not usable.');
  });

  it('a rejected list() shows "Could not load boards." instead of an unhandled rejection', async () => {
    const api = mockApi();
    api.list.mockRejectedValue(new Error('ipc down'));
    render(<BoardsView />);
    expect(await screen.findByText('Could not load boards.')).toBeTruthy();
  });

  it('a rejected refresh shows an error instead of an unhandled rejection', async () => {
    const api = mockApi();
    api.refresh.mockRejectedValue(new Error('ipc down'));
    render(<BoardsView />);
    expect(await screen.findByText('Refresh failed.')).toBeTruthy();
  });

  it('a late refresh for the previous board is discarded after switching boards', async () => {
    const panel = { id: 'p', title: 'Shared', type: 'table' as const, range: '24h' as const, sql: 'SELECT 1', costBasis: null, x: null, y: [] };
    const two: BoardsListing = { collectorAvailable: true, boards: [
      { id: 'a', title: 'Board A', error: null, panels: [panel] },
      { id: 'b', title: 'Board B', error: null, panels: [panel] },
    ] };
    const res = (v: string): RefreshResponse => ({ ok: true, panels: [
      { panelId: 'p', columns: ['v'], rows: [{ v }], truncated: false, unpricedRows: 0, error: null, errorKind: null, refreshedAt: 1, definition: 'd' },
    ] });
    const api = mockApi(two);
    let resolveA: (r: RefreshResponse) => void = () => {};
    api.refresh.mockImplementation((id: string) => (id === 'a'
      ? new Promise<RefreshResponse>((r) => { resolveA = r; })
      : Promise.resolve(res('from-b'))));
    render(<BoardsView />);
    fireEvent.click(await screen.findByText('Board B'));
    expect(await screen.findByText('from-b')).toBeTruthy();
    await act(async () => { resolveA(res('from-a')); });
    expect(screen.queryByText('from-a')).toBeNull();
    expect(screen.getByText('from-b')).toBeTruthy();
  });

  it('changing the range drops the previous range data when the next refresh is busy', async () => {
    const panel = { id: 'p', title: 'Shared', type: 'table' as const, range: '24h' as const, sql: 'SELECT 1', costBasis: null, x: null, y: [] };
    const one: BoardsListing = { collectorAvailable: true, boards: [{ id: 'a', title: 'Board A', error: null, panels: [panel] }] };
    const api = mockApi(one);
    api.refresh.mockResolvedValueOnce({ ok: true, panels: [
      { panelId: 'p', columns: ['v'], rows: [{ v: 'old-range' }], truncated: false, unpricedRows: 0, error: null, errorKind: null, refreshedAt: 1, definition: 'd' },
    ] });
    api.refresh.mockResolvedValue({ ok: true, panels: [
      { panelId: 'p', columns: [], rows: [], truncated: false, unpricedRows: 0, error: 'locked', errorKind: 'busy', refreshedAt: 2, definition: 'd' },
    ] });
    render(<BoardsView />);
    expect(await screen.findByText('old-range')).toBeTruthy();
    fireEvent.click(screen.getByText('7d'));
    await waitFor(() => expect(api.refresh).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('old-range')).toBeNull());
  });

  it('delete hides the tab immediately', async () => {
    const api = mockApi();
    render(<BoardsView />);
    fireEvent.click(await screen.findByText('Delete board'));
    fireEvent.click(screen.getByText('Confirm delete'));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('spend-cache'));
    await waitFor(() => expect(screen.queryByText('Spend & cache')).toBeNull());
  });

  it('a board re-saved with a deleted id reappears', async () => {
    const api = mockApi();
    let changed: (ids: string[]) => void = () => {};
    api.onChanged.mockImplementation((cb: (ids: string[]) => void) => { changed = cb; return () => {}; });
    render(<BoardsView />);
    fireEvent.click(await screen.findByText('Delete board'));
    api.list.mockResolvedValue({ ...listing, boards: listing.boards.filter((b) => b.id !== 'spend-cache') });
    fireEvent.click(screen.getByText('Confirm delete'));
    await waitFor(() => expect(screen.queryByText('Spend & cache')).toBeNull());
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    api.list.mockResolvedValue(listing);
    await act(async () => { changed(['spend-cache']); });
    expect(await screen.findByText('Spend & cache')).toBeTruthy();
  });

  it('an invalid board can be deleted in-app', async () => {
    const api = mockApi();
    render(<BoardsView />);
    fireEvent.click(await screen.findByText('broken'));
    fireEvent.click(await screen.findByText('Delete board'));
    expect(screen.queryByText('Refresh')).toBeNull();
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Confirm delete'));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('broken'));
  });
});
