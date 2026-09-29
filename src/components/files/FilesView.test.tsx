import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
