import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { CrossEngineVerificationCard } from './CrossEngineVerificationCard';
import { AetherStoreProvider } from '../../state/store';

afterEach(() => {
  cleanup();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

// The card now renders two independent ENABLE/DISABLE toggles (cross-engine
// verification, and -- added below -- the Codex terminal). Both default to
// showing "ENABLE" text, so every existing test below must scope its query
// to the cross-engine row specifically rather than a bare screen.getByText.
function crossEngineRow() {
  // The title is now a real <h2> (pass 2's AC2), so its own parent is the
  // flex header row -- no need to climb via .closest('div') first, which
  // would land one level too high (the card root) and re-admit the Codex
  // terminal sub-panel's own ENABLE/DISABLE button into scope.
  return screen.getByText('CROSS-ENGINE VERIFICATION').parentElement!;
}

describe('CrossEngineVerificationCard', () => {
  it('defaults to disabled', () => {
    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
      </AetherStoreProvider>,
    );
    expect(within(crossEngineRow()).getByText('ENABLE')).toBeTruthy();
    expect(screen.queryByText('SUBSCRIPTION ONLY')).toBeNull();
  });

  it('requires explicit confirmation before first enablement', () => {
    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
      </AetherStoreProvider>,
    );

    fireEvent.click(within(crossEngineRow()).getByText('ENABLE'));

    // Disclosure shown, but not yet enabled.
    expect(screen.getByText('I UNDERSTAND, ENABLE')).toBeTruthy();
    expect(screen.queryByText('SUBSCRIPTION ONLY')).toBeNull();
    expect(within(crossEngineRow()).getByText('ENABLE')).toBeTruthy();

    fireEvent.click(screen.getByText('I UNDERSTAND, ENABLE'));

    expect(screen.getByText('SUBSCRIPTION ONLY')).toBeTruthy();
    expect(screen.getByText('DISABLE')).toBeTruthy();
  });

  it('shows SUBSCRIPTION ONLY billing label when enabled', () => {
    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
      </AetherStoreProvider>,
    );

    fireEvent.click(within(crossEngineRow()).getByText('ENABLE'));
    fireEvent.click(screen.getByText('I UNDERSTAND, ENABLE'));

    expect(screen.getByText('SUBSCRIPTION ONLY')).toBeTruthy();
  });

  it('never renders an API key input field anywhere', () => {
    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
      </AetherStoreProvider>,
    );

    fireEvent.click(within(crossEngineRow()).getByText('ENABLE'));
    fireEvent.click(screen.getByText('I UNDERSTAND, ENABLE'));

    expect(screen.queryByLabelText(/api key/i)).toBeNull();
    expect(document.querySelector('input')).toBeNull();
  });

  // I6: a rejected status() promise (e.g. resolveAdapterExecutable() throwing
  // synchronously in main) must not become a silent unhandled rejection --
  // the card must surface some status rather than hanging on the old value.
  it('does not leave an unhandled rejection when status() rejects', async () => {
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      crossEngine: {
        status: vi.fn().mockRejectedValue(new Error('adapter not resolvable')),
        setEnabled: vi.fn(),
      },
    };

    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
      </AetherStoreProvider>,
    );

    fireEvent.click(within(crossEngineRow()).getByText('ENABLE'));
    fireEvent.click(screen.getByText('I UNDERSTAND, ENABLE'));

    await waitFor(() => expect(screen.getByText('ERROR')).toBeTruthy());
  });

  // Same class of gap as the status() case above, on the other IPC call this
  // card makes: a rejected connectCodexSubscription() (e.g. the adapter
  // crashing mid-handshake) must not become a silent unhandled rejection --
  // clicking CONNECT CHATGPT must always leave a visible status behind.
  it('does not leave an unhandled rejection when connectCodexSubscription() rejects', async () => {
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      crossEngine: {
        status: vi.fn().mockResolvedValue('sign-in-required'),
        connectCodexSubscription: vi.fn().mockRejectedValue(new Error('adapter crashed')),
        setEnabled: vi.fn(),
      },
    };

    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
      </AetherStoreProvider>,
    );

    fireEvent.click(within(crossEngineRow()).getByText('ENABLE'));
    fireEvent.click(screen.getByText('I UNDERSTAND, ENABLE'));
    await waitFor(() => expect(screen.getByText('SIGN-IN-REQUIRED')).toBeTruthy());

    fireEvent.click(screen.getByText('CONNECT CHATGPT'));

    await waitFor(() => expect(screen.getByText('ERROR')).toBeTruthy());
  });

  // connectCodexSubscription() is the real ChatGPT login: if the operator is
  // not already signed in, main.ts's handler blocks until a browser OAuth flow
  // completes, which is human-scale time. The button must say so rather than
  // looking inert, and must not queue a second login on a double click.
  it('shows a pending state while the ChatGPT login is outstanding', async () => {
    let resolveConnect!: (s: string) => void;
    const connectCodexSubscription = vi.fn(
      () => new Promise<string>((res) => { resolveConnect = res; }),
    );
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      crossEngine: {
        status: vi.fn().mockResolvedValue('sign-in-required'),
        connectCodexSubscription,
        setEnabled: vi.fn(),
      },
    };

    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
      </AetherStoreProvider>,
    );

    fireEvent.click(within(crossEngineRow()).getByText('ENABLE'));
    fireEvent.click(screen.getByText('I UNDERSTAND, ENABLE'));
    await waitFor(() => expect(screen.getByText('SIGN-IN-REQUIRED')).toBeTruthy());

    fireEvent.click(screen.getByText('CONNECT CHATGPT'));

    await waitFor(() => expect(screen.getByText('CONNECTING...')).toBeTruthy());
    expect(screen.getByText(/Complete the ChatGPT sign-in in your browser/)).toBeTruthy();

    // A second click while the login is outstanding must not start another one.
    fireEvent.click(screen.getByText('CONNECTING...'));
    expect(connectCodexSubscription).toHaveBeenCalledTimes(1);

    resolveConnect('ready-subscription');

    await waitFor(() => expect(screen.getByText('READY-SUBSCRIPTION')).toBeTruthy());
    expect(screen.getByText('RECONNECT')).toBeTruthy();
  });

  it('Codex terminal toggle defaults off and flips SET_CODEX_TERMINAL_CFG on click', () => {
    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
      </AetherStoreProvider>,
    );
    // Same fix as crossEngineRow() above: the title is now an <h2>, so its
    // own parent is already the flex header row containing the toggle.
    const codexRow = screen.getByText('CODEX TERMINAL').parentElement!;
    expect(within(codexRow).getByText('ENABLE')).toBeTruthy();

    fireEvent.click(within(codexRow).getByText('ENABLE'));

    expect(within(codexRow).getByText('DISABLE')).toBeTruthy();
  });
});
