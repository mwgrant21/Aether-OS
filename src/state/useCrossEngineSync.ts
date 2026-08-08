import { useCallback, useEffect, useRef, useState } from 'react';
import type { VerificationEvent, VerificationResultV1 } from '../shared/crossEngineTypes';

/**
 * Owns one cross-engine verification run's local state.
 *
 * Unlike the app's other useXSync hooks (useLedgerSync, useProjectsSync, ...),
 * this one does NOT dispatch into the global AetherState store -- a
 * verification run belongs to the specific dispatch row/button that started
 * it (spec §9.3: "run state" lives with VerifyWithCodexButton), not to
 * app-wide state. It still follows the same subscribe-via-on* pattern: mount
 * a listener on crossEngine.onUpdate, filter to the run this hook instance
 * started, and unsubscribe on unmount.
 *
 * There is no mount-time pull here (unlike ledger/projects' `.current()`) --
 * a verification run is always started by an explicit user action in THIS
 * hook instance's own lifetime, so there is nothing pre-existing to catch up
 * on.
 */

export type CrossEngineRunState =
  | { status: 'idle' }
  | { status: 'running'; runId: string; phase: Extract<VerificationEvent, { kind: 'status' }>['phase'] }
  | { status: 'done'; runId: string; result: VerificationResultV1 }
  | { status: 'error'; runId: string; code: string; message: string }
  | { status: 'cancelled'; runId: string };

export function useCrossEngineSync() {
  const [state, setState] = useState<CrossEngineRunState>({ status: 'idle' });
  // The runId this hook instance is currently tracking -- events for any
  // other runId (e.g. a stray update after this run already settled, or one
  // belonging to a different button that raced in) must not update our state.
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    const crossEngine = window.aetherElectron?.crossEngine;
    if (!crossEngine) return;

    const unsubscribe = crossEngine.onUpdate((event: VerificationEvent) => {
      if (event.runId !== runIdRef.current) return;
      switch (event.kind) {
        case 'status':
          setState({ status: 'running', runId: event.runId, phase: event.phase });
          break;
        case 'result':
          setState({ status: 'done', runId: event.runId, result: event.result });
          break;
        case 'error':
          setState({ status: 'error', runId: event.runId, code: event.code, message: event.message });
          break;
        case 'cancelled':
          setState({ status: 'cancelled', runId: event.runId });
          break;
      }
    });

    return unsubscribe;
  }, []);

  const start = useCallback(async (toolUseId: string): Promise<void> => {
    const crossEngine = window.aetherElectron?.crossEngine;
    if (!crossEngine) return;
    const { runId } = await crossEngine.verifyDispatch(toolUseId);
    runIdRef.current = runId;
    setState({ status: 'running', runId, phase: 'preparing-evidence' });
  }, []);

  const cancel = useCallback((): void => {
    const crossEngine = window.aetherElectron?.crossEngine;
    const runId = runIdRef.current;
    if (!crossEngine || !runId) return;
    void crossEngine.cancel(runId);
  }, []);

  const reset = useCallback((): void => {
    runIdRef.current = null;
    setState({ status: 'idle' });
  }, []);

  return { state, start, cancel, reset };
}
