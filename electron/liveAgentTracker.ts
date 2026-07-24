import { findMostRecentSessionFile } from './activeSessionFinder';
import { readNewLines } from './transcriptTailer';
import { applyLinesToOpenDispatches, type RealAgentDispatch, type CompletedDispatchUsage } from '../src/state/liveAgentsMath';

export interface LiveAgentTick {
  open: RealAgentDispatch[];
  completed: CompletedDispatchUsage[];
}

export function createLiveAgentTracker(projectsRoot: string) {
  let currentFile: string | null = null;
  let currentOffset = 0;
  let currentOpen: RealAgentDispatch[] = [];

  return {
    async tick(): Promise<LiveAgentTick> {
      const activeFile = await findMostRecentSessionFile(projectsRoot);

      if (activeFile !== currentFile) {
        currentFile = activeFile;
        currentOffset = 0;
        currentOpen = [];
        if (!activeFile) return { open: currentOpen, completed: [] };
        const { lines, newOffset } = await readNewLines(activeFile, 0);
        currentOffset = newOffset;
        // This replays the whole file from byte 0 (a session switch, or first
        // tick after app start), so `completed` can include dispatches that
        // finished long before this moment -- not just ones that completed on
        // this tick. Harmless today (nothing treats `completed` as "just now"),
        // but a future caller shouldn't assume it means "newly completed".
        const completed: CompletedDispatchUsage[] = [];
        currentOpen = applyLinesToOpenDispatches(currentOpen, lines, completed);
        return { open: currentOpen, completed };
      }

      if (!currentFile) return { open: currentOpen, completed: [] };
      const { lines, newOffset } = await readNewLines(currentFile, currentOffset);
      if (lines.length === 0) return { open: currentOpen, completed: [] };
      currentOffset = newOffset;
      const completed: CompletedDispatchUsage[] = [];
      currentOpen = applyLinesToOpenDispatches(currentOpen, lines, completed);
      return { open: currentOpen, completed };
    },
  };
}
