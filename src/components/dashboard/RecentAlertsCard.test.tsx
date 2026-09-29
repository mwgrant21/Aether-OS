import { afterEach, describe, it, expect } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import type { OpMode } from '../../state/types';
import { RecentAlertsCard, notifKeys } from './RecentAlertsCard';

afterEach(cleanup);

let setMode: (mode: OpMode) => void = () => {};
function DispatchProbe() {
  const { dispatch } = useAetherStore();
  setMode = (mode) => dispatch({ type: 'SET_OP_MODE', mode });
  return null;
}

describe('RecentAlertsCard', () => {
  it('renders a single quiet sentence when there are no alerts', () => {
    render(
      <AetherStoreProvider>
        <RecentAlertsCard />
      </AetherStoreProvider>,
    );
    expect(screen.getByText('Anomalies and budget warnings will appear here.')).toBeTruthy();
  });

  it('keys alerts by content, so prepending a new alert keeps existing keys stable', () => {
    const a = { t: '10:00', m: 'Anomaly: retry loop', c: '#f5c66b' };
    const b = { t: '10:01', m: 'Budget at 80%', c: '#f5c66b' };
    const before = notifKeys([a, a]);
    const after = notifKeys([b, a, a]);
    expect(new Set(before).size).toBe(2);
    expect(after.slice(1)).toEqual(before);
  });

  it('reuses an existing row DOM node when a new alert is prepended (fails on key={idx})', () => {
    render(
      <AetherStoreProvider>
        <DispatchProbe />
        <RecentAlertsCard />
      </AetherStoreProvider>,
    );
    act(() => setMode('EDITS'));
    const row = screen.getByText('Operating mode set to EDITS').parentElement;
    act(() => setMode('AUTO'));
    expect(screen.getByText('Operating mode set to AUTO')).toBeTruthy();
    expect(screen.getByText('Operating mode set to EDITS').parentElement).toBe(row);
  });
});
