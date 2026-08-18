import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPersisted, savePersisted, PERSISTENCE_EXCLUSIONS } from './persistence';
import { initialState } from './initialState';
import type { AetherState } from './types';

// Why this file has a coverage test and a corruption-guard round-trip test, not just
// spot-check tests per field: persistence.ts's whitelist is hand-maintained (a literal
// object of `key: state.key` assignments), and this exact class of miss has recurred
// three separate times in this project's history --
//   - `state.selected` (the selected-agent field) was missing from the whitelist
//   - `projects`/`providers`/`routeDefault` (the Uplinks/Dashboard fields) were missing
//     (providers/routeDefault were later removed entirely -- see uplinks-real-status)
//   - `memSeq` was missing while `memories` was present, so a reload reset the id
//     counter but not the memories array, and the next memory created collided on id
//     (duplicate React keys, two memories toggling pinned together, wrong memory
//     selected on click) -- fixed post-ship in 3db6f90
// Every one of these was only caught by manual QA or a later bug report. The tests below
// convert this into a compile-time-adjacent guarantee: a new AetherState field cannot be
// added without a deliberate decision (persist it, or add it to PERSISTENCE_EXCLUSIONS
// with a reason) surfacing as a failing test naming the exact offending key.

beforeEach(() => {
  localStorage.clear();
});

