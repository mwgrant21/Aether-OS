import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

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
    expect(screen.getByText(/within about 30 seconds/)).toBeTruthy();
    expect(screen.getByText(/up to 20 memories previously extracted for that agent/)).toBeTruthy();
    await flush(); // a deferred (microtask/timer) set() must be caught too
    expect(set).not.toHaveBeenCalled();
    expect(within(cardHeader()).getByText('ENABLE')).toBeTruthy();
    expect(within(costGuardRow()).getByText('OFF')).toBeTruthy();
    fireEvent.click(screen.getByText('CANCEL'));
    await flush();
    expect(set).not.toHaveBeenCalled();
    expect(within(cardHeader()).getByText('ENABLE')).toBeTruthy();
    expect(within(costGuardRow()).getByText('OFF')).toBeTruthy();
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

  it('scopes the OFF hint to the collector memory extraction', () => {
    renderBoth();
    expect(screen.getByText('OFF. The collector sends nothing for memory extraction while this is off.')).toBeTruthy();
    expect(screen.queryByText(/nothing is sent to a model/i)).toBeNull();
  });

  it('when set() rejects, shows the on-disk value from get(), not a hard OFF', async () => {
    const get = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(true);
    installBridge({ get, set: vi.fn().mockRejectedValue(new Error('ipc')) });
    renderBoth();
    await waitFor(() => expect(within(cardHeader()).getByText('DISABLE')).toBeTruthy());
    fireEvent.click(within(cardHeader()).getByText('DISABLE'));
    await flush();
    expect(get).toHaveBeenCalledTimes(2);
    expect(within(cardHeader()).getByText('DISABLE')).toBeTruthy();
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
