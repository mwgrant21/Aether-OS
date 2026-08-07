import { describe, it, expect } from 'vitest';
import { narrationForEvent, rankForInterruption, INTERRUPTION_WINDOW_MS } from './narrationFeed';
import { initialState } from '../../state/initialState';
import type { AetherState } from '../../state/types';
import { AETHER_CHANNEL_ID } from './commsChannels';

function stateWith(patch: Partial<AetherState>): AetherState {
  return { ...initialState, ...patch };
}

describe('narrationForEvent: event -> voice mapping per role', () => {
  it('maps a dispatchCompleted event to the resolved role via resolveVoiceRole and its own dispatch channel', () => {
    const state = stateWith({});
    const message = narrationForEvent(
      { kind: 'dispatchCompleted', toolUseId: 'tu-1', subagentType: 'general-purpose', severity: 2 },
      state
    );
    expect(message).not.toBeNull();
    expect(message!.role).toBe('FORGE'); // 'general-purpose' -> FORGE per agentVoiceRoles.ts
    expect(message!.channelId).toBe('dispatch:tu-1');
  });

  it('maps a code-reviewer dispatchCompleted event to CINDER', () => {
    const state = stateWith({});
    const message = narrationForEvent(
      { kind: 'dispatchCompleted', toolUseId: 'tu-2', subagentType: 'code-reviewer', severity: 1 },
      state
    );
    expect(message!.role).toBe('CINDER');
    expect(message!.voiceName).toBe('CINDER');
  });

  it('binds anomalyDetected, postToolFlag, and permissionPending to STEWARD on the AETHER channel', () => {
    const state = stateWith({});
    const anomaly = narrationForEvent({ kind: 'anomalyDetected', toolUseId: 'tu-3', anomalyKind: 'stalledPermission' }, state);
    const flag = narrationForEvent({ kind: 'postToolFlag', anomalyKind: 'zeroEditBurn' }, state);
    const perm = narrationForEvent({ kind: 'permissionPending' }, state);
    for (const m of [anomaly, flag, perm]) {
      expect(m).not.toBeNull();
      expect(m!.role).toBe('STEWARD');
      expect(m!.channelId).toBe(AETHER_CHANNEL_ID);
    }
  });

  it('returns null for FORGE at severity 1 (silent heartbeat -- no sev-1 sample)', () => {
    const state = stateWith({});
    const message = narrationForEvent(
      { kind: 'dispatchCompleted', toolUseId: 'tu-4', subagentType: 'general-purpose', severity: 1 },
      state
    );
    expect(message).toBeNull();
  });
});

describe('narrationForEvent: verbosity dial, including the severity-3 floor', () => {
  it('suppresses a sub-floor line when verbosity is silent', () => {
    const state = stateWith({ cfg: { ...initialState.cfg, narrationVerbosity: 'silent' } });
    const message = narrationForEvent(
      { kind: 'dispatchCompleted', toolUseId: 'tu-5', subagentType: 'general-purpose', severity: 2 },
      state
    );
    expect(message).toBeNull();
  });

  it('renders a severity-3+ line even when verbosity is silent (the floor)', () => {
    const state = stateWith({ cfg: { ...initialState.cfg, narrationVerbosity: 'silent' } });
    const message = narrationForEvent({ kind: 'permissionPending' }, state); // severity 3
    expect(message).not.toBeNull();
    expect(message!.severity).toBe(3);
  });

  it("renders ASSAY's sev-4 no_signal line even when verbosity is silent", () => {
    const state = stateWith({ cfg: { ...initialState.cfg, narrationVerbosity: 'silent' } });
    const message = narrationForEvent(
      { kind: 'dispatchCompleted', toolUseId: 'tu-6', subagentType: 'pr-test-analyzer', severity: 4, exitState: 'fatal' },
      state
    );
    expect(message).not.toBeNull();
    expect(message!.text).toContain('Treat everything unverified.');
  });

  it('renders a full-verbosity sub-floor line normally', () => {
    const state = stateWith({ cfg: { ...initialState.cfg, narrationVerbosity: 'full' } });
    const message = narrationForEvent(
      { kind: 'dispatchCompleted', toolUseId: 'tu-7', subagentType: 'general-purpose', severity: 2 },
      state
    );
    expect(message).not.toBeNull();
  });
});

