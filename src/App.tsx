import { useCallback } from 'react';
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
import { useLedgerSync } from './state/useLedgerSync';
import { useTerminalAliveSync } from './state/useTerminalAliveSync';
import { useCodexTerminalAliveSync } from './state/useCodexTerminalAliveSync';
import { useProjectsSync } from './state/useProjectsSync';
import { useMemorySync } from './state/useMemorySync';
import { usePermissionRequestSync } from './state/usePermissionRequestSync';
import { usePostToolFlagSync } from './state/usePostToolFlagSync';
import { PermissionCardStack } from './components/agents/PermissionCardStack';
import { RecapBanner } from './components/dashboard/RecapBanner';

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
        <LedgerSync />
        <TerminalAliveSync />
        <CodexTerminalAliveSync />
        <ProjectsSync />
        <MemorySync />
        <PermissionRequestSync />
        <PostToolFlagSync />
        <RecapBannerMount />
        <ActiveView />
        <PermissionCardStack />
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

function LedgerSync() {
  useLedgerSync();
  return null;
}

function TerminalAliveSync() {
  useTerminalAliveSync();
  return null;
}

function CodexTerminalAliveSync() {
  useCodexTerminalAliveSync();
  return null;
}

function ProjectsSync() {
  useProjectsSync();
  return null;
}

function MemorySync() {
  useMemorySync();
  return null;
}

function PermissionRequestSync() {
  usePermissionRequestSync();
  return null;
}

function PostToolFlagSync() {
  usePostToolFlagSync();
  return null;
}

export function RecapBannerMount() {
  const { state, dispatch } = useAetherStore();
  // AetherStoreProvider dispatches TICK every 900ms for the app's lifetime,
  // producing a new context value (and thus a new inline callback, if one
  // were written here) on every render. RecapBanner's own auto-dismiss
  // useEffect depends on `onDismiss` -- an unstable reference recreated more
  // often than the 10s timeout would tear down and reschedule the
  // setTimeout before it ever fires, so the banner would never auto-dismiss
  // on its own. useCallback (dispatch is stable, from useReducer) keeps this
  // reference stable across those re-renders -- same pattern as
  // FilesView.tsx's `refresh`.
  const onDismiss = useCallback(() => dispatch({ type: 'DISMISS_RECAP' }), [dispatch]);
  return <RecapBanner recap={state.recap} onDismiss={onDismiss} />;
}
