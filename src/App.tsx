import { AetherStoreProvider, useAetherStore } from './state/store';
import { AppShell } from './components/layout/AppShell';
import { ComingSoonPanel } from './components/layout/ComingSoonPanel';
import { BottomMetricsRow } from './components/layout/BottomMetricsRow';
import { getViewComponent } from './viewRegistry';
import { usePulseDurationVar } from './components/reactor/useReactorCanvas';
import { useRealUsageSync } from './components/dashboard/useRealUsageSync';
import { useRealAgentsSync } from './state/useRealAgentsSync';
import { useAlertSounds } from './state/useAlertSounds';

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
        <ActiveView />
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
