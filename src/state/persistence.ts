import type { AetherState } from './types';

const STORAGE_KEY = 'aetheros-v1';

/** Keys deliberately excluded from persistence, with the reason each is excluded.
 *  A rehydrated value for any of these would be actively misleading rather than merely stale.
 *
 *  See persistence.test.ts's header comment for why this list (and the coverage test that
 *  checks it) exists at all. */
export const PERSISTENCE_EXCLUSIONS: Partial<Record<keyof AetherState, string>> = {
  used: 'a live per-session token counter recomputed every tick from the burn simulation; a persisted value would carry a stale total into a new session and misstate current usage',
  rate: 'a live burn rate overwritten by every real-usage snapshot (SET_REAL_USAGE); a persisted number would show a stale/wrong rate until the first real snapshot lands',
  momentum: 'a live pulse-momentum value overwritten by every real-usage snapshot (SET_REAL_USAGE); a persisted number would show a stale/wrong momentum reading until the first real snapshot lands',
  ctxUsed: "the current terminal session's context-window usage, replaced by the first real-usage snapshot; a new session starts with a fresh context window, so a persisted value would misrepresent it",
  commandsRun: 'a per-session counter (shown as "Commands run" in the session metrics row); persisting it would carry a stale count into a new session and misrepresent commands run in the current one',
  sessionStartedAt: "the timestamp the current session began, used to compute the footer's Session start/Uptime; persisting it would show a previous session's start time as if it belonged to this session",
  selectedRealAgent: 'keyed on a toolUseId that will not exist in a new session',
  notifOpen: 'a transient dropdown open/closed UI flag; restoring "open" would pop the notifications panel open on launch with no user action prompting it',
  apprOpen: 'a transient dropdown open/closed UI flag; restoring "open" would pop the approvals panel open on launch with no user action prompting it',
  alarmLevel: 'derived every tick from the real rate-limit window usage in state.statusline (tick.ts); a persisted value could show a stale CRIT/WARN banner that no longer reflects current rate-limit pressure',
  logs: 'stale lines would fake a live STREAMING state after restart',
  realUsage: 'the live real-usage snapshot pushed over IPC (SET_REAL_USAGE); persisting it would show old usage/burn numbers as current until the next real snapshot arrives',
  rateHistory: 'a live rolling window of real burn-rate samples feeding computeMomentum; a persisted value would seed a new session\'s Momentum reading with a previous session\'s trend',
  realAgents: 'a live snapshot of currently-open dispatches tailed from the transcript; after a restart these dispatches may no longer be running, so a stale value would show phantom active work',
  activeWork: 'a live IPC push of in-flight tool activity for the current session; a stale value would show phantom in-progress work after restart',
  anomalies: 'live-detected anomalies pushed over IPC from the current transcript tail; a stale anomaly would be reported as still-active long after the underlying condition resolved',
  cacheHitRatio: "a live ratio computed from the current session's tool-call history ring buffer; meaningless carried into a new session that starts with an empty history",
  optimizeFindings: 'recomputed live by useOptimizeSync from current real usage/agents data; a stale finding could recommend a fix for a condition that no longer exists',
  optimizeSummary: 'derived alongside optimizeFindings from live data on every sync -- not a fact to store',
  optimizeBreakdown: 'derived alongside optimizeFindings from live data on every sync -- not a fact to store',
  statusline: 'a rehydrated stale snapshot would show a fresh-looking rate-limit percentage from a previous session -- the same class of dishonesty the logs exclusion prevents',
  fleet: 'a live external-process snapshot of other claude sessions on the machine, stale the instant it is written to disk -- same reasoning as the logs exclusion',
  diagnostics: 'a live collector-sourced snapshot of tool calls/dispatches/anomalies over the last 24h, stale the instant it is written to disk -- same reasoning as the fleet exclusion',
  ledger: 'cost aggregates recomputed in main from the current transcript scan on every tick; a rehydrated value would render yesterday\'s spend under a "today" heading, which is the exact zero-versus-unknown confusion the Ledger exists to avoid',
  projectsSnapshot: 'per-project cost aggregates recomputed in main from the current transcript scan on every tick; a rehydrated value would show a previous machine-state\'s costs as current, the same reason `ledger` is excluded',
  pendingPermissionRequest: "an in-flight approval prompt tied to a live pending Promise held in main.ts's resolver map; a rehydrated value after restart would show a prompt with no resolver left to answer it",
  pendingPostToolFlag: "an in-flight flag-review prompt tied to a live pending Promise held in main.ts's pendingPostToolFlagResolvers map; a rehydrated value after restart would show a prompt with no resolver left to answer it -- same reasoning as pendingPermissionRequest",
  lastNotification: 'a live IPC-pushed Notification-hook event used only to trigger a one-shot sound in useAlertSounds; a persisted value would replay a stale sound cue on the next launch',
  recap: 'an in-memory-only "since you last looked" summary pushed once on refocus; persisting it would show a stale recap from a previous session on next launch, and this stage deliberately scopes recap to in-memory only',
  dispatchHeadlines: 'model-written headlines keyed to live toolUseIds from the current session; a persisted value would attach a stale headline to a toolUseId that no longer exists after restart',
  dispatchNarrations: 'model-written narrations keyed to live toolUseIds from the current session; a persisted value would attach a stale narration to a toolUseId that no longer exists after restart -- same reasoning as dispatchHeadlines',
  narrationMessages: 'voice-pack narration lines derived from live events (dispatch completion, anomalies, permission/flag requests) keyed by channel; session-scoped by design, same reasoning as dispatchNarrations -- a persisted dispatch-channel line would reference a toolUseId gone after restart, and a persisted AETHER/STEWARD line would misreport fleet state (anomalies, pending requests) that no longer holds',
  narrationBudgets: "interruptionBudget.ts's per-channel InterruptionBudgetState (last-volunteered timestamp); rehydrating it would apply a stale cooldown window computed against a previous session's clock, incorrectly suppressing or allowing the next channel's unread-badge interrupt",
  memories: 'a live collector-sourced snapshot read from memory.db on every poll (SET_MEMORIES); same reasoning as realAgents/realUsage -- a persisted value would show stale memory rows as current until the next real snapshot arrives',
  memoryTombstones: 'a live collector-sourced snapshot read from memory.db on every poll (SET_MEMORY_TOMBSTONES); same reasoning as memories',
  terminalAlive: "recomputed live -- starts false at every launch (no pty exists until the Terminal tab mounts) and is driven only by this session's own pty:alive/pty:exit events via useTerminalAliveSync; a persisted value would report a previous session's terminal state as this session's, same reasoning as ledger/projectsSnapshot",
  codexTerminalAlive: "recomputed live -- starts false at every launch (no pty exists until the Codex view mounts) and is driven only by this session's own codexPty:alive/codexPty:exit events via useCodexTerminalAliveSync, same reasoning as terminalAlive",
  terminalIdle: "recomputed live -- derived from this session's own pty:data stream via useTerminalIdleSync (3s of silence = idle); a persisted value would show a stale idle/active state from a previous session with no pty behind it",
  codexTerminalIdle: "recomputed live -- derived from this session's own codexPty:data stream via useCodexTerminalIdleSync, same reasoning as terminalIdle",
};

export function loadPersisted(): Partial<AetherState> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<AetherState>;
  } catch {
    return null;
  }
}

export function savePersisted(state: AetherState): void {
  try {
    const slice: Partial<AetherState> = {
      cfg: state.cfg,
      activeTab: state.activeTab,
      notifs: state.notifs,
      unread: state.unread,
      cmdHist: state.cmdHist,
      operatorName: state.operatorName,
      selectedProject: state.selectedProject,
      selectedMemory: state.selectedMemory,
      memoryScopeFilter: state.memoryScopeFilter,
      memoryShowTombstones: state.memoryShowTombstones,
      recentCompletedDispatches: state.recentCompletedDispatches,
      dispatchChannels: state.dispatchChannels,
      dispatchUsage: state.dispatchUsage,
      crossEngineCfg: state.crossEngineCfg,
      codexTerminalCfg: state.codexTerminalCfg,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slice));
  } catch {
    // localStorage unavailable (private mode, quota) — persistence is best-effort
  }
}
