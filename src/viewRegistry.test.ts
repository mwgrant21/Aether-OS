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
    expect(topBarIds).toEqual(['Terminal', 'Chat', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Files']);
    expect(sidebarIds).toEqual(['Dashboard', 'Terminal', 'Agents', 'Grid', 'Projects', 'Memory', 'Analytics', 'Uplinks', 'Settings']);
  });

  it('getViewComponent returns null for ids with no built component', () => {
    expect(getViewComponent('Chat')).toBeNull();
    expect(getViewComponent('NotARealTab')).toBeNull();
  });
});
