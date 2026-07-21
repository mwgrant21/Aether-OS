import { useAetherStore } from '../../state/store';
import { OrchestrationGrid } from './OrchestrationGrid';

export function GridView() {
  const { state, dispatch } = useAetherStore();

  return (
    <OrchestrationGrid
      agents={state.realAgents}
      rate={state.rate}
      onSelectRealAgent={(toolUseId) => {
        dispatch({ type: 'SELECT_REAL_AGENT', toolUseId });
        dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Agents' });
      }}
    />
  );
}
