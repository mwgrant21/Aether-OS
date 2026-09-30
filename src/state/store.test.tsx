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
});
