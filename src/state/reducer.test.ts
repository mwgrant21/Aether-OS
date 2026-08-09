import { describe, expect, it } from 'vitest';
import { reducer } from './reducer';
import { initialState } from './initialState';
import type { Approval } from './types';
import type { RealAgentDispatch } from './liveAgentsMath';
import type { StatuslineSnapshot } from '../shared/statuslinePayload';

describe('reducer', () => {
  it('SET_ACTIVE_TAB switches the active tab', () => {
    const next = reducer(initialState, { type: 'SET_ACTIVE_TAB', tab: 'Agents' });
    expect(next.activeTab).toBe('Agents');
  });

  it('TOGGLE_NOTIFS opens the panel and clears unread', () => {
    const withUnread = { ...initialState, unread: 3, notifOpen: false };
    const next = reducer(withUnread, { type: 'TOGGLE_NOTIFS' });
    expect(next.notifOpen).toBe(true);
    expect(next.unread).toBe(0);
  });

  it('TOGGLE_APPROVALS flips apprOpen without touching unread', () => {
    const next = reducer(initialState, { type: 'TOGGLE_APPROVALS' });
    expect(next.apprOpen).toBe(true);
  });

  it('SELECT_AGENT sets selected', () => {
    const next = reducer(initialState, { type: 'SELECT_AGENT', name: 'Code Builder' });
    expect(next.selected).toBe('Code Builder');
  });

  it('SELECT_PROJECT sets selectedProject', () => {
    const next = reducer(initialState, { type: 'SELECT_PROJECT', key: 'mobile-beta' });
    expect(next.selectedProject).toBe('mobile-beta');
  });

  it('SELECT_MEMORY sets selectedMemory to the stringified id', () => {
    const next = reducer(initialState, { type: 'SELECT_MEMORY', id: 2 });
    expect(next.selectedMemory).toBe('2');
  });

  it('RESOLVE_APPROVAL removes the request and bumps rate only for HIGH risk approvals', () => {
    const next = reducer(initialState, { type: 'RESOLVE_APPROVAL', id: 1, approve: true });
    expect(next.approvals.map((a) => a.id)).toEqual([2]);
    expect(next.rate).toBe(initialState.rate + 9000);
    expect(next.notifs[0].m).toContain('Approved');

    const denyMed = reducer(initialState, { type: 'RESOLVE_APPROVAL', id: 2, approve: false });
    expect(denyMed.rate).toBe(initialState.rate);
    expect(denyMed.notifs[0].m).toContain('Denied');
  });

  it('RESOLVE_APPROVAL on an unknown id is a no-op', () => {
    const next = reducer(initialState, { type: 'RESOLVE_APPROVAL', id: 999, approve: true });
    expect(next).toBe(initialState);
  });

  it('RESOLVE_APPROVAL leaves memories unchanged regardless of risk or outcome (memory construction was retired -- see Memory Layer 2 Phase D)', () => {
    const approved = reducer(initialState, { type: 'RESOLVE_APPROVAL', id: 1, approve: true });
    expect(approved.memories).toEqual(initialState.memories);

    const denied = reducer(initialState, { type: 'RESOLVE_APPROVAL', id: 1, approve: false });
    expect(denied.memories).toEqual(initialState.memories);

    const medResolved = reducer(initialState, { type: 'RESOLVE_APPROVAL', id: 2, approve: true });
    expect(medResolved.memories).toEqual(initialState.memories);
  });

  it('TOGGLE_AGENT_PAUSE flips paused on the named agent only', () => {
    const next = reducer(initialState, { type: 'TOGGLE_AGENT_PAUSE', name: 'Code Builder' });
    expect(next.agents.find((a) => a.name === 'Code Builder')?.paused).toBe(true);
    expect(next.agents.find((a) => a.name === 'UI Designer')?.paused).toBeUndefined();
    const restored = reducer(next, { type: 'TOGGLE_AGENT_PAUSE', name: 'Code Builder' });
    expect(restored.agents.find((a) => a.name === 'Code Builder')?.paused).toBe(false);
  });

  it('TOGGLE_AGENT_PAUSE on an unknown name is a no-op', () => {
    const next = reducer(initialState, { type: 'TOGGLE_AGENT_PAUSE', name: 'Nobody' });
    expect(next.agents).toEqual(initialState.agents);
  });

  it('REACTIVATE_AGENT moves an idle agent into the active roster, selects it, and raises the burn rate (mirrors spawn)', () => {
    const next = reducer(initialState, { type: 'REACTIVATE_AGENT', name: 'Web Scraper' });
    expect(next.idleList.map((i) => i.name)).toEqual(['Doc Helper']);
    expect(next.agents.map((a) => a.name)).toContain('Web Scraper');
    expect(next.selected).toBe('Web Scraper');
    expect(next.rate).toBe(Math.min(168000, initialState.rate + 18000));
  });

  it('REACTIVATE_AGENT on a name not in idleList is a no-op', () => {
    const next = reducer(initialState, { type: 'REACTIVATE_AGENT', name: 'Nobody' });
    expect(next).toBe(initialState);
  });

  it('UPDATE_CFG merges a partial patch into cfg, leaving other cfg fields untouched', () => {
    const next = reducer(initialState, { type: 'UPDATE_CFG', patch: { glow: 100, sound: true } });
    expect(next.cfg.glow).toBe(100);
    expect(next.cfg.sound).toBe(true);
    expect(next.cfg.theme).toBe(initialState.cfg.theme);
    expect(next.cfg.opMode).toBe(initialState.cfg.opMode);
    expect(next.cfg.alarm).toBe(initialState.cfg.alarm);
  });

  // Nothing spawns a pty at launch -- PtyTerminal.tsx only does so when the
  // Terminal tab actually mounts -- so the honest default is "no terminal".
  // Defaulting true previously made Uplinks/Dashboard report ONLINE forever on
  // any launch that restored a different tab, or outside Electron entirely.
  it('terminalAlive defaults false in initialState', () => {
    expect(initialState.terminalAlive).toBe(false);
  });

  it('SET_TERMINAL_ALIVE flips terminalAlive to true (the pty:alive push)', () => {
    const next = reducer(initialState, { type: 'SET_TERMINAL_ALIVE', alive: true });
    expect(next.terminalAlive).toBe(true);
  });

  it('SET_TERMINAL_ALIVE flips terminalAlive to false (the pty:exit push)', () => {
    const alive = reducer(initialState, { type: 'SET_TERMINAL_ALIVE', alive: true });
    const next = reducer(alive, { type: 'SET_TERMINAL_ALIVE', alive: false });
    expect(next.terminalAlive).toBe(false);
  });

  it('SET_TERMINAL_ALIVE can flip terminalAlive back to true, leaving other state untouched', () => {
    const dead = reducer(initialState, { type: 'SET_TERMINAL_ALIVE', alive: false });
    const next = reducer(dead, { type: 'SET_TERMINAL_ALIVE', alive: true });
    expect(next.terminalAlive).toBe(true);
    expect(next.operatorName).toBe(initialState.operatorName);
  });

  it('SET_CODEX_TERMINAL_ALIVE flips codexTerminalAlive to true (the codexPty:alive push)', () => {
    const next = reducer(initialState, { type: 'SET_CODEX_TERMINAL_ALIVE', alive: true });
    expect(next.codexTerminalAlive).toBe(true);
  });

  it('SET_CODEX_TERMINAL_ALIVE flips codexTerminalAlive to false (the codexPty:exit push)', () => {
    const alive = reducer(initialState, { type: 'SET_CODEX_TERMINAL_ALIVE', alive: true });
    const next = reducer(alive, { type: 'SET_CODEX_TERMINAL_ALIVE', alive: false });
    expect(next.codexTerminalAlive).toBe(false);
  });

  it("SET_CODEX_TERMINAL_ALIVE leaves terminalAlive (the Claude pty's own flag) untouched", () => {
    const withClaudeAlive = reducer(initialState, { type: 'SET_TERMINAL_ALIVE', alive: true });
    const next = reducer(withClaudeAlive, { type: 'SET_CODEX_TERMINAL_ALIVE', alive: true });
    expect(next.terminalAlive).toBe(true);
    expect(next.codexTerminalAlive).toBe(true);
  });

  it('SET_OPERATOR_NAME sets operatorName verbatim, leaving other state untouched', () => {
    const next = reducer(initialState, { type: 'SET_OPERATOR_NAME', name: 'Matt' });
    expect(next.operatorName).toBe('Matt');
    expect(next.terminalAlive).toBe(initialState.terminalAlive);
  });

  it('SET_OPERATOR_NAME accepts an empty string without trimming at the reducer layer', () => {
    const next = reducer(initialState, { type: 'SET_OPERATOR_NAME', name: '' });
    expect(next.operatorName).toBe('');
  });

  describe('SET_REAL_AGENTS leaves memories untouched (memory construction was retired -- see Memory Layer 2 Phase D)', () => {
    const completedDispatch: RealAgentDispatch = {
      toolUseId: 'tu_1',
      subagentType: 'general-purpose',
      description: 'Explore the repo',
      startedAt: '2026-07-20T10:00:00.000Z',
      prompt: '',
      model: null,
    };

    it('does not touch memories when a dispatch completes', () => {
      const withOpenDispatch = { ...initialState, realAgents: [completedDispatch] };
      const next = reducer(withOpenDispatch, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.memories).toEqual(withOpenDispatch.memories);
    });

    it('does not touch memories when multiple dispatches complete in one action', () => {
      const secondDispatch: RealAgentDispatch = { ...completedDispatch, toolUseId: 'tu_2', subagentType: 'Explore' };
      const withTwoOpen = { ...initialState, realAgents: [completedDispatch, secondDispatch] };
      const next = reducer(withTwoOpen, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.memories).toEqual(withTwoOpen.memories);
    });

    it('does not touch memories when nothing completed', () => {
      const withOpenDispatch = { ...initialState, realAgents: [completedDispatch] };
      const next = reducer(withOpenDispatch, { type: 'SET_REAL_AGENTS', agents: [completedDispatch] });
      expect(next.memories).toEqual(withOpenDispatch.memories);
    });

    it('still updates realAgents to the new list', () => {
      const withOpenDispatch = { ...initialState, realAgents: [completedDispatch] };
      const next = reducer(withOpenDispatch, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.realAgents).toEqual([]);
    });
  });

  describe('SET_REAL_AGENTS pool and auto-create', () => {
    const completedDispatch: RealAgentDispatch = {
      toolUseId: 'tu_1',
      subagentType: 'general-purpose',
      description: 'Explore the repo',
      startedAt: '2026-07-20T10:00:00.000Z',
      prompt: 'Explore the repo and report findings.',
      model: null,
    };

    it('pushes a completed dispatch into recentCompletedDispatches, most-recent-first', () => {
      const withOpenDispatch = { ...initialState, realAgents: [completedDispatch] };
      const next = reducer(withOpenDispatch, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.recentCompletedDispatches[0]).toEqual(completedDispatch);
    });

    it('caps recentCompletedDispatches at 20 entries', () => {
      const existing: RealAgentDispatch[] = Array.from({ length: 20 }, (_, i) => ({ ...completedDispatch, toolUseId: `old_${i}` }));
      const withFullPoolAndOneOpen = { ...initialState, recentCompletedDispatches: existing, realAgents: [completedDispatch] };
      const next = reducer(withFullPoolAndOneOpen, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.recentCompletedDispatches).toHaveLength(20);
      expect(next.recentCompletedDispatches[0]).toEqual(completedDispatch);
      expect(next.recentCompletedDispatches.map((d) => d.toolUseId)).not.toContain('old_19');
    });

    it('does not create a dispatch channel when autoCreateDispatchChannels is false (the default)', () => {
      const withOpenDispatch = { ...initialState, realAgents: [completedDispatch] };
      const next = reducer(withOpenDispatch, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.dispatchChannels).toEqual([]);
    });

    it('auto-creates a dispatch channel when autoCreateDispatchChannels is true', () => {
      const withAutoCreate = { ...initialState, cfg: { ...initialState.cfg, autoCreateDispatchChannels: true }, realAgents: [completedDispatch] };
      const next = reducer(withAutoCreate, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.dispatchChannels).toHaveLength(1);
      expect(next.dispatchChannels[0]).toMatchObject({
        toolUseId: 'tu_1',
        subagentType: 'general-purpose',
        description: 'Explore the repo',
        prompt: 'Explore the repo and report findings.',
        model: null,
      });
    });

    it('emits no log line for a plain completion when auto-create is off', () => {
      const withOpen = { ...initialState, realAgents: [completedDispatch] };
      expect(reducer(withOpen, { type: 'SET_REAL_AGENTS', agents: [] }).logs).toEqual(withOpen.logs);
    });

    it('does not create a duplicate dispatch channel when auto-creating for a toolUseId that already has one', () => {
      const existingStub = {
        toolUseId: 'tu_1',
        subagentType: 'general-purpose',
        description: 'Explore the repo',
        prompt: '',
        model: null,
        startedAt: '2026-07-20T10:00:00.000Z',
        createdAt: '10:00:00',
      };
      const withAutoCreateAndExisting = {
        ...initialState,
        cfg: { ...initialState.cfg, autoCreateDispatchChannels: true },
        realAgents: [completedDispatch],
        dispatchChannels: [existingStub],
      };
      const next = reducer(withAutoCreateAndExisting, { type: 'SET_REAL_AGENTS', agents: [] });
      expect(next.dispatchChannels).toHaveLength(1);
      expect(next.dispatchChannels[0]).toEqual(existingStub);
    });

    it('appends a log line for a newly-started dispatch', () => {
      const next = reducer(initialState, { type: 'SET_REAL_AGENTS', agents: [completedDispatch] });
      const last = next.logs.at(-1);
      expect(last?.m).toBe('general-purpose: Explore the repo');
      expect(last?.c).toBe('#7fd8ef');
    });

    it('appends no log line when nothing started or completed', () => {
      const withOpenDispatch = { ...initialState, realAgents: [completedDispatch] };
      const next = reducer(withOpenDispatch, { type: 'SET_REAL_AGENTS', agents: [completedDispatch] });
      expect(next.logs).toEqual(withOpenDispatch.logs);
    });

    it('appends a log line when auto-creating a dispatch channel', () => {
      const withAutoCreate = { ...initialState, cfg: { ...initialState.cfg, autoCreateDispatchChannels: true }, realAgents: [completedDispatch] };
      const next = reducer(withAutoCreate, { type: 'SET_REAL_AGENTS', agents: [] });
      const last = next.logs.at(-1);
      expect(last?.m).toBe('general-purpose: dispatch channel opened');
      expect(last?.c).toBe('#7fd8ef');
    });
  });

  describe('SET_REAL_USAGE', () => {
    it('stays at the idle momentum baseline on the first snapshot (insufficient history)', () => {
      const snapshot = { ...initialState.realUsage, burnRatePerMin: 6150 };
      const next = reducer(initialState, { type: 'SET_REAL_USAGE', snapshot });
      expect(next.momentum).toBe(92000);
      expect(next.rateHistory).toHaveLength(1);
      expect(next.realUsage).toBe(snapshot);
    });

    it('stays at the idle momentum baseline with only two accumulated snapshots', () => {
      const first = reducer(initialState, { type: 'SET_REAL_USAGE', snapshot: { ...initialState.realUsage, burnRatePerMin: 1000 } });
      const second = reducer(first, { type: 'SET_REAL_USAGE', snapshot: { ...initialState.realUsage, burnRatePerMin: 5000 } });
      expect(second.momentum).toBe(92000);
      expect(second.rateHistory).toHaveLength(2);
    });

    it('momentum rises toward the visual ceiling once three rising snapshots accumulate', () => {
      let s = initialState;
      for (const burnRatePerMin of [1000, 4000, 7000]) {
        s = reducer(s, { type: 'SET_REAL_USAGE', snapshot: { ...initialState.realUsage, burnRatePerMin } }) as typeof initialState;
      }
      expect(s.momentum).toBe(168000);
    });

    it('keeps only the most recent 3 samples in rateHistory', () => {
      let s = initialState;
      for (const burnRatePerMin of [1000, 2000, 3000, 4000]) {
        s = reducer(s, { type: 'SET_REAL_USAGE', snapshot: { ...initialState.realUsage, burnRatePerMin } }) as typeof initialState;
      }
      expect(s.rateHistory).toHaveLength(3);
      expect(s.rateHistory.map((r) => r.burnRatePerMin)).toEqual([2000, 3000, 4000]);
    });

    it('rate reflects computeRateFromUsage directly from a single snapshot, no accumulation needed', () => {
      const snapshot = { ...initialState.realUsage, burnRatePerMin: 6150 };
      const next = reducer(initialState, { type: 'SET_REAL_USAGE', snapshot });
      expect(next.rate).toBe(94000);
    });
  });

  describe('CREATE_DISPATCH_CHANNEL', () => {
    const pooled: RealAgentDispatch = {
      toolUseId: 'tu_2',
      subagentType: 'Explore',
      description: 'Map the docs',
      startedAt: '2026-07-20T10:05:00.000Z',
      prompt: 'Map the docs directory.',
      model: 'claude-haiku-4-5',
    };

    it('creates a channel stub from a pool entry, copying all fields', () => {
      const withPool = { ...initialState, recentCompletedDispatches: [pooled] };
      const next = reducer(withPool, { type: 'CREATE_DISPATCH_CHANNEL', toolUseId: 'tu_2' });
      expect(next.dispatchChannels).toHaveLength(1);
      expect(next.dispatchChannels[0]).toMatchObject({
        toolUseId: 'tu_2',
        subagentType: 'Explore',
        description: 'Map the docs',
        prompt: 'Map the docs directory.',
        model: 'claude-haiku-4-5',
      });
    });

    it('is a no-op for an unknown toolUseId', () => {
      const next = reducer(initialState, { type: 'CREATE_DISPATCH_CHANNEL', toolUseId: 'nonexistent' });
      expect(next).toBe(initialState);
    });

    it('is a no-op if a channel for that toolUseId already exists', () => {
      const existingStub = {
        toolUseId: 'tu_2',
        subagentType: 'Explore',
        description: 'Map the docs',
        prompt: '',
        model: null,
        startedAt: '2026-07-20T10:05:00.000Z',
        createdAt: '10:05:00',
      };
      const withBoth = { ...initialState, recentCompletedDispatches: [pooled], dispatchChannels: [existingStub] };
      const next = reducer(withBoth, { type: 'CREATE_DISPATCH_CHANNEL', toolUseId: 'tu_2' });
      expect(next.dispatchChannels).toHaveLength(1);
    });

    it('appends a log line when a channel is created', () => {
      const withPool = { ...initialState, recentCompletedDispatches: [pooled] };
      const next = reducer(withPool, { type: 'CREATE_DISPATCH_CHANNEL', toolUseId: 'tu_2' });
      const last = next.logs.at(-1);
      expect(last?.m).toBe('Explore: dispatch channel opened');
      expect(last?.c).toBe('#7fd8ef');
    });
  });

  describe('REMOVE_DISPATCH_CHANNEL', () => {
    const stub = {
      toolUseId: 'tu_3',
      subagentType: 'general-purpose',
      description: 'desc',
      prompt: '',
      model: null,
      startedAt: '2026-07-20T10:00:00.000Z',
      createdAt: '10:00:00',
    };

    it('removes the matching channel stub', () => {
      const withStub = { ...initialState, dispatchChannels: [stub] };
      const next = reducer(withStub, { type: 'REMOVE_DISPATCH_CHANNEL', toolUseId: 'tu_3' });
      expect(next.dispatchChannels).toEqual([]);
    });

    it('is a no-op for an unknown toolUseId', () => {
      const withStub = { ...initialState, dispatchChannels: [stub] };
      const next = reducer(withStub, { type: 'REMOVE_DISPATCH_CHANNEL', toolUseId: 'nonexistent' });
      expect(next.dispatchChannels).toEqual([stub]);
    });
  });

  describe('SET_DISPATCH_HEADLINE', () => {
    it('sets a headline for a toolUseId', () => {
      const next = reducer(initialState, { type: 'SET_DISPATCH_HEADLINE', toolUseId: 'tu_1', headline: 'waiting on approval' });
      expect(next.dispatchHeadlines['tu_1']).toBe('waiting on approval');
    });

    it('preserves existing headlines when adding a new one', () => {
      const withOne = { ...initialState, dispatchHeadlines: { tu_0: 'first' } };
      const next = reducer(withOne, { type: 'SET_DISPATCH_HEADLINE', toolUseId: 'tu_1', headline: 'second' });
      expect(next.dispatchHeadlines).toEqual({ tu_0: 'first', tu_1: 'second' });
    });

    it('caps dispatchHeadlines at 100 entries, evicting the oldest first', () => {
      const existing = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`old_${i}`, `headline_${i}`]));
      const withFull = { ...initialState, dispatchHeadlines: existing };
      const next = reducer(withFull, { type: 'SET_DISPATCH_HEADLINE', toolUseId: 'new_1', headline: 'newest' });
      expect(Object.keys(next.dispatchHeadlines)).toHaveLength(100);
      expect(next.dispatchHeadlines['old_0']).toBeUndefined();
      expect(next.dispatchHeadlines['old_1']).toBeDefined();
      expect(next.dispatchHeadlines['new_1']).toBe('newest');
    });
  });

  describe('SET_CROSS_ENGINE_CFG', () => {
    it('replaces crossEngineCfg wholesale', () => {
      const cfg = { enabled: true, provider: 'codex-chatgpt' as const };
      const next = reducer(initialState, { type: 'SET_CROSS_ENGINE_CFG', cfg });
      expect(next.crossEngineCfg).toEqual(cfg);
    });
  });

  it('SET_CODEX_TERMINAL_CFG replaces codexTerminalCfg wholesale', () => {
    const cfg = { enabled: true };
    const next = reducer(initialState, { type: 'SET_CODEX_TERMINAL_CFG', cfg });
    expect(next.codexTerminalCfg).toEqual(cfg);
  });

  describe('RECORD_DISPATCH_USAGE', () => {
    it('merges one completion into dispatchUsage, keyed by toolUseId', () => {
      const next = reducer(initialState, {
        type: 'RECORD_DISPATCH_USAGE',
        completed: [
          {
            toolUseId: 'tu_1',
            subagentType: 'general-purpose',
            description: 'desc',
            startedAt: '2026-07-20T10:00:00.000Z',
            prompt: '',
            model: null,
            tokens: 1234,
            toolUses: 5,
            durationMs: 6789,
          },
        ],
      });
      expect(next.dispatchUsage['tu_1']).toEqual({ tokens: 1234, toolUses: 5, durationMs: 6789 });
    });

    it('merges multiple completions in one action, preserving existing entries', () => {
      const withOne = { ...initialState, dispatchUsage: { tu_0: { tokens: 1, toolUses: 1, durationMs: 1 } } };
      const next = reducer(withOne, {
        type: 'RECORD_DISPATCH_USAGE',
        completed: [
          { toolUseId: 'tu_1', subagentType: 'a', description: '', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null, tokens: 100, toolUses: 2, durationMs: 300 },
          { toolUseId: 'tu_2', subagentType: 'b', description: '', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null, tokens: 400, toolUses: 5, durationMs: 600 },
        ],
      });
      expect(Object.keys(next.dispatchUsage)).toEqual(['tu_0', 'tu_1', 'tu_2']);
      expect(next.dispatchUsage['tu_1']).toEqual({ tokens: 100, toolUses: 2, durationMs: 300 });
      expect(next.dispatchUsage['tu_2']).toEqual({ tokens: 400, toolUses: 5, durationMs: 600 });
    });

    it('caps dispatchUsage at 100 entries, evicting the oldest first', () => {
      const existing = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`old_${i}`, { tokens: i, toolUses: 1, durationMs: 1 }]));
      const withFull = { ...initialState, dispatchUsage: existing };
      const next = reducer(withFull, {
        type: 'RECORD_DISPATCH_USAGE',
        completed: [{ toolUseId: 'new_1', subagentType: 'a', description: '', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null, tokens: 1, toolUses: 1, durationMs: 1 }],
      });
      expect(Object.keys(next.dispatchUsage)).toHaveLength(100);
      expect(next.dispatchUsage['old_0']).toBeUndefined();
      expect(next.dispatchUsage['old_1']).toBeDefined();
      expect(next.dispatchUsage['new_1']).toBeDefined();
    });

    it('appends a log line with real usage figures', () => {
      const next = reducer(initialState, {
        type: 'RECORD_DISPATCH_USAGE',
        completed: [
          {
            toolUseId: 'tu_1',
            subagentType: 'general-purpose',
            description: 'desc',
            startedAt: '2026-07-20T10:00:00.000Z',
            prompt: '',
            model: null,
            tokens: 12500,
            toolUses: 5,
            durationMs: 8000,
          },
        ],
      });
      const last = next.logs.at(-1);
      expect(last?.m).toBe('general-purpose: 12.5K tok · 5 tool calls · 8s');
      expect(last?.c).toBe('#3be0a0');
    });

    it('uses singular "tool call" for exactly one tool use', () => {
      const next = reducer(initialState, {
        type: 'RECORD_DISPATCH_USAGE',
        completed: [
          { toolUseId: 'tu_1', subagentType: 'a', description: '', startedAt: '2026-07-20T10:00:00.000Z', prompt: '', model: null, tokens: 1, toolUses: 1, durationMs: 1000 },
        ],
      });
      expect(next.logs.at(-1)?.m).toBe('a: 1 tok · 1 tool call · 1s');
    });
  });
});

