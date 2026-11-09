import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FilesView } from './FilesView';

afterEach(() => {
  cleanup();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

function mockAttachments(list: unknown[]) {
  const api = { list: vi.fn().mockResolvedValue(list), add: vi.fn(), remove: vi.fn(), open: vi.fn(), thumbnail: vi.fn().mockResolvedValue(null) };
  (window as unknown as { aetherElectron?: unknown }).aetherElectron = { attachments: api };
  return api;
}

describe('FilesView empty state', () => {
  beforeEach(() => {
    mockAttachments([]);
  });

  it('uses the shared EmptyState with one plain sentence', async () => {
    const { container } = render(<FilesView />);
    await waitFor(() => expect(container.querySelector('[data-empty-state]')).not.toBeNull());
    expect(screen.getByText('Screenshots and documents you attach with + ADD FILE will be listed here.')).toBeTruthy();
  });

  it('keeps + ADD FILE in the header only, with no duplicate in the empty state', async () => {
    const { container } = render(<FilesView />);
    await waitFor(() => expect(container.querySelector('[data-empty-state]')).not.toBeNull());
    expect(screen.getAllByRole('button', { name: '+ ADD FILE' })).toHaveLength(1);
    expect(container.querySelector('[data-empty-state] button')).toBeNull();
  });

  it('does not show the empty state while attachments exist', async () => {
    mockAttachments([{ name: 'shot.png', size: 2048, mtimeMs: 1 }]);
    const { container } = render(<FilesView />);
    await waitFor(() => expect(screen.getByText('shot.png')).toBeTruthy());
    expect(container.querySelector('[data-empty-state]')).toBeNull();
  });
});

describe('FilesView thumbnails', () => {
  const file = (name: string) => ({ name, size: 10, mtimeMs: 1 });

  it('requests each image thumbnail once while others are still loading', async () => {
    const api = mockAttachments([file('a.png'), file('b.png'), file('c.png')]);
    const resolvers: Record<string, (v: string | null) => void> = {};
    api.thumbnail.mockImplementation((name: string) => new Promise((res) => { resolvers[name] = res; }));
    const { container } = render(<FilesView />);
    await waitFor(() => expect(api.thumbnail).toHaveBeenCalledTimes(3));
    await act(async () => { resolvers['a.png']('data:image/png;base64,AA'); });
    await waitFor(() => expect(container.querySelectorAll('img').length).toBe(1));
    await act(async () => { resolvers['b.png'](null); });
    await act(async () => { resolvers['c.png']('data:image/png;base64,BB'); });
    expect(api.thumbnail).toHaveBeenCalledTimes(3);
    for (const n of ['a.png', 'b.png', 'c.png']) {
      expect(api.thumbnail.mock.calls.filter((c) => c[0] === n)).toHaveLength(1);
    }
  });

  it('still requests the thumbnail of a file added later', async () => {
    const api = mockAttachments([]);
    api.list.mockResolvedValueOnce([file('a.png')]).mockResolvedValue([file('a.png'), file('b.png')]);
    api.add.mockResolvedValue(undefined);
    api.thumbnail.mockResolvedValue('data:image/png;base64,AA');
    render(<FilesView />);
    await waitFor(() => expect(api.thumbnail).toHaveBeenCalledWith('a.png'));
    fireEvent.click(screen.getByRole('button', { name: '+ ADD FILE' }));
    await waitFor(() => expect(api.thumbnail).toHaveBeenCalledWith('b.png'));
    expect(api.thumbnail).toHaveBeenCalledTimes(2);
  });
});
