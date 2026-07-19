import { describe, expect, it } from 'vitest';
import { computeLiveProjectPct, groupProjectsByStatus, pickSelectedProject } from './projectsMath';
import { initialState } from '../../state/initialState';

describe('pickSelectedProject', () => {
  it('returns the project matching selected when present', () => {
    const project = pickSelectedProject(initialState.projects, 'Mobile Beta');
    expect(project?.name).toBe('Mobile Beta');
  });

  it('falls back to the first project when selected is null', () => {
    const project = pickSelectedProject(initialState.projects, null);
    expect(project?.name).toBe(initialState.projects[0].name);
  });

  it('falls back to the first project when selected does not match any project', () => {
    const project = pickSelectedProject(initialState.projects, 'Nonexistent Project');
    expect(project?.name).toBe(initialState.projects[0].name);
  });

  it('returns null when there are no projects at all', () => {
    expect(pickSelectedProject([], 'Anything')).toBeNull();
  });
});

describe('groupProjectsByStatus', () => {
  it('groups the seed projects into all four statuses, in BUILDING/REVIEW/QUEUED/SHIPPED order', () => {
    const groups = groupProjectsByStatus(initialState.projects);
    expect(groups.map((g) => g.status)).toEqual(['BUILDING', 'REVIEW', 'QUEUED', 'SHIPPED']);
    expect(groups.find((g) => g.status === 'BUILDING')?.projects.map((p) => p.name)).toEqual(['CLI Companion']);
    expect(groups.find((g) => g.status === 'REVIEW')?.projects.map((p) => p.name)).toEqual(['Mobile Beta']);
  });

  it('omits statuses with zero projects, preserving order for the ones that remain', () => {
    const subset = initialState.projects.filter((p) => p.status === 'BUILDING' || p.status === 'SHIPPED');
    const groups = groupProjectsByStatus(subset);
    expect(groups.map((g) => g.status)).toEqual(['BUILDING', 'SHIPPED']);
  });

  it('returns an empty array for an empty input', () => {
    expect(groupProjectsByStatus([])).toEqual([]);
  });
});

describe('computeLiveProjectPct', () => {
  it('returns the unchanged pct for a BUILDING project when used is at the seed baseline', () => {
    const cliCompanion = initialState.projects.find((p) => p.name === 'CLI Companion')!;
    expect(computeLiveProjectPct(cliCompanion, 24391)).toBe(62);
  });

  it('animates a BUILDING project pct upward as used climbs, capped at 99', () => {
    const cliCompanion = initialState.projects.find((p) => p.name === 'CLI Companion')!;
    expect(computeLiveProjectPct(cliCompanion, 24391 + 30000)).toBe(63);
    expect(computeLiveProjectPct(cliCompanion, 24391 + 40 * 30000)).toBe(99);
  });

  it('returns the stored pct unchanged for non-BUILDING statuses regardless of used', () => {
    const mobileBeta = initialState.projects.find((p) => p.name === 'Mobile Beta')!;
    expect(computeLiveProjectPct(mobileBeta, 24391 + 40 * 30000)).toBe(mobileBeta.pct);
  });
});
