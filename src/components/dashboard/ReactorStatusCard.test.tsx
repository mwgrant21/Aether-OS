import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ReactorStatusCard } from './ReactorStatusCard';
import { Footer } from '../layout/Footer';
import { AetherStoreProvider } from '../../state/store';

// ReactorStatusCard renders <Reactor>, which calls useReducedMotion() -> window.matchMedia.
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReactorStatusCard status announcement', () => {
  it('shows the status visibly but leaves the single live region to the Footer', () => {
    const { container } = render(
      <AetherStoreProvider>
        <ReactorStatusCard />
        <Footer />
      </AetherStoreProvider>,
    );
    expect(screen.getByTestId('reactor-status-label').textContent).toContain('STANDBY');
    const live = container.querySelectorAll('[aria-live]');
    expect(live).toHaveLength(1);
    expect(live[0].closest('footer')).not.toBeNull();
  });
});
