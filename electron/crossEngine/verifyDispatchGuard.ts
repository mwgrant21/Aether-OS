// Pure, main-process-agnostic guards for the two cross-engine IPC handlers
// that actually egress data (crossEngine:connectCodexSubscription,
// crossEngine:verifyDispatch). Extracted out of main.ts so the "opt-in gate"
// and "only one run at a time" invariants are unit-testable without needing
// to boot Electron's app/ipcMain machinery in a test.

/** Throws unless the operator has explicitly opted into cross-engine
 *  verification (state.crossEngineCfg.enabled, pushed to main via
 *  crossEngine:setEnabled). Both connectCodexSubscription and verifyDispatch
 *  must call this before any adapter spawn or evidence resolution. */
export function assertCrossEngineFeatureEnabled(featureEnabled: boolean): void {
  if (!featureEnabled) throw new Error('cross-engine verification is disabled');
}

/** Throws if a verification run is already active. `activeRunId` is the
 *  module-level id main.ts tracks across separate verifyDispatch IPC calls --
 *  CodexVerifier's own activeRunId guard is an instance field and does not
 *  span calls, since a fresh CodexVerifier is constructed per call. */
export function assertNoActiveVerificationRun(activeRunId: string | null): void {
  if (activeRunId) throw new Error('a verification run is already in progress');
}
