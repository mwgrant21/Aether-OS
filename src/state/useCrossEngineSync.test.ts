import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCrossEngineSync } from './useCrossEngineSync';
import type { VerificationEvent, VerificationResultV1 } from '../shared/crossEngineTypes';

describe('useCrossEngineSync', () => {
  let listener: ((event: VerificationEvent) => void) | null;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let cancelMock: ReturnType<typeof vi.fn>;
  let verifyDispatchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listener = null;
    unsubscribe = vi.fn();
    cancelMock = vi.fn().mockResolvedValue(undefined);
    verifyDispatchMock = vi.fn().mockResolvedValue({ runId: 'run-1' });
    (window as unknown as { aetherElectron: unknown }).aetherElectron = {
      crossEngine: {
        verifyDispatch: verifyDispatchMock,
        cancel: cancelMock,
        onUpdate: vi.fn((cb: (event: VerificationEvent) => void) => {
          listener = cb;
          return unsubscribe;
        }),
      },
    };
  });

  afterEach(() => {
    delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
  });

  it('starts idle', () => {
    const { result } = renderHook(() => useCrossEngineSync());
    expect(result.current.state).toEqual({ status: 'idle' });
  });

  it('transitions to running with the returned runId on start', async () => {
    const { result } = renderHook(() => useCrossEngineSync());
    await act(async () => {
      await result.current.start('tu_1');
    });
    expect(verifyDispatchMock).toHaveBeenCalledWith('tu_1');
    expect(result.current.state).toEqual({ status: 'running', runId: 'run-1', phase: 'preparing-evidence' });
  });

  it('updates phase from status events matching the active runId', async () => {
    const { result } = renderHook(() => useCrossEngineSync());
    await act(async () => {
      await result.current.start('tu_1');
    });
    act(() => {
      listener!({ kind: 'status', runId: 'run-1', phase: 'verifying' });
    });
    expect(result.current.state).toEqual({ status: 'running', runId: 'run-1', phase: 'verifying' });
  });

  it('ignores events for a different runId', async () => {
    const { result } = renderHook(() => useCrossEngineSync());
    await act(async () => {
      await result.current.start('tu_1');
    });
    act(() => {
      listener!({ kind: 'status', runId: 'some-other-run', phase: 'verifying' });
    });
    expect(result.current.state).toEqual({ status: 'running', runId: 'run-1', phase: 'preparing-evidence' });
  });

  it('captures a result event as done', async () => {
    const { result } = renderHook(() => useCrossEngineSync());
    await act(async () => {
      await result.current.start('tu_1');
    });
    const verificationResult: VerificationResultV1 = {
      schemaVersion: 1,
      verdict: 'supported',
      confidence: 0.9,
      summary: 'looks good',
      findings: [],
      tests: [],
      limitations: [],
    };
    act(() => {
      listener!({ kind: 'result', runId: 'run-1', result: verificationResult });
    });
    expect(result.current.state).toEqual({ status: 'done', runId: 'run-1', result: verificationResult });
  });

  it('captures an error event', async () => {
    const { result } = renderHook(() => useCrossEngineSync());
    await act(async () => {
      await result.current.start('tu_1');
    });
    act(() => {
      listener!({ kind: 'error', runId: 'run-1', code: 'RESULT_INVALID', message: 'boom' });
    });
    expect(result.current.state).toEqual({ status: 'error', runId: 'run-1', code: 'RESULT_INVALID', message: 'boom' });
  });

  it('captures a cancelled event', async () => {
    const { result } = renderHook(() => useCrossEngineSync());
    await act(async () => {
      await result.current.start('tu_1');
    });
    act(() => {
      listener!({ kind: 'cancelled', runId: 'run-1' });
    });
    expect(result.current.state).toEqual({ status: 'cancelled', runId: 'run-1' });
  });

  it('cancel() calls crossEngine.cancel with the active runId', async () => {
    const { result } = renderHook(() => useCrossEngineSync());
    await act(async () => {
      await result.current.start('tu_1');
    });
    act(() => {
      result.current.cancel();
    });
    expect(cancelMock).toHaveBeenCalledWith('run-1');
  });

  it('reset() returns to idle', async () => {
    const { result } = renderHook(() => useCrossEngineSync());
    await act(async () => {
      await result.current.start('tu_1');
    });
    act(() => {
      result.current.reset();
    });
    expect(result.current.state).toEqual({ status: 'idle' });
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useCrossEngineSync());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
