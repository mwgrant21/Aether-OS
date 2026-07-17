import { describe, expect, it } from 'vitest';
import { reducer } from './reducer';
import { initialState } from './initialState';

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
        { name: 'Support Portal', status: 'BUILDING' as const, pct: 10, hue: '#fff' },
        { name: 'Internal Tools', status: 'BUILDING' as const, pct: 10, hue: '#fff' },
        { name: 'Marketing Site', status: 'BUILDING' as const, pct: 10, hue: '#fff' },
      ],
    };
    const next = reducer(withAllTaken, { type: 'NEW_PROJECT' });
    expect(next.projects[0].name).toBe('Project 4');
  });

});
