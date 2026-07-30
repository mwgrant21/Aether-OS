import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from './state/store';
import { RecapBannerMount } from './App';
import type { RecapPayload } from './state/types';

afterEach(cleanup);

const RECAP: RecapPayload = {
  entries: [{ kind: 'dispatchCompleted', detail: 'general-purpose: do the thing', atMs: 1 }],
  tokensBurned: 500,
};

function Setter({ recap }: { recap: RecapPayload }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    dispatch({ type: 'RECAP_RECEIVED', recap });
  }, [dispatch, recap]);
  return null;
}

// Regression test for the bug found in review: App.tsx used to pass
// RecapBanner an inline `onDismiss={() => dispatch(...)}` prop. AetherStoreProvider
// dispatches TICK every 900ms for the app's whole lifetime, which re-renders
// RecapBannerMount and (with an inline arrow function) produced a brand-new
// onDismiss reference on every one of those re-renders. RecapBanner's
// auto-dismiss useEffect depends on `onDismiss`, so the effect tore down and
// rescheduled its setTimeout roughly every 900ms -- well under the 10000ms
// timeout -- meaning the scheduled dismiss never actually fired. This test
// mounts the REAL RecapBannerMount inside a REAL AetherStoreProvider (whose
// own internal setInterval(TICK, 900) is left running, not mocked out) so it
// exercises the exact re-render cadence that broke auto-dismiss, rather than
// testing the leaf RecapBanner component in isolation with a stable vi.fn().
describe('RecapBannerMount auto-dismiss (integration)', () => {
  it('auto-dismisses ~10s after the recap arrives, even while TICK-driven re-renders occur in between', () => {
    vi.useFakeTimers();
    try {
      render(
        <AetherStoreProvider>
          <Setter recap={RECAP} />
          <RecapBannerMount />
        </AetherStoreProvider>,
      );

      // Flush the Setter's effect (dispatches RECAP_RECEIVED).
      act(() => {
        vi.advanceTimersByTime(0);
      });
      expect(screen.getByText(/Since you last looked/)).toBeTruthy();

      // Advance in 900ms increments (the store's real TICK cadence) past the
      // 10000ms auto-dismiss threshold -- roughly 12 TICK-driven re-renders
      // happen along the way, each of which would have reset a naive
      // inline-callback-dependent timer.
      for (let i = 0; i < 12; i++) {
        act(() => {
          vi.advanceTimersByTime(900);
        });
      }

      expect(screen.queryByText(/Since you last looked/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
