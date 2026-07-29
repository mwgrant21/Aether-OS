import { AetherStoreProvider, useAetherStore } from './state/store';
import { AppShell } from './components/layout/AppShell';
import { ComingSoonPanel } from './components/layout/ComingSoonPanel';
import { BottomMetricsRow } from './components/layout/BottomMetricsRow';
import { getViewComponent } from './viewRegistry';
import { usePulseDurationVar } from './components/reactor/useReactorCanvas';
import { useRealUsageSync } from './components/dashboard/useRealUsageSync';
import { useRealAgentsSync } from './state/useRealAgentsSync';
import { useAlertSounds } from './state/useAlertSounds';
import { useOptimizeSync } from './state/useOptimizeSync';
import { useStatuslineSync } from './state/useStatuslineSync';
import { useFleetSync } from './state/useFleetSync';
import { useDiagnosticsSync } from './state/useDiagnosticsSync';
import { usePermissionRequestSync } from './state/usePermissionRequestSync';
import { PermissionRequestCard } from './components/agents/PermissionRequestCard';

function ActiveView() {
  const { state } = useAetherStore();
  const Component = getViewComponent(state.activeTab);
  if (Component) return <Component />;
  return <ComingSoonPanel tabName={state.activeTab} />;
}

export default function App() {
  return (
    <AetherStoreProvider>
      <AppShell>
        <PulseDurationSync />
        <RealUsageSync />
        <RealAgentsSync />
        <AlertSounds />
        <OptimizeSync />
        <StatuslineSync />
        <FleetSync />
        <DiagnosticsSync />
        <PermissionRequestSync />
        <ActiveView />
        <PermissionRequestCard />
        <BottomMetricsRow />
      </AppShell>
    </AetherStoreProvider>
  );
}

function PulseDurationSync() {
  usePulseDurationVar();
  return null;
}

function RealUsageSync() {
  useRealUsageSync();
  return null;
}

function RealAgentsSync() {
  useRealAgentsSync();
  return null;
}

function AlertSounds() {
  useAlertSounds();
  return null;
}

function OptimizeSync() {
  useOptimizeSync();
  return null;
}

function StatuslineSync() {
  useStatuslineSync();
  return null;
}

function FleetSync() {
  useFleetSync();
  return null;
}

function DiagnosticsSync() {
  useDiagnosticsSync();
  return null;
}

function PermissionRequestSync() {
  usePermissionRequestSync();
  return null;
}
