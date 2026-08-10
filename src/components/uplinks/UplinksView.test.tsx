import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UplinksView } from './UplinksView';
import { AetherStoreProvider } from '../../state/store';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

describe('UplinksView', () => {
  it('renders Aether Core as OFFLINE by default (terminalAlive defaults false)', () => {
    // No pty is started until the Terminal tab mounts, so a launch that lands
    // on Uplinks has no terminal to report. It stays OFFLINE until main
    // actually pushes pty:alive.
    render(
      <AetherStoreProvider>
        <UplinksView />
      </AetherStoreProvider>,
    );
    expect(screen.getByText('Aether Core')).toBeTruthy();
    // Two rows exist; scope to the row containing "Aether Core" to avoid
    // matching the OpenAI/Codex row's own badge.
    const row = screen.getByText('Aether Core').closest('div');
    expect(row?.textContent).toContain('OFFLINE');
  });

  it('renders Aether Core as ONLINE when terminalAlive is true', () => {
    // Seed the persisted-state merge store.tsx performs on mount -- the same
    // mechanism a real pty:alive event feeds via useTerminalAliveSync/
    // SET_TERMINAL_ALIVE, just pre-seeded here since terminalAlive itself is
    // deliberately excluded from persistence (see PERSISTENCE_EXCLUSIONS).
    localStorage.setItem('aetheros-v1', JSON.stringify({ terminalAlive: true }));
    render(
      <AetherStoreProvider>
        <UplinksView />
      </AetherStoreProvider>,
    );
    const row = screen.getByText('Aether Core').closest('div');
    expect(row?.textContent).toContain('ONLINE');
  });

  it('renders Codex Terminal as OFFLINE by default (codexTerminalAlive defaults false)', () => {
    // No Codex pty is started until the Codex sidebar view mounts, so a
    // launch that lands on Uplinks has no Codex terminal to report either --
    // same reasoning as the Aether Core row above, independent signal.
    render(
      <AetherStoreProvider>
        <UplinksView />
      </AetherStoreProvider>,
    );
    const row = screen.getByText('Codex Terminal').closest('div');
    expect(row?.textContent).toContain('OFFLINE');
  });

  it('renders Codex Terminal as ONLINE when codexTerminalAlive is true, independent of OpenAI/Codex', () => {
    // Seed the persisted-state merge store.tsx performs on mount, same
    // mechanism the Aether Core test above uses -- codexTerminalAlive is
    // excluded from persistence but this mirrors what a real
    // codexPty:alive push via useCodexTerminalAliveSync/
    // SET_CODEX_TERMINAL_ALIVE does to state.
    localStorage.setItem('aetheros-v1', JSON.stringify({ codexTerminalAlive: true }));
    render(
      <AetherStoreProvider>
        <UplinksView />
      </AetherStoreProvider>,
    );
    const codexTerminalRow = screen.getByText('Codex Terminal').closest('div');
    expect(codexTerminalRow?.textContent).toContain('ONLINE');
    // The verifier connection row must stay independent -- it was never
    // enabled here, so it must still read OFFLINE.
    const verifierRow = screen.getByText('OpenAI/Codex').closest('div');
    expect(verifierRow?.textContent).toContain('OFFLINE');
  });

  it('renders OpenAI/Codex as OFFLINE with an explanatory disabled button when cross-engine is not enabled', () => {
    render(
      <AetherStoreProvider>
        <UplinksView />
      </AetherStoreProvider>,
    );
    const row = screen.getByText('OpenAI/Codex').closest('div');
    expect(row?.textContent).toContain('OFFLINE');
    const button = screen.getByText('ENABLE IN SETTINGS') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('renders OpenAI/Codex as ONLINE when cross-engine is enabled and status resolves ready-subscription', async () => {
    localStorage.setItem('aetheros-v1', JSON.stringify({ crossEngineCfg: { enabled: true, provider: 'codex-chatgpt' } }));
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      crossEngine: {
        status: vi.fn().mockResolvedValue('ready-subscription'),
        connectCodexSubscription: vi.fn().mockResolvedValue('ready-subscription'),
        setEnabled: vi.fn(),
      },
    };

    render(
      <AetherStoreProvider>
        <UplinksView />
      </AetherStoreProvider>,
    );

    await waitFor(() => {
      const row = screen.getByText('OpenAI/Codex').closest('div');
      expect(row?.textContent).toContain('ONLINE');
    });
    expect(screen.getByText('RECONNECT')).toBeTruthy();
  });

  it('OpenAI/Codex button calls connectCodexSubscription when clicked', async () => {
    const connectCodexSubscription = vi.fn().mockResolvedValue('ready-subscription');
    localStorage.setItem('aetheros-v1', JSON.stringify({ crossEngineCfg: { enabled: true, provider: 'codex-chatgpt' } }));
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      crossEngine: {
        status: vi.fn().mockResolvedValue('sign-in-required'),
        connectCodexSubscription,
        setEnabled: vi.fn(),
      },
    };

    render(
      <AetherStoreProvider>
        <UplinksView />
      </AetherStoreProvider>,
    );

    const button = await screen.findByText('CONNECT');
    fireEvent.click(button);

    await waitFor(() => expect(connectCodexSubscription).toHaveBeenCalledTimes(1));
  });

  it('pushes crossEngine.setEnabled(true) on mount when crossEngineCfg.enabled is true', async () => {
    const setEnabled = vi.fn();
    localStorage.setItem('aetheros-v1', JSON.stringify({ crossEngineCfg: { enabled: true, provider: 'codex-chatgpt' } }));
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      crossEngine: {
        status: vi.fn().mockResolvedValue('sign-in-required'),
        connectCodexSubscription: vi.fn().mockResolvedValue('ready-subscription'),
        setEnabled,
      },
    };

    render(
      <AetherStoreProvider>
        <UplinksView />
      </AetherStoreProvider>,
    );

    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(true));
  });

  it('does not leave an unhandled rejection when connectCodexSubscription() rejects, and surfaces an error state', async () => {
    const connectCodexSubscription = vi.fn().mockRejectedValue(new Error('cross-engine feature not enabled'));
    localStorage.setItem('aetheros-v1', JSON.stringify({ crossEngineCfg: { enabled: true, provider: 'codex-chatgpt' } }));
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      crossEngine: {
        status: vi.fn().mockResolvedValue('sign-in-required'),
        connectCodexSubscription,
        setEnabled: vi.fn(),
      },
    };

    render(
      <AetherStoreProvider>
        <UplinksView />
      </AetherStoreProvider>,
    );

    const button = await screen.findByText('CONNECT');
    fireEvent.click(button);

    await waitFor(() => expect(connectCodexSubscription).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const row = screen.getByText('OpenAI/Codex').closest('div');
      expect(row?.textContent).toContain('OFFLINE');
    });
  });

  it('never renders a Local Ollama row', () => {
    render(
      <AetherStoreProvider>
        <UplinksView />
      </AetherStoreProvider>,
    );
    expect(screen.queryByText('Local Ollama')).toBeNull();
    expect(screen.queryByText(/ollama/i)).toBeNull();
  });

  it('never renders a Default Runtime section', () => {
    render(
      <AetherStoreProvider>
        <UplinksView />
      </AetherStoreProvider>,
    );
    expect(screen.queryByText('DEFAULT RUNTIME')).toBeNull();
    expect(screen.queryByText('Auto')).toBeNull();
  });
});
