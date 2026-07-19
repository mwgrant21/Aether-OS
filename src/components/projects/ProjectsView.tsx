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
      <ProjectRosterCard selectedName={selectedProject?.name ?? null} />
      <ProjectDetailCard project={selectedProject} />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
