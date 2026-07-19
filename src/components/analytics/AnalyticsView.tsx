import type { CSSProperties } from 'react';
import { AgentBreakdownCard } from './AgentBreakdownCard';
import { TopCommandsCard } from './TopCommandsCard';
import { SystemMetricsCard } from './SystemMetricsCard';
import { LogFrequencyCard } from './LogFrequencyCard';

export function AnalyticsView() {
  return (
    <div style={gridStyle}>
      <AgentBreakdownCard />
      <TopCommandsCard />
      <SystemMetricsCard />
      <LogFrequencyCard />
    </div>
  );
}

const gridStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 14 };
