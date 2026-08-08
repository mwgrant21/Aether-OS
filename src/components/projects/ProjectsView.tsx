import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { pickSelectedProject } from './projectsMath';
import { ProjectRosterCard } from './ProjectRosterCard';
import { ProjectDetailCard } from './ProjectDetailCard';

export function ProjectsView() {
  const { state } = useAetherStore();
  const selectedProject = pickSelectedProject(state.projects, state.selectedProject);

  return (
    <div style={rootStyle}>
      <ProjectRosterCard
        snapshot={state.projectsSnapshot}
        // Task 5 owns real key-based selection wiring (new SELECT_PROJECT { key }
        // action + findProjectByKey). The old reducer keys selection by project
        // *name*, which is not comparable to the roster's opaque keys, so we
        // deliberately pass null here rather than a broken name/key shim.
        selectedKey={null}
        onSelect={() => {}}
      />
      <ProjectDetailCard project={selectedProject} />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
