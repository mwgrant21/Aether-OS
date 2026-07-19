import type { ProjectStatus, ProjectStub } from '../../state/types';

export const STATUS_COLOR: Record<ProjectStatus, string> = {
  BUILDING: '#7ef0ff',
  REVIEW: '#f5c66b',
  QUEUED: '#5f8a97',
  SHIPPED: '#3be0a0',
};

const STATUS_ORDER: ProjectStatus[] = ['BUILDING', 'REVIEW', 'QUEUED', 'SHIPPED'];

export function pickSelectedProject(projects: ProjectStub[], selected: string | null): ProjectStub | null {
  if (selected) {
    const match = projects.find((p) => p.name === selected);
    if (match) return match;
  }
  return projects[0] ?? null;
}

export function groupProjectsByStatus(projects: ProjectStub[]): { status: ProjectStatus; projects: ProjectStub[] }[] {
  return STATUS_ORDER.map((status) => ({ status, projects: projects.filter((p) => p.status === status) })).filter(
    (group) => group.projects.length > 0,
  );
}

export function computeLiveProjectPct(project: ProjectStub, used: number): number {
  return project.status === 'BUILDING' ? Math.min(99, Math.round(project.pct + (used - 24391) / 30000)) : project.pct;
}
