import type { ComponentType } from 'react';
import { TerminalView } from './components/terminal/TerminalView';
import { DashboardView } from './components/dashboard/DashboardView';
import { AgentsView } from './components/agents/AgentsView';
import { GridView } from './components/grid/GridView';
import { ChatView } from './components/chat/ChatView';
import { ProjectsView } from './components/projects/ProjectsView';
import { MemoryView } from './components/memory/MemoryView';
import { AnalyticsView } from './components/analytics/AnalyticsView';
import { SettingsView } from './components/settings/SettingsView';
import { FilesView } from './components/files/FilesView';
import { UplinksView } from './components/uplinks/UplinksView';

export interface ViewDef {
  id: string;
  inTopBar: boolean;
  inSidebar: boolean;
  component: ComponentType | null;
}

export const VIEWS: ViewDef[] = [
  { id: 'Dashboard', inTopBar: false, inSidebar: true, component: DashboardView },
  { id: 'Terminal', inTopBar: true, inSidebar: true, component: TerminalView },
  { id: 'Chat', inTopBar: true, inSidebar: false, component: ChatView },
  { id: 'Agents', inTopBar: true, inSidebar: true, component: AgentsView },
  { id: 'Grid', inTopBar: true, inSidebar: true, component: GridView },
  { id: 'Projects', inTopBar: true, inSidebar: true, component: ProjectsView },
  { id: 'Memory', inTopBar: true, inSidebar: true, component: MemoryView },
  { id: 'Analytics', inTopBar: true, inSidebar: true, component: AnalyticsView },
  { id: 'Files', inTopBar: true, inSidebar: false, component: FilesView },
  { id: 'Uplinks', inTopBar: false, inSidebar: true, component: UplinksView },
  { id: 'Settings', inTopBar: false, inSidebar: true, component: SettingsView },
];

export function getViewComponent(id: string): ComponentType | null {
  return VIEWS.find((v) => v.id === id)?.component ?? null;
}
