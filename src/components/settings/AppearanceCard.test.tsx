import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { AppearanceCard } from './AppearanceCard';
import { AetherStoreProvider, useAetherStore } from '../../state/store';

afterEach(cleanup);

function CfgProbe() {
  const { state } = useAetherStore();
  return <div data-testid="probe">{String(state.cfg.terminalMarkerColors)}</div>;
}

function renderCard() {
  render(
    <AetherStoreProvider>
      <AppearanceCard />
      <CfgProbe />
    </AetherStoreProvider>,
  );
}

describe('AppearanceCard terminal marker colors', () => {
  it('defaults to ON', () => {
    renderCard();
    expect(screen.getByTestId('probe').textContent).toBe('true');
    expect(screen.getByTitle('Disable terminal marker colors').textContent).toBe('ON');
  });

  it('clicking the toggle sets cfg.terminalMarkerColors to false', () => {
    renderCard();
    fireEvent.click(screen.getByTitle('Disable terminal marker colors'));
    expect(screen.getByTestId('probe').textContent).toBe('false');
    expect(screen.getByTitle('Enable terminal marker colors').textContent).toBe('OFF');
  });
});