function chatApproval(overrides: Partial<Approval>): Approval {
  return { id: 100, agent: 'AETHER', i: 'AE', hue: '#7fd8ef', action: 'Spawn Nightwatch', detail: 'requested via chat', risk: 'MED', ...overrides };
}

describe('reducer — Phase 2b chat action pipeline', () => {
  it('ADD_APPROVAL appends using apprSeq and increments it, leaving existing approvals untouched', () => {
    const next = reducer(initialState, { type: 'ADD_APPROVAL', approval: chatApproval({ id: undefined as any }) as any });
    expect(next.approvals).toHaveLength(3);
    expect(next.approvals[2].id).toBe(initialState.apprSeq);
    expect(next.apprSeq).toBe(initialState.apprSeq + 1);
  });

  it('RESOLVE_APPROVAL on an approved spawn approval creates the agent and bumps rate by 18000 (identical to Terminal spawn), skipping the generic HIGH-risk shorthand', () => {
    const withApproval = { ...initialState, approvals: [...initialState.approvals, chatApproval({ id: 50, verb: 'spawn', targetAgentName: 'Nightwatch', risk: 'MED', channelId: 'AETHER' })] };
    const next = reducer(withApproval, { type: 'RESOLVE_APPROVAL', id: 50, approve: true });
    expect(next.agents.map((a) => a.name)).toContain('Nightwatch');
    expect(next.rate).toBe(initialState.rate + 18000);
  });

  it('RESOLVE_APPROVAL on an approved kill approval moves the target agent to idleList and does not touch rate', () => {
    const withApproval = { ...initialState, approvals: [...initialState.approvals, chatApproval({ id: 51, verb: 'kill', targetAgentName: 'Test Runner', risk: 'HIGH', agent: 'AETHER', channelId: 'AETHER' })] };
    const next = reducer(withApproval, { type: 'RESOLVE_APPROVAL', id: 51, approve: true });
    expect(next.agents.map((a) => a.name)).not.toContain('Test Runner');
    expect(next.idleList.map((i) => i.name)).toContain('Test Runner');
    expect(next.rate).toBe(initialState.rate);
  });

  it('RESOLVE_APPROVAL on an approved throttle approval caps the target agent share at 0.08', () => {
    const withApproval = { ...initialState, approvals: [...initialState.approvals, chatApproval({ id: 52, verb: 'throttle', targetAgentName: 'Code Builder', risk: 'LOW', channelId: 'Code Builder' })] };
    const next = reducer(withApproval, { type: 'RESOLVE_APPROVAL', id: 52, approve: true });
    expect(next.agents.find((a) => a.name === 'Code Builder')?.share).toBe(0.08);
  });

  it('RESOLVE_APPROVAL gracefully no-ops the mutation (but still resolves) when the target agent is already gone', () => {
    const withApproval = { ...initialState, approvals: [...initialState.approvals, chatApproval({ id: 53, verb: 'kill', targetAgentName: 'Nobody', risk: 'HIGH', channelId: 'AETHER' })] };
    const next = reducer(withApproval, { type: 'RESOLVE_APPROVAL', id: 53, approve: true });
    expect(next.approvals.map((a) => a.id)).not.toContain(53);
  });

  it('RESOLVE_APPROVAL on a denied chat approval applies no mutation', () => {
    const withApproval = { ...initialState, approvals: [...initialState.approvals, chatApproval({ id: 54, verb: 'spawn', targetAgentName: 'Nightwatch', risk: 'MED', channelId: 'AETHER' })] };
    const next = reducer(withApproval, { type: 'RESOLVE_APPROVAL', id: 54, approve: false });
    expect(next.agents.map((a) => a.name)).not.toContain('Nightwatch');
  });

  it('RESOLVE_APPROVAL on the pre-existing seed approvals is byte-for-byte unchanged (no verb)', () => {
    const next = reducer(initialState, { type: 'RESOLVE_APPROVAL', id: 1, approve: true });
    expect(next.rate).toBe(initialState.rate + 9000);
  });
});

