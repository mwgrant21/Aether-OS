import { findMostRecentSessionFile } from './activeSessionFinder';
import { readNewLines } from './transcriptTailer';
import { applyLinesToOpenDispatches, type RealAgentDispatch } from '../src/state/liveAgentsMath';

export function createLiveAgentTracker(projectsRoot: string) {
  let currentFile: string | null = null;
  let currentOffset = 0;
  let currentOpen: RealAgentDispatch[] = [];

  return {
    async tick(): Promise<RealAgentDispatch[]> {
      const activeFile = await findMostRecentSessionFile(projectsRoot);

      if (activeFile !== currentFile) {
        currentFile = activeFile;
        currentOffset = 0;
        currentOpen = [];
        if (!activeFile) return currentOpen;
        const { lines, newOffset } = await readNewLines(activeFile, 0);
        currentOffset = newOffset;
        currentOpen = applyLinesToOpenDispatches(currentOpen, lines);
        return currentOpen;
      }

      if (!currentFile) return currentOpen;
      const { lines, newOffset } = await readNewLines(currentFile, currentOffset);
      if (lines.length === 0) return currentOpen;
      currentOffset = newOffset;
      currentOpen = applyLinesToOpenDispatches(currentOpen, lines);
      return currentOpen;
    },
  };
}
