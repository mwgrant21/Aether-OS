import { afterEach, describe, it, expect } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import type { OpMode } from '../../state/types';
import { RecentAlertsCard, alertToneColor, notifKeys } from './RecentAlertsCard';
import { colors } from '../../styles/tokens';

afterEach(cleanup);

// jsdom normalizes colours (hex -> rgb), so compare through the same parser.
function cssColor(value: string): string {
  const el = document.createElement('span');
  el.style.color = value;
  return el.style.color;
}

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

  it('maps an alert to the success/warn/danger tokens, and anything else to neutral text', () => {
    expect(alertToneColor('#3be0a0', colors)).toBe(colors.success);
    expect(alertToneColor('#F5C66B', colors)).toBe(colors.warn);
    expect(alertToneColor('#ff6b7a', colors)).toBe(colors.danger);
    expect(alertToneColor('#ff9d9d', colors)).toBe(colors.danger);
    expect(alertToneColor('#7fd8ef', colors)).toBe(colors.textSecondary);
    expect(alertToneColor('#8ab6ff', colors)).toBe(colors.textSecondary);
  });

  it('paints a row in its tone token, not the colour stored on the notif', () => {
    render(
      <AetherStoreProvider>
        <DispatchProbe />
        <RecentAlertsCard />
      </AetherStoreProvider>,
    );
    act(() => setMode('EDITS')); // stored with c: '#7fd8ef'
    // getAll: an earlier test in this file may have raised the same message.
    expect(screen.getAllByText('Operating mode set to EDITS')[0].style.color).toBe(cssColor(colors.textSecondary));
  });
});
