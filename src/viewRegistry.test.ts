import { describe, expect, it } from 'vitest';
import { VIEWS, getViewComponent } from './viewRegistry';

describe('viewRegistry', () => {
  it('has no duplicate ids', () => {
    const ids = VIEWS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('matches the current app\'s top-bar tabs and sidebar nav exactly', () => {
    const topBarIds = VIEWS.filter((v) => v.inTopBar).map((v) => v.id);
    const sidebarIds = VIEWS.filter((v) => v.inSidebar).map((v) => v.id);
    expect(topBarIds).toEqual(['Terminal', 'Chat', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Attachments']);
    expect(sidebarIds).toEqual(['Dashboard', 'Terminal', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Uplinks', 'Settings']);
  });

  it('getViewComponent returns null for ids with no built component', () => {
    expect(getViewComponent('NotARealTab')).toBeNull();
  });

  it('getViewComponent resolves Chat now that it is built', () => {
    expect(getViewComponent('Chat')).not.toBeNull();
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
});
