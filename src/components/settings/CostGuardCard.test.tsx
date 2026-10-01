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
  // The title is now a real <h2> (pass 2's AC2), so its own parent is the
  // flex header row -- .closest('div') would climb one level too high (the
  // card root) and re-admit the Codex terminal sub-panel's own ENABLE button.
  return screen.getByText('CROSS-ENGINE VERIFICATION').parentElement!;
}

describe('CostGuardCard', () => {
  it('always shows Anthropic API and model-calls-by-Aether as disabled, unconditionally', () => {
    render(
      <AetherStoreProvider>
        <CostGuardCard />
      </AetherStoreProvider>,
    );
    expect(screen.getByText(/no sdk installed/i)).toBeTruthy();
    expect(screen.getByText(/no sdk or http call sites/i)).toBeTruthy();
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

describe('CostGuardCard memory extraction row', () => {
  it('is OFF by default and states what ON sends and where', () => {
    render(
      <AetherStoreProvider>
        <CostGuardCard />
      </AetherStoreProvider>,
    );
    const row = screen.getByText('MEMORY EXTRACTION').closest('div')!.parentElement!;
    expect(within(row).getByText('OFF')).toBeTruthy();
    // The always-visible hint names the path and what it sends.
    expect(screen.getByText(/dispatch result\s+text to your Claude account through the claude CLI/i)).toBeTruthy();
  });
});

describe('CostGuardCard hint wording', () => {
  it('scopes the memory-extraction claim instead of calling it the only Claude-CLI path', () => {
    render(
      <AetherStoreProvider>
        <CostGuardCard />
      </AetherStoreProvider>,
    );
    expect(screen.getByText(/memory extraction is the one background, Aether-initiated Claude model call/i)).toBeTruthy();
    expect(screen.queryByText(/the one Claude-CLI path/i)).toBeNull();
  });
});
