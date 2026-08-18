import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { PlanUsageCard } from './PlanUsageCard';
import type { AetherState } from '../../state/types';

afterEach(() => {
  cleanup();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

function Setter({ patch }: { patch: Partial<AetherState> }) {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    if (patch.terminalAlive !== undefined) dispatch({ type: 'SET_TERMINAL_ALIVE', alive: patch.terminalAlive });
    if (patch.planUsageTier !== undefined && patch.planUsageTier !== null) {
      dispatch({ type: 'SET_PLAN_USAGE_TIER', snapshot: patch.planUsageTier });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);
  return null;
}

function renderWithState(patch: Partial<AetherState> = {}) {
  return render(
    <AetherStoreProvider>
      <Setter patch={patch} />
      <PlanUsageCard />
    </AetherStoreProvider>,
  );
}

describe('PlanUsageCard', () => {
  it('shows a "—" tier badge and "never synced" when planUsageTier is null', () => {
    renderWithState({ terminalAlive: true });
    expect(screen.getByText('PLAN USAGE')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText(/never synced/)).toBeTruthy();
  });

  it('shows "no reading yet" for Session/Week bars when statusline is null', () => {
    renderWithState({ terminalAlive: true });
    expect(screen.getAllByText('no reading yet').length).toBeGreaterThanOrEqual(2);
  });

  it('shows the PRO tier badge and no model bar after a successful Pro sync', () => {
    renderWithState({ terminalAlive: true, planUsageTier: { tier: 'pro', weekModel: null, capturedAtMs: Date.now() } });
    expect(screen.getByText('PRO')).toBeTruthy();
    expect(screen.queryByText('WEEK (MODEL)')).toBeNull();
  });

  it('shows the MAX tier badge and the model bar after a successful Max sync', () => {
    renderWithState({ terminalAlive: true, planUsageTier: { tier: 'max', weekModel: { pct: 52 }, capturedAtMs: Date.now() } });
    expect(screen.getByText('MAX')).toBeTruthy();
    expect(screen.getByText('WEEK (MODEL)')).toBeTruthy();
    expect(screen.getByText('52%')).toBeTruthy();
  });

  it('disables the Sync button when the Terminal pty is not alive', () => {
    renderWithState({ terminalAlive: false });
    expect(screen.getByText('Sync').closest('button')).toBeDisabled();
  });

  it('clicking Sync calls window.aetherElectron.plan.sync() and dispatches the result on success', async () => {
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      plan: {
        sync: vi.fn().mockResolvedValue({ ok: true, tier: 'max', weekModel: { pct: 61 }, capturedAtMs: Date.now() }),
      },
    };
    renderWithState({ terminalAlive: true });
    fireEvent.click(screen.getByText('Sync'));
    await waitFor(() => expect(screen.getByText('MAX')).toBeTruthy());
    expect(screen.getByText('61%')).toBeTruthy();
  });

  it('shows "last sync failed" and keeps the last-good snapshot on a failed sync', async () => {
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      plan: { sync: vi.fn().mockResolvedValue({ ok: false, error: 'could not read /usage' }) },
    };
    renderWithState({ terminalAlive: true, planUsageTier: { tier: 'pro', weekModel: null, capturedAtMs: Date.now() } });
    fireEvent.click(screen.getByText('Sync'));
    await waitFor(() => expect(screen.getByText(/last sync failed/)).toBeTruthy());
    expect(screen.getByText('PRO')).toBeTruthy();
  });
});
