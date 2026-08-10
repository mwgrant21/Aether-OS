import { describe, it, expect } from 'vitest';
import { assertCrossEngineFeatureEnabled, assertNoActiveVerificationRun } from './verifyDispatchGuard';

// C1: neither connectCodexSubscription nor verifyDispatch may egress
// anything while the operator has not opted in.
describe('assertCrossEngineFeatureEnabled', () => {
  it('throws when the feature is disabled', () => {
    expect(() => assertCrossEngineFeatureEnabled(false)).toThrow('cross-engine verification is disabled');
  });

  it('does not throw when the feature is enabled', () => {
    expect(() => assertCrossEngineFeatureEnabled(true)).not.toThrow();
  });
});

// C2: the "only one verification run" invariant must hold across separate
// verifyDispatch IPC calls, not just within a single CodexVerifier instance.
describe('assertNoActiveVerificationRun', () => {
  it('throws when a run is already active', () => {
    expect(() => assertNoActiveVerificationRun('run-1')).toThrow('a verification run is already in progress');
  });

  it('does not throw when no run is active', () => {
    expect(() => assertNoActiveVerificationRun(null)).not.toThrow();
  });
});
