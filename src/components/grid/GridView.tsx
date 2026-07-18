import { useAetherStore } from '../../state/store';
import { OrchestrationGrid } from './OrchestrationGrid';

export function GridView() {
  const { state, dispatch } = useAetherStore();

  return (
    <OrchestrationGrid
      agents={state.agents}
      projects={state.projects}
      rate={state.rate}
      onSelectAgent={(name) => {
        dispatch({ type: 'SELECT_AGENT', name });
        dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Agents' });
      }}
      onOpenProjects={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Projects' })}
    />
  );
}
