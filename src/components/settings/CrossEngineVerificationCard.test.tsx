import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CrossEngineVerificationCard } from './CrossEngineVerificationCard';
import { AetherStoreProvider } from '../../state/store';

afterEach(() => {
  cleanup();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

describe('CrossEngineVerificationCard', () => {
  it('defaults to disabled', () => {
    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
      </AetherStoreProvider>,
    );
    expect(screen.getByText('ENABLE')).toBeTruthy();
    expect(screen.queryByText('SUBSCRIPTION ONLY')).toBeNull();
  });

  it('requires explicit confirmation before first enablement', () => {
    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
      </AetherStoreProvider>,
    );

    fireEvent.click(screen.getByText('ENABLE'));

    // Disclosure shown, but not yet enabled.
    expect(screen.getByText('I UNDERSTAND, ENABLE')).toBeTruthy();
    expect(screen.queryByText('SUBSCRIPTION ONLY')).toBeNull();
    expect(screen.getByText('ENABLE')).toBeTruthy();

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

    fireEvent.click(screen.getByText('ENABLE'));
    fireEvent.click(screen.getByText('I UNDERSTAND, ENABLE'));

    expect(screen.getByText('SUBSCRIPTION ONLY')).toBeTruthy();
  });

  it('never renders an API key input field anywhere', () => {
    render(
      <AetherStoreProvider>
        <CrossEngineVerificationCard />
      </AetherStoreProvider>,
    );

    fireEvent.click(screen.getByText('ENABLE'));
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

    fireEvent.click(screen.getByText('ENABLE'));
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

    fireEvent.click(screen.getByText('ENABLE'));
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

    fireEvent.click(screen.getByText('ENABLE'));
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
});
