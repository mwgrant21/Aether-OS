import { AetherStoreProvider, useAetherStore } from './state/store';
import { AppShell } from './components/layout/AppShell';
import { ComingSoonPanel } from './components/layout/ComingSoonPanel';
import { BottomMetricsRow } from './components/layout/BottomMetricsRow';
import { TerminalView } from './components/terminal/TerminalView';

function ActiveView() {
  const { state } = useAetherStore();
  if (state.activeTab === 'Terminal') return <TerminalView />;
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
