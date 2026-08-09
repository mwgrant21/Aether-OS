import type { ComponentType } from 'react';
import { TerminalView } from './components/terminal/TerminalView';
import { DashboardView } from './components/dashboard/DashboardView';
import { AgentsView } from './components/agents/AgentsView';
import { GridView } from './components/grid/GridView';
import { CommsView } from './components/comms/CommsView';
import { ProjectsView } from './components/projects/ProjectsView';
import { MemoryView } from './components/memory/MemoryView';
import { AnalyticsView } from './components/analytics/AnalyticsView';
import { LedgerView } from './components/ledger/LedgerView';
import { SettingsView } from './components/settings/SettingsView';
import { FilesView } from './components/files/FilesView';
import { UplinksView } from './components/uplinks/UplinksView';
import { OptimizeView } from './components/optimize/OptimizeView';

export interface ViewDef {
  id: string;
  inSidebar: boolean;
  component: ComponentType | null;
}

export const VIEWS: ViewDef[] = [
  { id: 'Dashboard', inSidebar: true, component: DashboardView },
  { id: 'Terminal', inSidebar: true, component: TerminalView },
  { id: 'Comms', inSidebar: true, component: CommsView },
  { id: 'Agents', inSidebar: true, component: AgentsView },
  { id: 'Grid', inSidebar: true, component: GridView },
  { id: 'Projects', inSidebar: true, component: ProjectsView },
  { id: 'Memory', inSidebar: true, component: MemoryView },
  { id: 'Analytics', inSidebar: true, component: AnalyticsView },
  { id: 'Ledger', inSidebar: true, component: LedgerView },
  { id: 'Attachments', inSidebar: true, component: FilesView },
  { id: 'Optimize', inSidebar: true, component: OptimizeView },
  { id: 'Uplinks', inSidebar: true, component: UplinksView },
  { id: 'Settings', inSidebar: true, component: SettingsView },
];

export function getViewComponent(id: string): ComponentType | null {
  return VIEWS.find((v) => v.id === id)?.component ?? null;
}
