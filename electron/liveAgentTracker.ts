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
  type TrackedOutcome,
} from '../src/state/liveAgentsMath';
import { cwdToProjectDirName } from '../src/state/projectDirName';

export interface LiveAgentTick {
  open: RealAgentDispatch[];
  completed: CompletedDispatchUsage[];
  /** Parsed outcome per entry in `completed`, keyed by toolUseId. */
  outcomes: ReadonlyMap<string, TrackedOutcome>;
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
// Filesystem seams, injectable so tests can hold an await open and land a
// respawn inside it deterministically. Production uses the real ones.
export interface LiveAgentTrackerFs {
  findSessionFile?: (dir: string, sinceMs: number) => Promise<string | null>;
  readLines?: (file: string, offset: number) => Promise<{ lines: string[]; newOffset: number }>;
}

export function createLiveAgentTracker(homeDir: string, fs: LiveAgentTrackerFs = {}) {
  const sessionDir = path.join(homeDir, '.claude', 'projects', cwdToProjectDirName(homeDir));
  const findSessionFile = fs.findSessionFile ?? findSessionFileCreatedAfter;
  const readLines = fs.readLines ?? readNewLines;

  let spawnedAtMs: number | null = null;
  let pinnedFile: string | null = null;
  let currentOffset = 0;
  let currentOpen: RealAgentDispatch[] = [];
  let currentWork: RealActiveWork[] = [];
  let history: ToolCallHistory = createEmptyHistory();
  let cumulativeCacheRead = 0;
  let cumulativeInput = 0;
  // Bumped by every notifyPtySpawned. A tick captures it at start and re-checks
  // it after EVERY await: a respawn that lands mid-tick makes that tick stale,
  // and a stale tick returns emptyTick() and writes NO state (no pinnedFile,
  // offset, open/work lists, history or counters). Otherwise it would feed the
  // old file's events into the new session's history and counters, or pin the
  // previous session's file found with the old spawnedAtMs.
  let generation = 0;

  function emptyTick(): LiveAgentTick {
    const cacheHitRatio =
      cumulativeInput + cumulativeCacheRead > 0 ? cumulativeCacheRead / (cumulativeInput + cumulativeCacheRead) : 0;
    // Re-run anomaly detection even on idle ticks (no new transcript lines).
    // Without this, every zero-new-lines tick wiped anomalies to [], which made
    // detectStalledPermission (age-based, fires precisely when there ARE no new
    // lines) unreachable, and caused Grid rings/reactor anomaly state to flicker
    // with transcript activity instead of tracking real anomaly state.
    const anomalies = detectAnomalies(history, currentWork, cumulativeInput, Date.now());
    return { open: currentOpen, completed: [], outcomes: new Map(), work: currentWork, anomalies, cacheHitRatio };
  }

  // Serialized: main.ts calls tick() from the periodic agent tick AND from
  // onPostToolUse. Overlapping runs would both read from the same offset
  // (one completion handled twice: two narrations, two baseline samples,
  // two agents:completed) or write back a smaller offset. Chaining makes
  // concurrent callers run one after another, each getting its own result,
  // so the offset only moves forward.
  let tickChain: Promise<unknown> = Promise.resolve();

  async function runTick(): Promise<LiveAgentTick> {
    const gen = generation;
    if (!pinnedFile) {
      if (spawnedAtMs === null) return emptyTick();
      const found = await findSessionFile(sessionDir, spawnedAtMs);
      if (gen !== generation) return emptyTick();
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

    const { lines, newOffset } = await readLines(pinnedFile, currentOffset);
    if (gen !== generation) return emptyTick();
    if (lines.length === 0) return emptyTick();
    currentOffset = newOffset;

    const events: TranscriptEvent[] = lines
      .map(parseTranscriptLine)
      .filter((e): e is TranscriptEvent => e !== null);

    const completed: CompletedDispatchUsage[] = [];
    const outcomes = new Map<string, TrackedOutcome>();
    currentOpen = applyLinesToOpenDispatches(currentOpen, events, completed, outcomes);
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

    return { open: currentOpen, completed, outcomes, work: currentWork, anomalies, cacheHitRatio };
  }

  return {
    getPinnedSessionId(): string | null {
      return pinnedFile ? path.basename(pinnedFile, '.jsonl') : null;
    },

    notifyPtySpawned(atMs: number): void {
      generation += 1;
      spawnedAtMs = atMs;
      pinnedFile = null;
      currentOffset = 0;
      currentOpen = [];
      currentWork = [];
      history = createEmptyHistory();
      cumulativeCacheRead = 0;
      cumulativeInput = 0;
    },

    tick(): Promise<LiveAgentTick> {
      const next = tickChain.then(runTick, runTick);
      tickChain = next.catch(() => undefined);
      return next;
    },
  };
}
