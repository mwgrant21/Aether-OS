import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryExtractionCard } from './MemoryExtractionCard';
import { CostGuardCard } from './CostGuardCard';
import { AetherStoreProvider } from '../../state/store';

type Bridge = { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };

function installBridge(bridge: Bridge) {
  (window as unknown as { aetherElectron?: unknown }).aetherElectron = { memoryExtraction: bridge };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

function renderBoth() {
  return render(
    <AetherStoreProvider>
      <MemoryExtractionCard />
      <CostGuardCard />
    </AetherStoreProvider>,
  );
}

function cardHeader() {
  return screen.getByText('MEMORY EXTRACTION', { selector: 'h2' }).parentElement!;
}

function costGuardRow() {
  return screen.getByText('MEMORY EXTRACTION', { selector: 'div' }).parentElement!;
}

describe('MemoryExtractionCard', () => {
  it('is OFF with no bridge and the toggle is inert', () => {
    renderBoth();
    fireEvent.click(within(cardHeader()).getByText('ENABLE'));
    fireEvent.click(screen.getByText('I UNDERSTAND, ENABLE'));
    expect(within(cardHeader()).getByText('ENABLE')).toBeTruthy();
    expect(within(costGuardRow()).getByText('OFF')).toBeTruthy();
  });

  it('hydrates from get() on mount', async () => {
    installBridge({ get: vi.fn().mockResolvedValue(true), set: vi.fn() });
    renderBoth();
    await waitFor(() => expect(within(cardHeader()).getByText('DISABLE')).toBeTruthy());
    expect(within(costGuardRow()).getByText(/^ON/)).toBeTruthy();
  });

  it('does not call set(true) until the disclosure is confirmed', async () => {
    const set = vi.fn().mockResolvedValue(true);
    installBridge({ get: vi.fn().mockResolvedValue(false), set });
    renderBoth();
    fireEvent.click(within(cardHeader()).getByText('ENABLE'));
    expect(set).not.toHaveBeenCalled();
    expect(screen.getByText(/claude CLI \(claude -p --model haiku\)/)).toBeTruthy();
    fireEvent.click(screen.getByText('CANCEL'));
    expect(set).not.toHaveBeenCalled();
    fireEvent.click(within(cardHeader()).getByText('ENABLE'));
    fireEvent.click(screen.getByText('I UNDERSTAND, ENABLE'));
    await waitFor(() => expect(set).toHaveBeenCalledWith(true));
    await waitFor(() => expect(within(cardHeader()).getByText('DISABLE')).toBeTruthy());
  });

  it('disabling needs no confirmation', async () => {
    const set = vi.fn().mockResolvedValue(false);
    installBridge({ get: vi.fn().mockResolvedValue(true), set });
    renderBoth();
    await waitFor(() => expect(within(cardHeader()).getByText('DISABLE')).toBeTruthy());
    fireEvent.click(within(cardHeader()).getByText('DISABLE'));
    await waitFor(() => expect(set).toHaveBeenCalledWith(false));
    await waitFor(() => expect(within(cardHeader()).getByText('ENABLE')).toBeTruthy());
  });

  it('displays the value set() returns even when it differs from the request', async () => {
    const set = vi.fn().mockResolvedValue(false); // write failed: readback is still OFF
    installBridge({ get: vi.fn().mockResolvedValue(false), set });
    renderBoth();
    fireEvent.click(within(cardHeader()).getByText('ENABLE'));
    fireEvent.click(screen.getByText('I UNDERSTAND, ENABLE'));
    await waitFor(() => expect(set).toHaveBeenCalledWith(true));
    expect(within(cardHeader()).getByText('ENABLE')).toBeTruthy();
    expect(within(costGuardRow()).getByText('OFF')).toBeTruthy();
  });
});
