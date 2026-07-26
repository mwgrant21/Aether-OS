import path from 'path';
import { findSessionFileCreatedAfter } from './activeSessionFinder';
import { readNewLines } from './transcriptTailer';
import { parseTranscriptLine, type TranscriptEvent } from './transcriptParser';
import { createEmptyHistory, updateHistory, type ToolCallHistory } from './toolCallHistory';
import { detectAnomalies, type Anomaly } from '../src/shared/anomalyDetectors';
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
  anomalies: Anomaly[];
  cacheHitRatio: number;
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
  let history: ToolCallHistory = createEmptyHistory();
  let cumulativeCacheRead = 0;
  let cumulativeInput = 0;

  function emptyTick(): LiveAgentTick {
    const cacheHitRatio =
      cumulativeInput + cumulativeCacheRead > 0 ? cumulativeCacheRead / (cumulativeInput + cumulativeCacheRead) : 0;
    return { open: currentOpen, completed: [], work: currentWork, anomalies: [], cacheHitRatio };
  }

  return {
    notifyPtySpawned(atMs: number): void {
      spawnedAtMs = atMs;
      pinnedFile = null;
      currentOffset = 0;
      currentOpen = [];
      currentWork = [];
      history = createEmptyHistory();
      cumulativeCacheRead = 0;
      cumulativeInput = 0;
    },

    async tick(): Promise<LiveAgentTick> {
      if (!pinnedFile) {
        if (spawnedAtMs === null) return emptyTick();
        const found = await findSessionFileCreatedAfter(sessionDir, spawnedAtMs);
        if (!found) return emptyTick();
        pinnedFile = found;
        currentOffset = 0;
        currentOpen = [];
        currentWork = [];
        // history/cumulativeCacheRead/cumulativeInput are intentionally NOT reset
        // here: this branch only runs once per notifyPtySpawned (while pinnedFile
        // is still null), before any lines have been tailed, so those three are
        // already at their notifyPtySpawned-reset zero values and nothing has
        // touched them yet.
      }

      const { lines, newOffset } = await readNewLines(pinnedFile, currentOffset);
      if (lines.length === 0) return emptyTick();
      currentOffset = newOffset;

      const events: TranscriptEvent[] = lines
        .map(parseTranscriptLine)
        .filter((e): e is TranscriptEvent => e !== null);

      const completed: CompletedDispatchUsage[] = [];
      currentOpen = applyLinesToOpenDispatches(currentOpen, events, completed);
      currentWork = applyLinesToOpenWork(currentWork, events);
      history = updateHistory(history, events, Date.now());

      for (const event of events) {
        if (event.usage) {
          cumulativeCacheRead += event.usage.cacheReadInputTokens;
          cumulativeInput += event.usage.inputTokens;
        }
      }

      const cacheHitRatio =
        cumulativeInput + cumulativeCacheRead > 0 ? cumulativeCacheRead / (cumulativeInput + cumulativeCacheRead) : 0;

      // No existing running-total token source is passed into tick() from
      // main.ts's tickAndPushAgents -- scanAndPushUsage's burn-rate pipeline
      // scans ALL projects on a separate 60s interval and isn't scoped to
      // this tracker's pinned session file. cumulativeInput is used as the
      // best available proxy for "tokens burned in this tracked session" per
      // the plan's documented fallback.
      const tokensUsedForBurn = cumulativeInput;
      const anomalies = detectAnomalies(history, currentWork, tokensUsedForBurn, Date.now());

      return { open: currentOpen, completed, work: currentWork, anomalies, cacheHitRatio };
    },
  };
}
