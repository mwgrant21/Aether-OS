import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { VerifyWithCodexButton } from './VerifyWithCodexButton';

afterEach(cleanup);

function EnableCrossEngine() {
  const { dispatch } = useAetherStore();
  useEffect(() => {
    dispatch({ type: 'SET_CROSS_ENGINE_CFG', cfg: { enabled: true, provider: 'codex-chatgpt' } });
  }, [dispatch]);
  return null;
}

describe('VerifyWithCodexButton', () => {
  beforeEach(() => {
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      crossEngine: { verifyDispatch: vi.fn().mockResolvedValue({ runId: 'run-1' }) },
    };
  });

  it('is disabled with a named reason when the feature is off', () => {
    render(
      <AetherStoreProvider>
        <VerifyWithCodexButton toolUseId="tu_1" evidenceSufficient={true} />
      </AetherStoreProvider>,
    );

    const button = screen.getByText('VERIFY WITH CODEX') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Cross-engine verification is off');
  });

  it('is disabled with a named reason when evidence is insufficient', () => {
    render(
      <AetherStoreProvider>
        <EnableCrossEngine />
        <VerifyWithCodexButton toolUseId="tu_1" evidenceSufficient={false} />
      </AetherStoreProvider>,
    );

    const button = screen.getByText('VERIFY WITH CODEX') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Evidence unavailable for this dispatch');
  });

  it('invokes verifyDispatch with the given toolUseId when clicked and enabled', async () => {
    render(
      <AetherStoreProvider>
        <EnableCrossEngine />
        <VerifyWithCodexButton toolUseId="tu_42" evidenceSufficient={true} />
      </AetherStoreProvider>,
    );

    const button = screen.getByText('VERIFY WITH CODEX') as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);

    expect(window.aetherElectron?.crossEngine?.verifyDispatch).toHaveBeenCalledWith('tu_42');
  });
});
