import { useCallback, useEffect, useState } from 'react';
import type { UiProject } from '../../electron/gui/guiTypes';

const REASON_TEXT: Record<string, string> = {
  duplicate: 'That folder is already pinned',
  'not-a-directory': 'That is not a usable folder',
  'too-many': 'Too many pinned folders',
  unavailable: 'Folder storage is not available this run',
  'write-failed': 'Could not save the pinned folder',
};

export interface GuiProjectsApi {
  projects: UiProject[];
  /** False outside Electron (no preload bridge): the shell shows a notice instead of crashing. */
  available: boolean;
  error: string | null;
  pin: () => Promise<void>;
  unpin: (id: string) => Promise<boolean>;
}

export function useGuiProjects(): GuiProjectsApi {
  const gui = typeof window === 'undefined' ? undefined : window.aetherElectron?.gui;
  const available = !!gui;
  const [projects, setProjects] = useState<UiProject[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!gui) return;
    let cancelled = false;
    gui.projects
      .list()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load pinned folders');
      });
    return () => {
      cancelled = true;
    };
  }, [gui]);

  const pin = useCallback(async () => {
    if (!gui) return;
    setError(null);
    try {
      const r = await gui.projects.add();
      if (r.ok) {
        setProjects((prev) => (prev.some((p) => p.id === r.project.id) ? prev : [...prev, r.project]));
      } else if (r.reason !== 'canceled') {
        setError(REASON_TEXT[r.reason] ?? 'Could not pin that folder');
      }
    } catch {
      setError('Could not pin that folder');
    }
  }, [gui]);

  const unpin = useCallback(
    async (id: string) => {
      if (!gui) return false;
      setError(null);
      try {
        const ok = await gui.projects.remove(id);
        if (ok) setProjects((prev) => prev.filter((p) => p.id !== id));
        return ok;
      } catch {
        setError('Could not remove the pinned folder');
        return false;
      }
    },
    [gui],
  );

  return { projects, available, error, pin, unpin };
}
