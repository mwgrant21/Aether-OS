import { AetherStoreProvider, useAetherStore } from './state/store';
import { AppShell } from './components/layout/AppShell';
import { ComingSoonPanel } from './components/layout/ComingSoonPanel';
import { BottomMetricsRow } from './components/layout/BottomMetricsRow';

function ActiveView() {
  const { state } = useAetherStore();
  if (state.activeTab === 'Terminal') {
    // TerminalView is wired in here in Task 10 — for now fall through to ComingSoonPanel
    // so the app has something real to render at every step of this plan.
  }
  return <ComingSoonPanel tabName={state.activeTab} />;
}

export default function App() {
  return (
    <AetherStoreProvider>
      <AppShell>
        <ActiveView />
        <BottomMetricsRow />
      </AppShell>
    </AetherStoreProvider>
  );
}
