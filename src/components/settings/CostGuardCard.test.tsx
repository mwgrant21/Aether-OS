import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { CostGuardCard } from './CostGuardCard';
import { CrossEngineVerificationCard } from './CrossEngineVerificationCard';
import { AetherStoreProvider } from '../../state/store';

afterEach(() => {
  cleanup();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

function crossEngineRow() {
  return screen.getByText('CROSS-ENGINE VERIFICATION').closest('div')!.parentElement!;
}

describe('CostGuardCard', () => {
  it('always shows Anthropic API and model-calls-by-Aether as disabled, unconditionally', () => {
    render(
      <AetherStoreProvider>
        <CostGuardCard />
      </AetherStoreProvider>,
    );
    expect(screen.getByText(/no sdk installed/i)).toBeTruthy();
    expect(screen.getByText(/zero call sites/i)).toBeTruthy();
  });

  it('shows cross-engine verification as OFF by default', () => {
    render(
      <AetherStoreProvider>
        <CostGuardCard />
      </AetherStoreProvider>,
    );
    const row = screen.getByText('CROSS-ENGINE VERIFY').closest('div')!.parentElement!;
    expect(within(row).getByText('OFF')).toBeTruthy();
  });

  it('shows cross-engine verification as ON when crossEngineCfg.enabled is true', () => {
    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
        <CostGuardCard />
      </AetherStoreProvider>,
    );

    fireEvent.click(within(crossEngineRow()).getByText('ENABLE'));
    fireEvent.click(screen.getByText('I UNDERSTAND, ENABLE'));

    const row = screen.getByText('CROSS-ENGINE VERIFY').closest('div')!.parentElement!;
    expect(within(row).getByText(/^ON/)).toBeTruthy();
  });

  it('shows Auto Headlines as locally computed, no API call', () => {
    render(
      <AetherStoreProvider>
        <CostGuardCard />
      </AetherStoreProvider>,
    );
    expect(screen.getByText(/computed locally, no api call/i)).toBeTruthy();
  });
});