describe('reducer — ADD_APPROVAL autoResolve atomicity (closes the chat AUTO-mode race)', () => {
  it('autoResolve: true immediately executes the mutation, never adding the approval to state.approvals', () => {
    const payload = chatApproval({ id: undefined as any, verb: 'throttle', targetAgentName: 'Code Builder', risk: 'LOW', channelId: 'Code Builder' }) as any;
    const next = reducer(initialState, { type: 'ADD_APPROVAL', approval: payload, autoResolve: true });

    // The mutation happened immediately.
    expect(next.agents.find((a) => a.name === 'Code Builder')?.share).toBe(0.08);
    // apprSeq still advances (the id was assigned and consumed)...
    expect(next.apprSeq).toBe(initialState.apprSeq + 1);
    // ...but the approval itself never appears in the queue, not even transiently.
    expect(next.approvals).toEqual(initialState.approvals);
  });

  it('autoResolve: false (or omitted) behaves exactly as plain ADD_APPROVAL: appended to the queue, no immediate mutation', () => {
    const payload = chatApproval({ id: undefined as any, verb: 'spawn', targetAgentName: 'Nightwatch', risk: 'MED', channelId: 'AETHER' }) as any;

    const withFalse = reducer(initialState, { type: 'ADD_APPROVAL', approval: payload, autoResolve: false });
    const withOmitted = reducer(initialState, { type: 'ADD_APPROVAL', approval: payload });

    for (const next of [withFalse, withOmitted]) {
      expect(next.agents.map((a) => a.name)).not.toContain('Nightwatch');
      expect(next.approvals).toHaveLength(initialState.approvals.length + 1);
      expect(next.approvals[next.approvals.length - 1].id).toBe(initialState.apprSeq);
      expect(next.apprSeq).toBe(initialState.apprSeq + 1);
    }
  });

  it('closes the reported race: a concurrent (e.g. tick-generated) ADD_APPROVAL followed by the chat one with autoResolve only ever affects the chat one\'s own target', () => {
    // Simulates the interleaving from the bug report: some other approval
    // (standing in for a tick.ts-generated one) gets added first, claiming an
    // id and bumping apprSeq -- exactly the kind of concurrent dispatch that
    // used to shift apprSeq out from under a caller-predicted id.
    const concurrent = reducer(initialState, {
      type: 'ADD_APPROVAL',
      approval: chatApproval({ verb: 'kill', targetAgentName: 'Test Runner', risk: 'HIGH', channelId: 'AETHER' }),
    });
    expect(concurrent.approvals).toHaveLength(initialState.approvals.length + 1);
    const concurrentApprovalId = concurrent.approvals[concurrent.approvals.length - 1].id;

    // Now the chat's own risky-verb dispatch arrives, auto-approved.
    const next = reducer(concurrent, {
      type: 'ADD_APPROVAL',
      approval: chatApproval({ verb: 'throttle', targetAgentName: 'Code Builder', risk: 'LOW', channelId: 'Code Builder' }),
      autoResolve: true,
    });

    // Only Code Builder (the chat's own target) was throttled...
    expect(next.agents.find((a) => a.name === 'Code Builder')?.share).toBe(0.08);
    // ...Test Runner (the concurrent approval's target) is untouched and still queued, unaffected.
    expect(next.agents.map((a) => a.name)).toContain('Test Runner');
    expect(next.approvals.map((a) => a.id)).toContain(concurrentApprovalId);
    expect(next.approvals).toHaveLength(concurrent.approvals.length);
  });

  it('SET_MEMORIES replaces memories wholesale', () => {
    const memories = [
      {
        id: 1,
        scope: 'shared' as const,
        ownerAgent: null,
        kind: 'decision' as const,
        content: 'Use pnpm for this repo',
        status: 'settled' as const,
        salience: 4,
        subject: 'tooling',
        createdAtMs: 1785200000000,
        updatedAtMs: 1785200000000,
        referenceCount: 2,
      },
    ];
    const next = reducer(initialState, { type: 'SET_MEMORIES', memories });
    expect(next.memories).toEqual(memories);
  });

  it('SET_ANOMALIES replaces anomalies wholesale', () => {
    const anomalies = [{ kind: 'reReadLoop' as const, toolUseId: 'tu1', detail: '/foo.ts read 3 times' }];
    const next = reducer(initialState, { type: 'SET_ANOMALIES', anomalies });
    expect(next.anomalies).toEqual(anomalies);
  });

  it('SET_CACHE_HIT_RATIO replaces cacheHitRatio wholesale', () => {
    const next = reducer(initialState, { type: 'SET_CACHE_HIT_RATIO', ratio: 0.42 });
    expect(next.cacheHitRatio).toBe(0.42);
  });

  it('SET_OPTIMIZE_FINDINGS replaces optimizeFindings wholesale', () => {
    const findings = [
      { id: 'opus-on-trivial-turns' as const, title: 'x', detail: 'y', estSavingsPerWeek: 1, fixText: 'z' },
    ];
    const next = reducer(initialState, { type: 'SET_OPTIMIZE_FINDINGS', findings });
    expect(next.optimizeFindings).toEqual(findings);
  });

  it('SET_LEDGER replaces ledger wholesale', () => {
    const ledger = {
      total: { usd: 1.5, breakdown: { input: 1, output: 0.5, cacheCreation: 0, cacheRead: 0 } },
      tiers: ['sonnet' as const],
      rollups: { today: 1.5, week: 1.5, month: 1.5 },
      cache: { cacheReadTokens: 0, wouldHaveCostUsd: 0, actuallyCostUsd: 0, savedUsd: 0 },
      cacheHitRate: 0,
      timeZone: 'UTC',
      computedAtMs: 1000,
    };
    const next = reducer(initialState, { type: 'SET_LEDGER', ledger });
    expect(next.ledger).toEqual(ledger);
  });

  it('SET_LEDGER accepts null, so a failed scan clears rather than freezes the view', () => {
    const seeded = reducer(initialState, {
      type: 'SET_LEDGER',
      ledger: {
        total: { usd: 9, breakdown: { input: 9, output: 0, cacheCreation: 0, cacheRead: 0 } },
        tiers: ['opus' as const],
        rollups: { today: 9, week: 9, month: 9 },
        cache: { cacheReadTokens: 0, wouldHaveCostUsd: 0, actuallyCostUsd: 0, savedUsd: 0 },
        cacheHitRate: 0,
        timeZone: 'UTC',
        computedAtMs: 1,
      },
    });
    expect(reducer(seeded, { type: 'SET_LEDGER', ledger: null }).ledger).toBeNull();
  });

  it('SET_PROJECTS_SNAPSHOT replaces projectsSnapshot wholesale', () => {
    const snapshot = { roots: [], unscoped: null, computedAtMs: 42 };
    const next = reducer(initialState, { type: 'SET_PROJECTS_SNAPSHOT', snapshot });
    expect(next.projectsSnapshot).toEqual(snapshot);
  });

  it('SET_PROJECTS_SNAPSHOT accepts null so a failed scan clears rather than freezes', () => {
    const seeded = reducer(initialState, {
      type: 'SET_PROJECTS_SNAPSHOT',
      snapshot: { roots: [], unscoped: null, computedAtMs: 1 },
    });
    expect(reducer(seeded, { type: 'SET_PROJECTS_SNAPSHOT', snapshot: null }).projectsSnapshot).toBeNull();
  });

  it('SET_STATUSLINE replaces statusline wholesale', () => {
    const snapshot: StatuslineSnapshot = {
      capturedAtMs: 1785200000000,
      sessionId: 'sess_1',
      modelId: 'claude-opus-4-6',
      modelDisplayName: 'Opus 4.6',
      fiveHour: { usedPercentage: 47, resetsAtMs: 1785200000000 },
      sevenDay: null,
      contextUsedPercentage: 62,
      contextWindowSize: 200000,
      contextUsage: null,
      totalCostUsd: 1.23,
      currentDir: '/home/user/project',
      projectDir: '/home/user/project',
    };
    const next = reducer(initialState, { type: 'SET_STATUSLINE', snapshot });
    expect(next.statusline).toBe(snapshot);
  });

  it('SET_OPTIMIZE_SUMMARY replaces optimizeSummary wholesale', () => {
    const summary = { totalPerWeek: 12.5, grade: 'B' as const };
    const next = reducer(initialState, { type: 'SET_OPTIMIZE_SUMMARY', summary });
    expect(next.optimizeSummary).toEqual(summary);
  });

  it('SET_OPTIMIZE_BREAKDOWN replaces optimizeBreakdown wholesale', () => {
    const rows = [{ key: 'model-routing', label: 'x', status: 'good' as const, note: 'y', scored: true }];
    const next = reducer(initialState, { type: 'SET_OPTIMIZE_BREAKDOWN', rows });
    expect(next.optimizeBreakdown).toEqual(rows);
  });
});
