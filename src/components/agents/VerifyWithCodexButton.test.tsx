import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { VerifyWithCodexButton } from './VerifyWithCodexButton';
import type { VerificationEvent } from '../../shared/crossEngineTypes';

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
      crossEngine: {
        verifyDispatch: vi.fn().mockResolvedValue({ runId: 'run-1' }),
        cancel: vi.fn().mockResolvedValue(undefined),
        onUpdate: vi.fn().mockReturnValue(() => {}),
      },
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

  it('shows run-state phase and a cancel action while a run is active', async () => {
    let listener: ((event: VerificationEvent) => void) | null = null;
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      crossEngine: {
        verifyDispatch: vi.fn().mockResolvedValue({ runId: 'run-1' }),
        cancel: vi.fn().mockResolvedValue(undefined),
        onUpdate: vi.fn((cb: (event: VerificationEvent) => void) => {
          listener = cb;
          return () => {};
        }),
      },
    };

    render(
      <AetherStoreProvider>
        <EnableCrossEngine />
        <VerifyWithCodexButton toolUseId="tu_42" evidenceSufficient={true} />
      </AetherStoreProvider>,
    );

    fireEvent.click(screen.getByText('VERIFY WITH CODEX'));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      listener!({ kind: 'status', runId: 'run-1', phase: 'verifying' });
    });

    expect(screen.getByText('Verifying…')).toBeTruthy();
    const cancelButton = screen.getByText('CANCEL');
    fireEvent.click(cancelButton);
    expect(window.aetherElectron?.crossEngine?.cancel).toHaveBeenCalledWith('run-1');
  });

  it('shows the result once a result event arrives, with a dismiss action', async () => {
    let listener: ((event: VerificationEvent) => void) | null = null;
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      crossEngine: {
        verifyDispatch: vi.fn().mockResolvedValue({ runId: 'run-1' }),
        cancel: vi.fn().mockResolvedValue(undefined),
        onUpdate: vi.fn((cb: (event: VerificationEvent) => void) => {
          listener = cb;
          return () => {};
        }),
      },
    };

    render(
      <AetherStoreProvider>
        <EnableCrossEngine />
        <VerifyWithCodexButton toolUseId="tu_42" evidenceSufficient={true} />
      </AetherStoreProvider>,
    );

    fireEvent.click(screen.getByText('VERIFY WITH CODEX'));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      listener!({
        kind: 'result',
        runId: 'run-1',
        result: {
          schemaVersion: 1,
          verdict: 'contradicted',
          confidence: 0.5,
          summary: 'claim not supported',
          findings: [{ severity: 'error', claim: 'x did y', evidence: 'no such call', file: 'src/a.ts', line: 12 }],
          tests: [{ command: 'npm test', outcome: 'failed', detail: '1 failing' }],
          limitations: ['no network access'],
        },
      });
    });

    expect(screen.getByText(/CONTRADICTED/)).toBeTruthy();
    expect(screen.getByText('claim not supported')).toBeTruthy();
    expect(screen.getByText(/x did y/)).toBeTruthy();
    fireEvent.click(screen.getByText('DISMISS'));
    expect(screen.getByText('VERIFY WITH CODEX')).toBeTruthy();
  });

  it('shows an error event with a dismiss action', async () => {
    let listener: ((event: VerificationEvent) => void) | null = null;
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      crossEngine: {
        verifyDispatch: vi.fn().mockResolvedValue({ runId: 'run-1' }),
        cancel: vi.fn().mockResolvedValue(undefined),
        onUpdate: vi.fn((cb: (event: VerificationEvent) => void) => {
          listener = cb;
          return () => {};
        }),
      },
    };

    render(
      <AetherStoreProvider>
        <EnableCrossEngine />
        <VerifyWithCodexButton toolUseId="tu_42" evidenceSufficient={true} />
      </AetherStoreProvider>,
    );

    fireEvent.click(screen.getByText('VERIFY WITH CODEX'));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      listener!({ kind: 'error', runId: 'run-1', code: 'RESULT_INVALID', message: 'Verification failed before it could start; see main process logs for details' });
    });

    expect(screen.getByText(/RESULT_INVALID/)).toBeTruthy();
    fireEvent.click(screen.getByText('DISMISS'));
    expect(screen.getByText('VERIFY WITH CODEX')).toBeTruthy();
  });
});
