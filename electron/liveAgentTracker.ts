import path from 'path';
import { findSessionFileCreatedAfter } from './activeSessionFinder';
import { readNewLines } from './transcriptTailer';
import {
  applyLinesToOpenDispatches,
  applyLinesToOpenWork,
  type RealAgentDispatch,
  type CompletedDispatchUsage,
  type RealActiveWork,
} from '../src/state/liveAgentsMath';
import { cwdToProjectDirName } from '../src/state/projectDirName';

export interface LiveAgentTick {
  open: RealAgentDispatch[];
  completed: CompletedDispatchUsage[];
  work: RealActiveWork[];
}

// The embedded terminal always spawns `claude` with cwd = homeDir (see
// ptyManager.ts), so its transcript always lands in this one project
// directory. Rather than scanning every project directory on the machine for
// whichever file was touched most recently -- which any other concurrently
// active Claude Code session (even an unrelated background one) can win --
// this tracker is pinned to the specific file created by this app's own pty
// spawn, and only that file is ever tailed until the pty respawns.
export function createLiveAgentTracker(homeDir: string) {
  const sessionDir = path.join(homeDir, '.claude', 'projects', cwdToProjectDirName(homeDir));

  let spawnedAtMs: number | null = null;
  let pinnedFile: string | null = null;
  let currentOffset = 0;
  let currentOpen: RealAgentDispatch[] = [];
  let currentWork: RealActiveWork[] = [];

  return {
    notifyPtySpawned(atMs: number): void {
      spawnedAtMs = atMs;
      pinnedFile = null;
      currentOffset = 0;
      currentOpen = [];
      currentWork = [];
    },

    async tick(): Promise<LiveAgentTick> {
      if (!pinnedFile) {
        if (spawnedAtMs === null) return { open: currentOpen, completed: [], work: currentWork };
        const found = await findSessionFileCreatedAfter(sessionDir, spawnedAtMs);
        if (!found) return { open: currentOpen, completed: [], work: currentWork };
        pinnedFile = found;
        currentOffset = 0;
        currentOpen = [];
        currentWork = [];
      }

      const { lines, newOffset } = await readNewLines(pinnedFile, currentOffset);
      if (lines.length === 0) return { open: currentOpen, completed: [], work: currentWork };
      currentOffset = newOffset;
      const completed: CompletedDispatchUsage[] = [];
      currentOpen = applyLinesToOpenDispatches(currentOpen, lines, completed);
      currentWork = applyLinesToOpenWork(currentWork, lines);
      return { open: currentOpen, completed, work: currentWork };
    },
  };
}
