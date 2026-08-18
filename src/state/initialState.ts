import type { AetherState } from './types';

export const initialState: AetherState = {
  used: 24391,
  rate: 92000,
  momentum: 92000,
  ctxUsed: 78432,
  commandsRun: 163,
  sessionStartedAt: new Date().toISOString(),
  activeTab: 'Terminal',
  selectedProject: null,
  selectedMemory: null,
  selectedRealAgent: null,
  cmdHist: [],
  notifs: [],
  unread: 0,
  notifOpen: false,
  alarmLevel: 'ok',
  apprOpen: false,
  cfg: {
    opMode: 'EDITS',
    renderer: 'classic',
    pulseMode: 'live',
    theme: 'cyan',
    themeMode: 'dark',
    glow: 70,
    glowFx: true,
    showReactorLegend: false,
    capM: 2.0,
    alarm: 120,
    autoThrottle: true,
    permissionAutoAllow: 'LOW_MED',
    sound: false,
    autoCreateDispatchChannels: false,
    densityLevel: 'normal',
    // Was defaulted off (briefly) as a belt-and-suspenders guard against
    // background billing -- this feature used to make a periodic, unprompted
    // Haiku call every ~15s per active agent. It now costs nothing at all
    // (see headlineGenerator.ts's formatHeadline(), a local string formatter
    // with no model call), so defaulting it back on restores the live
    // roster feel it was meant to have, at zero cost. See docs/roadmap.md's
    // Stage 11.5 addendum for the full "Aether should not cost a user
    // money" rationale behind this and the July 31st overrun it followed.
    autoHeadlines: true,
    narrationVerbosity: 'full',
  },
  logs: [],
  memories: [],
  memoryTombstones: [],
  memoryScopeFilter: 'all',
  memoryShowTombstones: false,
  // False until main.ts actually pushes `pty:alive`. No pty exists at launch:
  // PtyTerminal.tsx spawns one only when the Terminal tab mounts, so a launch
  // restoring any other persisted activeTab -- or a renderer running outside
  // Electron -- has no terminal at all. Defaulting true made Uplinks and the
  // dashboard report ONLINE indefinitely in exactly those cases.
  terminalAlive: false,
  // Same reasoning as terminalAlive: nothing spawns the Codex pty until the
  // Codex terminal view actually mounts.
  codexTerminalAlive: false,
  terminalIdle: false,
  codexTerminalIdle: false,
  operatorName: 'Operator',
  realUsage: {
    weeklyTokens: [0, 0, 0, 0, 0, 0, 0],
    dailyTokens: new Array(24).fill(0),
    liveTokens: new Array(12).fill(0),
    usedThisMonth: 0,
    burnRatePerMin: 0,
    weekOverWeekPct: null,
    lastScanAt: null,
    ctxUsed: 78432,
  },
  rateHistory: [],
  realAgents: [],
  activeWork: [],
  anomalies: [],
  cacheHitRatio: 0,
  optimizeFindings: [],
  optimizeSummary: { totalPerWeek: 0, grade: 'A' as const },
  optimizeBreakdown: [],
  recentCompletedDispatches: [],
  dispatchChannels: [],
  dispatchUsage: {},
  statusline: null,
  planUsageTier: null,
  fleet: null,
  diagnostics: null,
  ledger: null,
  projectsSnapshot: null,
  pendingPermissionRequest: null,
  pendingPostToolFlag: null,
  lastNotification: null,
  recap: null,
  dispatchHeadlines: {},
  dispatchNarrations: {},
  narrationMessages: {},
  narrationBudgets: {},
  crossEngineCfg: { enabled: false, provider: 'codex-chatgpt' },
  codexTerminalCfg: { enabled: false },
};
