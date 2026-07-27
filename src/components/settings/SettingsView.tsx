import type { CSSProperties } from 'react';
import { OperatingModeCard } from './OperatingModeCard';
import { AppearanceCard } from './AppearanceCard';
import { BudgetAlertsCard } from './BudgetAlertsCard';
import { OperatorCard } from './OperatorCard';
import { ChatBackendCard } from './ChatBackendCard';
import { StatuslineCard } from './StatuslineCard';

export function SettingsView() {
  return (
    <div style={rootStyle}>
      <div style={columnStyle}>
        <OperatorCard />
        <OperatingModeCard />
        <ChatBackendCard />
        <BudgetAlertsCard />
        <StatuslineCard />
      </div>
      <AppearanceCard />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
const columnStyle: CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 };
