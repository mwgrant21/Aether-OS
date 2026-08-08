import type { ProjectNode, ProjectsSnapshot } from '../../shared/projectsSnapshot';

export function findProjectByKey(
  snapshot: ProjectsSnapshot | null,
  key: string | null,
  opts: { fallbackToFirst?: boolean } = {},
): ProjectNode | null {
  if (!snapshot) return null;
  if (key) {
    for (const root of snapshot.roots) {
      if (root.key === key) return root;
      const child = root.children.find((c) => c.key === key);
      if (child) return child;
    }
  }
  // A persisted key can name a project that no longer exists; fall through
  // rather than stranding the panel on nothing.
  return opts.fallbackToFirst ? snapshot.roots[0] ?? null : null;
}
