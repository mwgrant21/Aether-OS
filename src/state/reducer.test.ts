import { describe, expect, it } from 'vitest';
import { reducer } from './reducer';
import { initialState } from './initialState';
import type { Approval } from './types';

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
    const next = reducer(initialState, { type: 'SELECT_PROJECT', name: 'Mobile Beta' });
    expect(next.selectedProject).toBe('Mobile Beta');
  });

  it('SELECT_MEMORY sets selectedMemory to the stringified id', () => {
    const next = reducer(initialState, { type: 'SELECT_MEMORY', id: 2 });
    expect(next.selectedMemory).toBe('2');
  });

  it('TOGGLE_MEMORY_PIN flips pinned on the matching memory only', () => {
    const next = reducer(initialState, { type: 'TOGGLE_MEMORY_PIN', id: 2 });
    expect(next.memories.find((m) => m.id === 2)?.pinned).toBe(true);
    expect(next.memories.find((m) => m.id === 1)?.pinned).toBe(true); // unchanged (already pinned in seed data)
    const restored = reducer(next, { type: 'TOGGLE_MEMORY_PIN', id: 2 });
    expect(restored.memories.find((m) => m.id === 2)?.pinned).toBe(false);
  });

  it('HIST_NAV walks command history backwards then forwards to empty', () => {
    const withHist = { ...initialState, cmdHist: ['status', 'agents'], histIdx: -1 };
    const up1 = reducer(withHist, { type: 'HIST_NAV', up: true });
    expect(up1.cmdVal).toBe('agents');
    expect(up1.histIdx).toBe(1);
    const up2 = reducer(up1, { type: 'HIST_NAV', up: true });
    expect(up2.cmdVal).toBe('status');
    const down1 = reducer(up2, { type: 'HIST_NAV', up: false });
    expect(down1.cmdVal).toBe('agents');
    const down2 = reducer(down1, { type: 'HIST_NAV', up: false });
    expect(down2.cmdVal).toBe('');
    expect(down2.histIdx).toBe(-1);
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

  it('NEW_PROJECT adds an unused project from the pool, cycling hues', () => {
    const next = reducer(initialState, { type: 'NEW_PROJECT' });
    expect(next.projects).toHaveLength(initialState.projects.length + 1);
    const added = next.projects[0];
    expect(added.name).toBe('Support Portal');
    expect(added.status).toBe('QUEUED');
    expect(added.pct).toBe(0);
    expect(added.hue).toBe('#9bd0ff');
  });

  it('NEW_PROJECT falls back to a numbered name once the pool is exhausted', () => {
    const withAllTaken = {
      ...initialState,
      projects: [
        { name: 'Support Portal', status: 'BUILDING' as const, pct: 10, hue: '#fff', crew: [] },
        { name: 'Internal Tools', status: 'BUILDING' as const, pct: 10, hue: '#fff', crew: [] },
        { name: 'Marketing Site', status: 'BUILDING' as const, pct: 10, hue: '#fff', crew: [] },
      ],
    };
    const next = reducer(withAllTaken, { type: 'NEW_PROJECT' });
    expect(next.projects[0].name).toBe('Project 4');
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
    expect(next.chatActionResults).toEqual([{ channelId: 'AETHER', text: '✓ Approved — Nightwatch spawned.' }]);
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

  it('RESOLVE_APPROVAL gracefully no-ops the mutation (but still resolves + emits the result) when the target agent is already gone', () => {
    const withApproval = { ...initialState, approvals: [...initialState.approvals, chatApproval({ id: 53, verb: 'kill', targetAgentName: 'Nobody', risk: 'HIGH', channelId: 'AETHER' })] };
    const next = reducer(withApproval, { type: 'RESOLVE_APPROVAL', id: 53, approve: true });
    expect(next.approvals.map((a) => a.id)).not.toContain(53);
    expect(next.chatActionResults).toHaveLength(1);
  });

  it('RESOLVE_APPROVAL on a denied chat approval emits a denial line to its channel and applies no mutation', () => {
    const withApproval = { ...initialState, approvals: [...initialState.approvals, chatApproval({ id: 54, verb: 'spawn', targetAgentName: 'Nightwatch', risk: 'MED', channelId: 'AETHER' })] };
    const next = reducer(withApproval, { type: 'RESOLVE_APPROVAL', id: 54, approve: false });
    expect(next.agents.map((a) => a.name)).not.toContain('Nightwatch');
    expect(next.chatActionResults).toEqual([{ channelId: 'AETHER', text: '✗ Denied: Spawn Nightwatch.' }]);
  });

  it('RESOLVE_APPROVAL on the pre-existing seed approvals is byte-for-byte unchanged (no verb, no chatActionResults emitted)', () => {
    const next = reducer(initialState, { type: 'RESOLVE_APPROVAL', id: 1, approve: true });
    expect(next.rate).toBe(initialState.rate + 9000);
    expect(next.chatActionResults).toEqual([]);
  });

  it('CLEAR_CHAT_ACTION_RESULTS removes exactly the first N entries, preserving any added after', () => {
    const withResults = { ...initialState, chatActionResults: [{ channelId: 'a', text: '1' }, { channelId: 'b', text: '2' }, { channelId: 'c', text: '3' }] };
    const next = reducer(withResults, { type: 'CLEAR_CHAT_ACTION_RESULTS', count: 2 });
    expect(next.chatActionResults).toEqual([{ channelId: 'c', text: '3' }]);
  });
});

describe('reducer — ADD_APPROVAL autoResolve atomicity (closes the chat AUTO-mode race)', () => {
  it('autoResolve: true immediately executes the mutation and emits chatActionResults, never adding the approval to state.approvals', () => {
    const payload = chatApproval({ id: undefined as any, verb: 'throttle', targetAgentName: 'Code Builder', risk: 'LOW', channelId: 'Code Builder' }) as any;
    const next = reducer(initialState, { type: 'ADD_APPROVAL', approval: payload, autoResolve: true });

    // The mutation happened immediately.
    expect(next.agents.find((a) => a.name === 'Code Builder')?.share).toBe(0.08);
    // The chat confirmation was emitted immediately.
    expect(next.chatActionResults).toHaveLength(1);
    expect(next.chatActionResults[0].channelId).toBe('Code Builder');
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
      expect(next.chatActionResults).toEqual([]);
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
});
