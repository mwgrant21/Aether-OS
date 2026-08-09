import { describe, expect, it } from 'vitest';
import { VIEWS, getViewComponent } from './viewRegistry';

describe('viewRegistry', () => {
  it('has no duplicate ids', () => {
    const ids = VIEWS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('matches the current app\'s sidebar nav exactly -- navigation lives only in the sidebar now, no top-bar tab strip', () => {
    const sidebarIds = VIEWS.filter((v) => v.inSidebar).map((v) => v.id);
    expect(sidebarIds).toEqual([
      'Dashboard',
      'Terminal',
      'Comms',
      'Agents',
      'Grid',
      'Projects',
      'Memory',
      'Analytics',
      'Ledger',
      'Attachments',
      'Optimize',
      'Uplinks',
      'Settings',
    ]);
  });

  it('getViewComponent returns null for ids with no built component', () => {
    expect(getViewComponent('NotARealTab')).toBeNull();
  });

  it('getViewComponent resolves Comms now that it is built', () => {
    expect(getViewComponent('Comms')).not.toBeNull();
  });

  it('getViewComponent resolves Dashboard now that it is built', () => {
    expect(getViewComponent('Dashboard')).not.toBeNull();
  });

  it('getViewComponent resolves Agents now that it is built', () => {
    expect(getViewComponent('Agents')).not.toBeNull();
  });

  it('getViewComponent resolves Grid now that it is built', () => {
    expect(getViewComponent('Grid')).not.toBeNull();
  });

  it('getViewComponent resolves Projects now that it is built', () => {
    expect(getViewComponent('Projects')).not.toBeNull();
  });

  it('getViewComponent resolves Memory now that it is built', () => {
    expect(getViewComponent('Memory')).not.toBeNull();
  });

  it('getViewComponent resolves Analytics now that it is built', () => {
    expect(getViewComponent('Analytics')).not.toBeNull();
  });

  it('getViewComponent resolves Settings now that it is built', () => {
    expect(getViewComponent('Settings')).not.toBeNull();
  });

  it('getViewComponent resolves Uplinks now that it is built', () => {
    expect(getViewComponent('Uplinks')).not.toBeNull();
  });

  it('getViewComponent resolves Attachments now that it is built', () => {
    expect(getViewComponent('Attachments')).not.toBeNull();
  });

  it('getViewComponent resolves Ledger now that it is built', () => {
    expect(getViewComponent('Ledger')).not.toBeNull();
  });

  it('getViewComponent resolves Optimize now that it is built', () => {
    expect(getViewComponent('Optimize')).not.toBeNull();
  });
});
