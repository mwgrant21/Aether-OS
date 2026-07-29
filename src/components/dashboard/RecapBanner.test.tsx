import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { AetherStoreProvider } from '../../state/store';
import { RecapBanner } from './RecapBanner';
import type { RecapPayload } from '../../state/types';

afterEach(cleanup);

// RecapBanner calls useColors(), which reads state.cfg.themeMode from the
// store context (see useColors.ts) -- every other card component in this
// codebase (PostToolFlagCard.test.tsx, PermissionRequestCard.test.tsx) wraps
// its render in AetherStoreProvider for the same reason; a bare render()
// throws "useAetherStore must be used within AetherStoreProvider".
function renderBanner(recap: RecapPayload | null, onDismiss: () => void) {
  return render(
    <AetherStoreProvider>
      <RecapBanner recap={recap} onDismiss={onDismiss} />
    </AetherStoreProvider>,
  );
}

describe('RecapBanner', () => {
  it('renders nothing when recap is null', () => {
    const { container } = renderBanner(null, vi.fn());
    expect(container.textContent).toBe('');
  });

  it('summarizes dispatch/anomaly counts and tokens burned', () => {
    renderBanner(
      {
        entries: [
          { kind: 'dispatchCompleted', detail: 'a', atMs: 1 },
          { kind: 'dispatchCompleted', detail: 'b', atMs: 2 },
          { kind: 'anomalyCleared', detail: 'c', atMs: 3 },
        ],
        tokensBurned: 42000,
      },
      vi.fn(),
    );
    expect(screen.getByText(/2 dispatches completed/)).toBeTruthy();
    expect(screen.getByText(/1 anomaly cleared/)).toBeTruthy();
    expect(screen.getByText(/42,000 tokens/)).toBeTruthy();
  });

  it('calls onDismiss when the close button is clicked', () => {
    const onDismiss = vi.fn();
    renderBanner({ entries: [], tokensBurned: 100 }, onDismiss);
    fireEvent.click(screen.getByText(/dismiss/i));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