describe('persistence', () => {
  it('round-trips a whitelisted slice of state through localStorage', () => {
    savePersisted({ ...initialState, activeTab: 'Grid', unread: 5 });
    const loaded = loadPersisted();
    expect(loaded?.activeTab).toBe('Grid');
    expect(loaded?.unread).toBe(5);
  });

  it('does not persist terminalAlive (recomputed live from the current session\'s pty state)', () => {
    savePersisted({ ...initialState, terminalAlive: false });
    const loaded = loadPersisted();
    expect(loaded?.terminalAlive).toBeUndefined();
  });

  it('persists the selected project across reloads', () => {
    savePersisted({ ...initialState, selectedProject: 'Mobile Beta' });
    const loaded = loadPersisted();
    expect(loaded?.selectedProject).toBe('Mobile Beta');
  });

  it('persists selectedMemory but not memories across reloads (memories are a live collector-sourced snapshot, not locally-owned state -- see Memory Layer 2 Phase D)', () => {
    savePersisted({ ...initialState, selectedMemory: '2' });
    const loaded = loadPersisted();
    expect(loaded?.selectedMemory).toBe('2');
    expect(loaded?.memories).toBeUndefined();
  });

  it('persists memoryScopeFilter and memoryShowTombstones across reloads', () => {
    savePersisted({ ...initialState, memoryScopeFilter: 'shared', memoryShowTombstones: true });
    const loaded = loadPersisted();
    expect(loaded?.memoryScopeFilter).toBe('shared');
    expect(loaded?.memoryShowTombstones).toBe(true);
  });

  it('persists operatorName across reloads', () => {
    savePersisted({ ...initialState, operatorName: 'Matt' });
    const loaded = loadPersisted();
    expect(loaded?.operatorName).toBe('Matt');
  });

  it('persists planUsageTier across reloads', () => {
    savePersisted({ ...initialState, planUsageTier: { tier: 'max', weekModel: { pct: 52 }, capturedAtMs: 1700000000000 } });
    const loaded = loadPersisted();
    expect(loaded?.planUsageTier).toEqual({ tier: 'max', weekModel: { pct: 52 }, capturedAtMs: 1700000000000 });
  });

  it('does not persist logs', () => {
    savePersisted({ ...initialState, logs: [{ t: '10:00:00', m: 'test', c: '#7fd8ef' }] });
    const loaded = loadPersisted();
    expect(loaded?.logs).toBeUndefined();
  });

  it('returns null when nothing is stored', () => {
    expect(loadPersisted()).toBeNull();
  });

  it('returns null on malformed JSON instead of throwing', () => {
    localStorage.setItem('aetheros-v1', '{not json');
    expect(loadPersisted()).toBeNull();
  });

  it('does not throw when localStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => savePersisted(initialState)).not.toThrow();
    vi.restoreAllMocks();
  });

  it('accounts for every AetherState key as either persisted or documented as excluded', () => {
    // Build a fully-populated AetherState from initialState (per the file header comment
    // above): every top-level field of AetherState is required, so initialState already
    // has a concrete value for each one -- there is nothing to fill in.
    savePersisted(initialState);
    const loaded = loadPersisted() ?? {};

    const missing = (Object.keys(initialState) as (keyof AetherState)[]).filter(
      (key) => !Object.prototype.hasOwnProperty.call(loaded, key) && !Object.prototype.hasOwnProperty.call(PERSISTENCE_EXCLUSIONS, key)
    );

    if (missing.length > 0) {
      throw new Error(
        `AetherState key(s) not accounted for: ${missing.join(', ')}. ` +
          `Either add them to the persisted slice in persistence.ts's savePersisted(), ` +
          `or add an entry to PERSISTENCE_EXCLUSIONS explaining why they must not be persisted.`
      );
    }
  });

  it('round-trips every persisted key with its value intact (memSeq-style corruption guard)', () => {
    // Distinctive, non-default values on every currently-persisted key, so a bug that
    // persists the wrong value (or drops a key silently) shows up as a real assertion
    // failure rather than an accidental pass against a default that happens to match.
    const distinctiveState: AetherState = {
      ...initialState,
      cfg: { ...initialState.cfg, opMode: 'AUTO', glow: 55 },
      activeTab: 'Grid',
      notifs: [{ t: '10:00', m: 'test notif', c: '#ffffff' }],
      unread: 7,
      cmdHist: ['status', 'budget'],
      operatorName: 'Ghost Operator',
      selectedProject: 'Ghost Project',
      selectedMemory: '999',
      memoryScopeFilter: 'general-purpose',
      memoryShowTombstones: true,
      recentCompletedDispatches: [
        {
          toolUseId: 'ghost-tool-use-1',
          subagentType: 'Ghost Subagent',
          description: 'Ghost dispatch description',
          startedAt: '2026-07-27T10:00:00.000Z',
          prompt: 'ghost prompt text',
          model: 'ghost-model-1',
        },
      ],
      dispatchChannels: [
        {
          toolUseId: 'ghost-tool-use-2',
          subagentType: 'Ghost Channel Subagent',
          description: 'Ghost channel description',
          prompt: 'ghost channel prompt text',
          model: 'ghost-model-2',
          startedAt: '2026-07-27T10:05:00.000Z',
          createdAt: '10:05',
        },
      ],
      dispatchUsage: { 'tool-1': { tokens: 500, toolUses: 3, durationMs: 1200 } },
    };

    savePersisted(distinctiveState);
    const loaded = loadPersisted();

    expect(loaded?.cfg).toEqual(distinctiveState.cfg);
    expect(loaded?.activeTab).toBe('Grid');
    expect(loaded?.notifs).toEqual(distinctiveState.notifs);
    expect(loaded?.unread).toBe(7);
    expect(loaded?.cmdHist).toEqual(['status', 'budget']);
    expect(loaded?.operatorName).toBe('Ghost Operator');
    expect(loaded?.selectedProject).toBe('Ghost Project');
    expect(loaded?.selectedMemory).toBe('999');
    expect(loaded?.memoryScopeFilter).toBe('general-purpose');
    expect(loaded?.memoryShowTombstones).toBe(true);
    expect(loaded?.recentCompletedDispatches).toEqual(distinctiveState.recentCompletedDispatches);
    expect(loaded?.dispatchChannels).toEqual(distinctiveState.dispatchChannels);
    expect(loaded?.dispatchUsage).toEqual(distinctiveState.dispatchUsage);

    // Field-for-field checks on the populated dispatch entries, not just array-level
    // toEqual -- catches a field silently dropped or mis-mapped during persistence for
    // a real RealAgentDispatch/DispatchChannelStub, the same "populated array, not just
    // an empty default" gap the memSeq check above closes for memories.
    expect(loaded?.recentCompletedDispatches?.[0]).toEqual({
      toolUseId: 'ghost-tool-use-1',
      subagentType: 'Ghost Subagent',
      description: 'Ghost dispatch description',
      startedAt: '2026-07-27T10:00:00.000Z',
      prompt: 'ghost prompt text',
      model: 'ghost-model-1',
    });
    expect(loaded?.dispatchChannels?.[0]).toEqual({
      toolUseId: 'ghost-tool-use-2',
      subagentType: 'Ghost Channel Subagent',
      description: 'Ghost channel description',
      prompt: 'ghost channel prompt text',
      model: 'ghost-model-2',
      startedAt: '2026-07-27T10:05:00.000Z',
      createdAt: '10:05',
    });
  });
});
