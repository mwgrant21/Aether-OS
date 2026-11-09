import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { OptimizeView } from './OptimizeView';

afterEach(() => {
  cleanup();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

let dispatchRef: ReturnType<typeof useAetherStore>['dispatch'] | null = null;
function DispatchProbe() {
  dispatchRef = useAetherStore().dispatch;
  return null;
}

function setup(applyResult: unknown) {
  const apply = vi.fn().mockResolvedValue(applyResult);
  const optimize = {
    targets: vi.fn().mockResolvedValue({ global: { path: '/g/CLAUDE.md', exists: true }, project: null }),
    apply,
  };
  (window as unknown as { aetherElectron?: unknown }).aetherElectron = { optimize };
  render(
    <AetherStoreProvider>
      <DispatchProbe />
      <OptimizeView />
    </AetherStoreProvider>,
  );
  act(() => {
    dispatchRef!({
      type: 'SET_OPTIMIZE_FINDINGS',
      findings: [{ id: 'cost-of-thrash', title: 'T', detail: 'D', estSavingsPerWeek: 2, fixText: '' }],
    });
  });
  return apply;
}

async function openPickerAndChooseGlobal() {
  fireEvent.click(screen.getByRole('button', { name: 'Apply fix' }));
  fireEvent.click(await screen.findByText(/Global/));
}

describe('OptimizeView apply status', () => {
  it('shows the applied message after the picker closes', async () => {
    setup({ ok: true });
    await openPickerAndChooseGlobal();
    expect(await screen.findByText('Applied to CLAUDE.md (backed up)')).toBeTruthy();
    expect(screen.queryByText(/Global/)).toBeNull();
    expect(screen.getByText(/1 applied/)).toBeTruthy();
  });

  it("shows 'Already applied' when the bullet was already present", async () => {
    setup({ ok: true, alreadyPresent: true });
    await openPickerAndChooseGlobal();
    expect(await screen.findByText('Already applied')).toBeTruthy();
    expect(screen.queryByText(/Global/)).toBeNull();
  });

  it('keeps showing an apply error (regression guard, green before and after the move; not red-provable)', async () => {
    setup({ ok: false, error: 'boom' });
    await openPickerAndChooseGlobal();
    expect(await screen.findByText('boom')).toBeTruthy();
    expect(screen.getByText(/Global/)).toBeTruthy();
  });
});
