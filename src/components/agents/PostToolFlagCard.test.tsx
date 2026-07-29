import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { PostToolFlagCard } from './PostToolFlagCard';
import type { PostToolFlagRequestUI } from '../../state/types';

afterEach(cleanup);

function Setter({ request }: { request: PostToolFlagRequestUI | null }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    dispatch({ type: 'SET_PENDING_POST_TOOL_FLAG', request });
  }, [dispatch, request]);
  return null;
}

function renderWithRequest(request: PostToolFlagRequestUI | null) {
  return render(
    <AetherStoreProvider>
      <Setter request={request} />
      <PostToolFlagCard />
    </AetherStoreProvider>,
  );
}

const REREAD_FLAG: PostToolFlagRequestUI = {
  requestId: 'flag-1',
  toolUseId: 'tu_1',
  toolName: 'Read',
  anomalyKind: 'reReadLoop',
  detail: 'src/foo.ts read 3 times',
};

describe('PostToolFlagCard', () => {
  let respond: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    respond = vi.fn().mockResolvedValue(undefined);
    (window as any).aetherElectron = {
      postToolFlag: {
        onRequest: () => () => {},
        respond,
      },
    };
  });

  it('renders nothing when pendingPostToolFlag is null', () => {
    const { container } = renderWithRequest(null);
    expect(container.textContent).toBe('');
  });

  it('renders tool name, anomaly kind, and detail', () => {
    renderWithRequest(REREAD_FLAG);
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText('reReadLoop')).toBeTruthy();
    expect(screen.getByText('src/foo.ts read 3 times')).toBeTruthy();
  });

  it('clicking Dismiss calls respond with block: false', () => {
    renderWithRequest(REREAD_FLAG);
    fireEvent.click(screen.getByText(/dismiss/i));
    expect(respond).toHaveBeenCalledWith('flag-1', { block: false });
  });

  it('clicking Block requires a non-empty reason and calls respond with it', () => {
    renderWithRequest(REREAD_FLAG);

    // Attempt to block with no reason typed -- must not call respond.
    fireEvent.click(screen.getByText(/block/i));
    expect(respond).not.toHaveBeenCalled();

    const reasonInput = screen.getByPlaceholderText(/reason/i);
    fireEvent.change(reasonInput, { target: { value: 'looping on this file' } });
    fireEvent.click(screen.getByText(/block/i));
    expect(respond).toHaveBeenCalledWith('flag-1', { block: true, reason: 'looping on this file' });
  });
});
