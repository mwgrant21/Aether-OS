import type { CSSProperties } from 'react';
import { AgentBreakdownCard } from './AgentBreakdownCard';
import { TopCommandsCard } from './TopCommandsCard';
import { LogFrequencyCard } from './LogFrequencyCard';
import { TokenBurnCard } from './TokenBurnCard';

export function AnalyticsView() {
  return (
    <div style={gridStyle}>
      <AgentBreakdownCard />
      <TopCommandsCard />
      <LogFrequencyCard />
      <div style={{ gridColumn: '1 / -1' }}>
        <TokenBurnCard />
      </div>
    </div>
  );
}

const gridStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gridTemplateRows: '1fr auto', gap: 14 };
