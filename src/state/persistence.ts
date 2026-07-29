import type { AetherState } from './types';

const STORAGE_KEY = 'aetheros-v1';

/** Keys deliberately excluded from persistence, with the reason each is excluded.
 *  A rehydrated value for any of these would be actively misleading rather than merely stale.
 *
 *  See persistence.test.ts's header comment for why this list (and the coverage test that
 *  checks it) exists at all. */
export const PERSISTENCE_EXCLUSIONS: Partial<Record<keyof AetherState, string>> = {
  used: 'a live per-session token counter recomputed every tick from the burn simulation; a persisted value would carry a stale total into a new session and misstate current usage',
  rate: 'a live burn rate overwritten by every real-usage snapshot (SET_REAL_USAGE) and every tick; a persisted number would show a stale/wrong rate until the first real snapshot lands',
  ctxUsed: "the current terminal session's context-window usage, replaced by the first real-usage snapshot; a new session starts with a fresh context window, so a persisted value would misrepresent it",
  weekRaw: 'a decorative random-walk mutated every tick by the simulation (tick.ts) with no real signal; persisting it would preserve fake noise as if it were real historical data',
  commandsRun: 'a per-session counter (shown as "Commands run" in the session metrics row); persisting it would carry a stale count into a new session and misrepresent commands run in the current one',
  sessionStartedAt: "the timestamp the current session began, used to compute the footer's Session start/Uptime; persisting it would show a previous session's start time as if it belonged to this session",
  selectedRealAgent: 'keyed on a toolUseId that will not exist in a new session',
  notifOpen: 'a transient dropdown open/closed UI flag; restoring "open" would pop the notifications panel open on launch with no user action prompting it',
  apprOpen: 'a transient dropdown open/closed UI flag; restoring "open" would pop the approvals panel open on launch with no user action prompting it',
  alarmLevel: 'derived every tick from rate vs. cfg.alarm (tick.ts); a persisted value could show a stale CRIT/WARN banner that no longer reflects the current burn rate',
  sys: 'simulated CPU/MEM/NET/DISK metrics randomly mutated every tick; no real signal, same category as weekRaw',
  logs: 'stale lines would fake a live STREAMING state after restart',
  realUsage: 'the live real-usage snapshot pushed over IPC (SET_REAL_USAGE); persisting it would show old usage/burn numbers as current until the next real snapshot arrives',
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
  pendingPermissionRequest: "an in-flight approval prompt tied to a live pending Promise held in main.ts's resolver map; a rehydrated value after restart would show a prompt with no resolver left to answer it",
  pendingPostToolFlag: "an in-flight flag-review prompt tied to a live pending Promise held in main.ts's pendingPostToolFlagResolvers map; a rehydrated value after restart would show a prompt with no resolver left to answer it -- same reasoning as pendingPermissionRequest",
  lastNotification: 'a live IPC-pushed Notification-hook event used only to trigger a one-shot sound in useAlertSounds; a persisted value would replay a stale sound cue on the next launch',
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
      agents: state.agents,
      idleList: state.idleList,
      notifs: state.notifs,
      unread: state.unread,
      cmdHist: state.cmdHist,
      approvals: state.approvals,
      apprSeq: state.apprSeq,
      projects: state.projects,
      providers: state.providers,
      routeDefault: state.routeDefault,
      operatorName: state.operatorName,
      selected: state.selected,
      selectedProject: state.selectedProject,
      selectedMemory: state.selectedMemory,
      memories: state.memories,
      memSeq: state.memSeq,
      chatActionResults: state.chatActionResults,
      recentCompletedDispatches: state.recentCompletedDispatches,
      dispatchChannels: state.dispatchChannels,
      dispatchUsage: state.dispatchUsage,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slice));
  } catch {
    // localStorage unavailable (private mode, quota) — persistence is best-effort
  }
}