describe('narrationForEvent: frozen phrase reaches the rendered line end-to-end', () => {
  it("CINDER's critic_tell frozen phrase renders for a completed review dispatch at severity >= 3", () => {
    const state = stateWith({});
    const message = narrationForEvent(
      { kind: 'dispatchCompleted', toolUseId: 'tu-8', subagentType: 'code-reviewer', severity: 4 },
      state
    );
    expect(message).not.toBeNull();
    expect(message!.text.startsWith("Oh. That's actually interesting.")).toBe(true);
  });

  it("ASSAY's no_signal frozen phrase renders for a fatal completed dispatch", () => {
    const state = stateWith({});
    const message = narrationForEvent(
      { kind: 'dispatchCompleted', toolUseId: 'tu-9', subagentType: 'post-deployment-validator', severity: 4, exitState: 'fatal' },
      state
    );
    expect(message).not.toBeNull();
    expect(message!.text.startsWith('Treat everything unverified.')).toBe(true);
  });

  it("STEWARD's all_clear frozen phrase renders on a stewardStateCheck when the fleet is actually clear", () => {
    const state = stateWith({ realAgents: [], anomalies: [], pendingPermissionRequest: null });
    const message = narrationForEvent({ kind: 'stewardStateCheck' }, state);
    expect(message).not.toBeNull();
    expect(message!.text.startsWith('Nothing requires you.')).toBe(true);
  });

  it('stewardStateCheck produces nothing when the fleet is not clear', () => {
    const state = stateWith({ realAgents: [], anomalies: [{ kind: 'reReadLoop', toolUseId: 'tu-x', detail: 'x' }], pendingPermissionRequest: null });
    const message = narrationForEvent({ kind: 'stewardStateCheck' }, state);
    expect(message).toBeNull();
  });
});

describe('rankForInterruption: interruption-budget ranking', () => {
  it('lets the first line on a fresh channel interrupt and spends the budget', () => {
    const state = stateWith({});
    const message = narrationForEvent(
      { kind: 'dispatchCompleted', toolUseId: 'tu-10', subagentType: 'general-purpose', severity: 2 },
      state
    );
    const ranked = rankForInterruption(message!, {}, 1000);
    expect(ranked.interrupts).toBe(true);
    expect(ranked.budgets[message!.channelId].lastVolunteeredAtMs).toBe(1000);
  });

  it('denies a second sub-floor line on the same channel inside the window', () => {
    const state = stateWith({});
    const message = narrationForEvent(
      { kind: 'dispatchCompleted', toolUseId: 'tu-11', subagentType: 'general-purpose', severity: 2 },
      state
    );
    const first = rankForInterruption(message!, {}, 1000);
    const second = rankForInterruption(message!, first.budgets, 1000 + INTERRUPTION_WINDOW_MS - 1);
    expect(second.interrupts).toBe(false);
  });

  it('allows a line again once the window has elapsed', () => {
    const state = stateWith({});
    const message = narrationForEvent(
      { kind: 'dispatchCompleted', toolUseId: 'tu-12', subagentType: 'general-purpose', severity: 2 },
      state
    );
    const first = rankForInterruption(message!, {}, 1000);
    const second = rankForInterruption(message!, first.budgets, 1000 + INTERRUPTION_WINDOW_MS);
    expect(second.interrupts).toBe(true);
  });

  it('always interrupts at severity >= 3, bypassing the budget window (mirrors the verbosity floor)', () => {
    const state = stateWith({});
    const first = narrationForEvent({ kind: 'permissionPending' }, state)!; // severity 3
    const budgetsAfterFirst = rankForInterruption(first, {}, 1000).budgets;
    const second = narrationForEvent({ kind: 'postToolFlag', anomalyKind: 'stalledPermission' }, state)!; // severity 4, different channel-agnostic case: same AETHER channel
    const ranked = rankForInterruption(second, budgetsAfterFirst, 1001);
    expect(ranked.interrupts).toBe(true);
  });
});
