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
  vi.useRealTimers();
  cleanup();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

// Requires vi.useFakeTimers() to be active BEFORE the action under test, so a timer
// of any length scheduled by a deferred-set mutant is run here.
async function flush() {
  await act(() => vi.runAllTimersAsync());
}

async function settle() {
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
    await act(async () => {}); // let mount hydration settle on real timers
    vi.useFakeTimers();
    fireEvent.click(within(cardHeader()).getByText('ENABLE'));
    expect(set).not.toHaveBeenCalled();
    expect(screen.getByText(/claude CLI \(claude -p --model haiku\)/)).toBeTruthy();
    expect(screen.getByText(/usually within about 30 seconds/)).toBeTruthy();
    expect(screen.getByText(/up to 20 memories previously extracted for that agent/)).toBeTruthy();
    await flush(); // fake timers: a deferred set() of any delay must be caught
    expect(set).not.toHaveBeenCalled();
    expect(within(cardHeader()).getByText('ENABLE')).toBeTruthy();
    expect(within(costGuardRow()).getByText('OFF')).toBeTruthy();
    fireEvent.click(screen.getByText('CANCEL'));
    await flush();
    expect(set).not.toHaveBeenCalled();
    expect(within(cardHeader()).getByText('ENABLE')).toBeTruthy();
    expect(within(costGuardRow()).getByText('OFF')).toBeTruthy();
    vi.useRealTimers();
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
    await settle();
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

describe('MemoryExtractionCard disclosure wording', () => {
  it('states exactly which env vars are removed and that Claude Code adds its own context and hooks', () => {
    installBridge({ get: vi.fn().mockResolvedValue(false), set: vi.fn() });
    renderBoth();
    fireEvent.click(within(cardHeader()).getByText('ENABLE'));
    expect(
      screen.getByText(/ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL are removed from its environment; otherwise it uses whatever Claude Code is set up to use \(your login, or an apiKeyHelper, settings key or Bedrock\/Vertex if you configured one\)/),
    ).toBeTruthy();
    expect(screen.queryByText(/API keys are stripped/i)).toBeNull();
    expect(
      screen.getByText(/Claude Code also adds its own context to each call \(for example your CLAUDE\.md files\) and runs your configured hooks\./),
    ).toBeTruthy();
    expect(screen.getByText(/dispatches the collector picks up after you enable it/)).toBeTruthy();
  });
});
