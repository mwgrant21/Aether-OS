import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AetherStoreProvider, useAetherStore } from './store';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function Probe() {
  const { state } = useAetherStore();
  return (
    <div>
      <div data-testid="tab">{state.activeTab}</div>
      <div data-testid="unread">{state.unread}</div>
      <div data-testid="started">{state.sessionStartedAt ?? 'none'}</div>
    </div>
  );
}

function mount() {
  render(
    <AetherStoreProvider>
      <Probe />
    </AetherStoreProvider>,
  );
}

describe('AetherStoreProvider hydration', () => {
  it('opens on Dashboard when nothing is persisted', () => {
    mount();
    expect(screen.getByTestId('tab').textContent).toBe('Dashboard');
  });

  it('ignores a persisted activeTab (every launch opens on Dashboard) but restores other fields', () => {
    localStorage.setItem('aetheros-v1', JSON.stringify({ activeTab: 'Terminal', unread: 5 }));
    mount();
    expect(screen.getByTestId('tab').textContent).toBe('Dashboard');
    expect(screen.getByTestId('unread').textContent).toBe('5');
  });

  it('does not carry a stale persisted sessionStartedAt into a new launch', () => {
    localStorage.setItem('aetheros-v1', JSON.stringify({ sessionStartedAt: '2020-01-01T00:00:00.000Z', unread: 5 }));
    mount();
    expect(screen.getByTestId('started').textContent).toBe('none');
  });
});
