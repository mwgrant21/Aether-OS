import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPersisted, savePersisted } from './persistence';
import { initialState } from './initialState';

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

  it('persists Dashboard state (projects/providers/routeDefault) across reloads', () => {
    savePersisted({ ...initialState, routeDefault: 'Manual' });
    const loaded = loadPersisted();
    expect(loaded?.projects).toEqual(initialState.projects);
    expect(loaded?.providers).toEqual(initialState.providers);
    expect(loaded?.routeDefault).toBe('Manual');
  });

  it('persists the selected agent across reloads', () => {
    savePersisted({ ...initialState, selected: 'Database Agent' });
    const loaded = loadPersisted();
    expect(loaded?.selected).toBe('Database Agent');
  });

  it('persists the selected project across reloads', () => {
    savePersisted({ ...initialState, selectedProject: 'Mobile Beta' });
    const loaded = loadPersisted();
    expect(loaded?.selectedProject).toBe('Mobile Beta');
  });

  it('persists memories and selectedMemory across reloads', () => {
    savePersisted({ ...initialState, selectedMemory: '2' });
    const loaded = loadPersisted();
    expect(loaded?.memories).toEqual(initialState.memories);
    expect(loaded?.selectedMemory).toBe('2');
  });

  it('persists memSeq across reloads', () => {
    savePersisted({ ...initialState, memSeq: 42 });
    const loaded = loadPersisted();
    expect(loaded?.memSeq).toBe(42);
  });

  it('persists chatActionResults across reloads', () => {
    const pending = [{ channelId: 'AETHER', text: '✓ Approved — Nightwatch spawned.' }];
    savePersisted({ ...initialState, chatActionResults: pending });
    const loaded = loadPersisted();
    expect(loaded?.chatActionResults).toEqual(pending);
  });

  it('persists operatorName across reloads', () => {
    savePersisted({ ...initialState, operatorName: 'Matt' });
    const loaded = loadPersisted();
    expect(loaded?.operatorName).toBe('Matt');
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
});
