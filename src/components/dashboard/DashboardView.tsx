import type { CSSProperties } from 'react';
import { ReactorStatusCard } from './ReactorStatusCard';
import { ActiveAgentsDigest } from './ActiveAgentsDigest';
import { ProjectsDigest } from './ProjectsDigest';
import { RecentAlertsCard } from './RecentAlertsCard';
import { SystemsCard } from './SystemsCard';

export function DashboardView() {
  return (
    <div style={gridStyle}>
      <ReactorStatusCard />
      <ActiveAgentsDigest />
      <ProjectsDigest />
      <RecentAlertsCard />
      <SystemsCard />
    </div>
  );
}

const gridStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'grid',
  gridTemplateColumns: '1.05fr 1fr 1fr',
  gridTemplateRows: '1fr 1fr',
  gap: 14,
};
