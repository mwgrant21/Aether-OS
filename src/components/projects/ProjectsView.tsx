import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { pickSelectedProject } from './projectsMath';
import { ProjectRosterCard } from './ProjectRosterCard';
import { ProjectDetailCard } from './ProjectDetailCard';

export function ProjectsView() {
  const { state, dispatch } = useAetherStore();
  const selectedProject = pickSelectedProject(state.projects, state.selectedProject);

  return (
    <div style={rootStyle}>
      <ProjectRosterCard
        snapshot={state.projectsSnapshot}
        selectedKey={state.selectedProject}
        onSelect={(key) => {
          // For now, map the key back to a project name for the old system.
          // TODO: eventually retire the old project system entirely.
          if (state.projectsSnapshot?.roots) {
            for (const root of state.projectsSnapshot.roots) {
              if (root.key === key) {
                dispatch({ type: 'SELECT_PROJECT', name: root.name });
                return;
              }
              for (const child of root.children) {
                if (child.key === key) {
                  dispatch({ type: 'SELECT_PROJECT', name: child.name });
                  return;
                }
              }
            }
          }
        }}
      />
      <ProjectDetailCard project={selectedProject} />
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
