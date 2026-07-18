import type { ComponentType } from 'react';
import { TerminalView } from './components/terminal/TerminalView';
import { DashboardView } from './components/dashboard/DashboardView';
import { AgentsView } from './components/agents/AgentsView';
import { GridView } from './components/grid/GridView';

export interface ViewDef {
  id: string;
  inTopBar: boolean;
  inSidebar: boolean;
  component: ComponentType | null;
}

export const VIEWS: ViewDef[] = [
  { id: 'Dashboard', inTopBar: false, inSidebar: true, component: DashboardView },
  { id: 'Terminal', inTopBar: true, inSidebar: true, component: TerminalView },
  { id: 'Chat', inTopBar: true, inSidebar: false, component: null },
  { id: 'Agents', inTopBar: true, inSidebar: true, component: AgentsView },
  { id: 'Grid', inTopBar: true, inSidebar: true, component: GridView },
  { id: 'Projects', inTopBar: true, inSidebar: true, component: null },
  { id: 'Memory', inTopBar: true, inSidebar: true, component: null },
  { id: 'Analytics', inTopBar: true, inSidebar: true, component: null },
  { id: 'Files', inTopBar: true, inSidebar: false, component: null },
  { id: 'Uplinks', inTopBar: false, inSidebar: true, component: null },
  { id: 'Settings', inTopBar: false, inSidebar: true, component: null },
];

export function getViewComponent(id: string): ComponentType | null {
  return VIEWS.find((v) => v.id === id)?.component ?? null;
}
