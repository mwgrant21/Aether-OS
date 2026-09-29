import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { ReactorStatusCard } from './ReactorStatusCard';
import { ReadinessCard } from './ReadinessCard';
import { StandbyStrip } from './StandbyStrip';
import { DigestSlot } from './DigestSlot';
import { ActiveAgentsDigest } from './ActiveAgentsDigest';
import { ProjectsDigest } from './ProjectsDigest';
import { RecentAlertsCard } from './RecentAlertsCard';
import { computeDigestPresence } from './readinessMath';

/**
 * Two columns. The reactor fills the left half. The right half is READINESS,
 * then a panel for each digest that has data, then the STANDBY STRIP listing
 * the ones that don't -- so an idle console draws no empty boxes.
 */
export function DashboardView() {
  const { state } = useAetherStore();
  const presence = computeDigestPresence(state);
  const anyDigest = presence.agents || presence.projects || presence.alerts;
  return (
    <div style={gridStyle}>
      <ReactorStatusCard />
      <div data-testid="dashboard-right-column" style={rightColumnStyle}>
        <ReadinessCard fill={!anyDigest} />
        <DigestSlot present={presence.agents}>
          <ActiveAgentsDigest />
        </DigestSlot>
        <DigestSlot present={presence.projects}>
          <ProjectsDigest />
        </DigestSlot>
        <DigestSlot present={presence.alerts}>
          <RecentAlertsCard />
        </DigestSlot>
        <StandbyStrip />
      </div>
    </div>
  );
}

const gridStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gridTemplateRows: 'minmax(0, 1fr)',
  gap: 14,
};
const rightColumnStyle: CSSProperties = { position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14 };
