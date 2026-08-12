import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { findProjectByKey } from './projectsMath';
import { ProjectRosterCard } from './ProjectRosterCard';
import { ProjectDetailCard } from './ProjectDetailCard';

export function ProjectsView() {
  const { state, dispatch } = useAetherStore();
  const snapshot = state.projectsSnapshot;
  // A persisted key can name a project that no longer exists, so fall back to
  // the highest-cost root rather than stranding the panel on nothing.
  const selected = findProjectByKey(snapshot, state.selectedProject, { fallbackToFirst: true });

  return (
    <div style={rootStyle}>
      <ProjectRosterCard
        snapshot={snapshot}
        selectedKey={state.selectedProject}
        onSelect={(key) => dispatch({ type: 'SELECT_PROJECT', key })}
      />
      <ProjectDetailCard node={selected} />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
