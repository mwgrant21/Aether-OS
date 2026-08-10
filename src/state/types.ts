export interface AgentFile {
  s: string;
  n: string;
  c: string;
}

export interface Agent {
  i: string;
  name: string;
  task: string;
  pct: number;
  hue: string;
  eta: string;
  share: number;
  hist: number[];
  files: AgentFile[];
  paused?: boolean;
}

export interface IdleAgent {
  name: string;
  last: string;
}

export interface SysMetric {
  label: string;
  val: number;
  hist: number[];
}

// Task 8 (Stage 6, 2026-07-28) investigated whether this type/ADD_APPROVAL/
// state.approvals is dead code now that a real PermissionRequest/PostToolUse
// approval loop exists (see PermissionRequestUI/PostToolFlagRequestUI below).
// Disposition: KEEP AS-IS -- this is a different, still-real system, not a
// redundant one. Approval governs the fictional/simulated "AETHER OS" Agent
// domain (tick.ts's random risk-event generator and the Terminal's
// approvals/approve/deny commands in commands.ts) -- an entirely different
// axis from PermissionRequestUI, which gates a real, live Claude Code tool
// call. No file reviewed makes Approval redundant: tick.ts's generator is
// this app's deliberate ongoing "reactor simulation" narrative (same
// category as its burn-rate/sys-metrics randomness, per this project's own
// precedent of leaving fictional-simulation pieces additive rather than
// retrofitting them onto real data -- see PROGRESS.md's Files/Memory/Chat
// slices), and the Terminal path is a real, tested, still-used feature built
// on top of it. See PROGRESS.md for the full write-up. (The chat feature
// also used to build on this system via actionExecutor.ts's spawn/kill/
// throttle confirmations, feeding ADD_APPROVAL from model-emitted action
// JSON -- removed in the API teardown, Stage 13.5, since a genuine model
// reply was the only producer on that path; see verb/targetAgentName/
// channelId below.)
export interface Approval {
  id: number;
  agent: string;
  i: string;
  hue: string;
  action: string;
  detail: string;
  risk: 'HIGH' | 'MED' | 'LOW';
  // Phase 2b (chat action-JSON pipeline) — optional, so every pre-existing
  // (seed + tick.ts-generated) approval is unaffected. Were set together only
  // by the chat feature's risky-verb path (actionExecutor.ts, deleted in the
  // API teardown, Stage 13.5) -- kept here as dead-but-harmless optional
  // fields rather than pulled, since Approval itself is still real, live
  // machinery for tick.ts/commands.ts.
  verb?: 'spawn' | 'kill' | 'throttle';
  targetAgentName?: string; // spawn: name of the agent to create; kill/throttle: name of the existing agent targeted
  channelId?: string; // originating chat channel id, so resolution can post a confirmation back to it
}

export interface Notif {
  t: string;
  m: string;
  c: string;
}

export interface LogEntry {
  t: string;
  m: string;
  c: string;
}

export interface TermLine {
  t: string;
  c: string;
}

import type { RealAgentDispatch, RealActiveWork } from './liveAgentsMath';
import type { Anomaly } from '../shared/anomalyDetectors';
import type { OptimizeFinding, OptimizeSummary } from '../shared/optimizeRules';
import type { GradeRow } from '../shared/optimizeGrade';
import type { StatuslineSnapshot } from '../shared/statuslinePayload';
import type { DiagnosticsSnapshot } from '../../electron/collectorStore';
import type { LedgerSnapshot } from '../shared/ledgerMath';
import type { ProjectsSnapshot } from '../shared/projectsSnapshot';
import type { PermissionRisk } from '../shared/permissionRisk';
import type { NotificationReason } from '../shared/alertSounds';
import type { RateSample } from '../components/reactor/reactorMath';
import type { NarrationVerbosity } from '../shared/narrationVerbosity';
import type { VoiceRole } from '../shared/agentVoiceRoles';
import type { Severity } from '../shared/voicePacks';
import type { InterruptionBudgetState } from '../shared/interruptionBudget';

// A single rendered voice-pack line appended to a Comms channel's feed
// (Stage 14 Task 5, narrationFeed.ts). Distinct from `dispatchNarrations`
// above: that's the model-written free-text line shown on the roster card;
// this is the deterministic, voice-pack-rendered line shown in Comms,
// derived from real events (dispatch completion, anomalies, permission/flag
// requests) via detectEventKind + renderNarration. Contains no transcript
// payload -- only a rendered string derived from event metadata.
export interface NarrationMessage {
  id: string;
  channelId: string;
  role: VoiceRole;
  voiceName: string;
  text: string;
  severity: Severity;
  atMs: number;
  // Whether interruptionBudget's ranking allowed this line to raise the
  // channel's unread badge (spec §8). Lines that lose the ranking still
  // appear in-thread -- see narrationFeed.ts's rankForInterruption.
  interrupts: boolean;
}

// Not related to `Approval` (the chat-pipeline/tick-simulation approval
// queue) despite similar approve/deny language -- see that interface's
// comment for the disambiguation. PermissionRequestUI/PostToolFlagRequestUI
// below gate real Claude Code tool-call permissions via IPC.
export interface PermissionRequestUI {
  requestId: string;
  toolName: string;
  toolInput: unknown;
  risk: PermissionRisk;
  editableField: { label: string; value: string } | null;
}

export interface PostToolFlagRequestUI {
  requestId: string;
  toolUseId: string;
  toolName: string;
  anomalyKind: Anomaly['kind'];
  detail: string;
}

export interface RecapPayload {
  entries: { kind: 'dispatchCompleted' | 'anomalyDetected' | 'anomalyCleared'; detail: string; atMs: number }[];
  tokensBurned: number;
}

export interface RealUsageSnapshot {
  weeklyTokens: number[];
  dailyTokens: number[];
  liveTokens: number[];
  usedThisMonth: number;
  burnRatePerMin: number;
  weekOverWeekPct: number | null;
  lastScanAt: string | null;
  ctxUsed: number;
}

export interface FleetSessionRow {
  sessionId: string;
  pid: number | null;
  projectName: string;
  kind: string;
  status: string;
  name: string;
  startedAtMs: number;
}

export type MemoryScope = 'shared' | 'private';
export type MemoryKind = 'decision' | 'preference' | 'overrule' | 'habit' | 'revision';
export type MemoryStatus = 'open' | 'moving' | 'settled';

export interface MemoryRow {
  id: number;
  scope: MemoryScope;
  ownerAgent: string | null;
  kind: MemoryKind;
  content: string;
  status: MemoryStatus | null;
  salience: number;
  subject: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  referenceCount: number;
}

export interface MemoryTombstone {
  id: number;
  scope: MemoryScope;
  ownerAgent: string | null;
  content: string;
  deletedAtMs: number;
  cause: 'superseded' | 'operator' | 'invalidated';
  supersededBy: number | null;
}

export interface DispatchUsage {
  tokens: number;
  toolUses: number;
  durationMs: number;
}

export interface DispatchChannelStub {
  toolUseId: string;
  subagentType: string;
  description: string;
  prompt: string;
  model: string | null;
  startedAt: string;
  createdAt: string;
}

export type OpMode = 'PLAN' | 'EDITS' | 'AUTO';
export type RendererMode = 'classic' | 'volumetric' | 'warp' | 'storm';
export type ThemeName = 'cyan' | 'blue' | 'teal' | 'violet' | 'amber' | 'red';
export type AlarmLevel = 'ok' | 'warn' | 'crit';

export interface Cfg {
  opMode: OpMode;
  renderer: RendererMode;
  pulseMode: 'live' | 'ambient';
  theme: ThemeName;
  themeMode: 'dark' | 'light';
  glow: number;
  glowFx: boolean;
  showReactorLegend: boolean;
  capM: number;
  alarm: number;
  autoThrottle: boolean;
  sound: boolean;
  autoCreateDispatchChannels: boolean;
  densityLevel: 'normal' | 'verbose' | 'summary';
  autoHeadlines: boolean;
  narrationVerbosity: NarrationVerbosity;
}

export interface AetherState {
  used: number;
  rate: number;
  momentum: number;
  ctxUsed: number;
  weekRaw: number[];
  commandsRun: number;
  sessionStartedAt: string;
  activeTab: string;
  selected: string | null;
  selectedProject: string | null;
  selectedMemory: string | null;
  selectedRealAgent: string | null;
  cmdHist: string[];
  notifs: Notif[];
  unread: number;
  notifOpen: boolean;
  alarmLevel: AlarmLevel;
  apprOpen: boolean;
  approvals: Approval[];
  apprSeq: number;
  cfg: Cfg;
  agents: Agent[];
  idleList: IdleAgent[];
  sys: SysMetric[];
  logs: LogEntry[];
  memories: MemoryRow[];
  memoryTombstones: MemoryTombstone[];
  memoryScopeFilter: 'all' | 'shared' | string;
  memoryShowTombstones: boolean;
  // True whenever the embedded terminal's pty process is alive. Set true at
  // launch (the pty auto-starts, per PtyTerminal.tsx's module-level
  // getOrCreateHost) and flipped false by useTerminalAliveSync when
  // pty:exit fires (electron/main.ts's ptyProcess.onExit handler). There is
  // no "reconnect" action -- the app has exactly one embedded terminal, not
  // a connection you can retry from the Uplinks view.
  terminalAlive: boolean;
  // Same pattern as terminalAlive, but for the independent Codex pty
  // (electron/codexPtyManager.ts). No pty exists at launch -- driven
  // entirely by useCodexTerminalAliveSync's codexPty:alive/codexPty:exit
  // event handling once the Codex terminal view mounts.
  codexTerminalAlive: boolean;
  // True whenever the embedded terminal's pty has produced no output for
  // IDLE_THRESHOLD_MS (useTerminalIdleSync.ts) -- an activity-silence proxy
  // for "probably awaiting input", not a literal one (a silent long-running
  // command also reads as idle). Drives the sidebar's pulsing nav-dot when
  // this tab isn't the active one (see Sidebar.tsx). Independent of
  // terminalAlive: a dead pty is never idle in this sense, it's just dead.
  terminalIdle: boolean;
  // Same pattern as terminalIdle, but for the independent Codex pty.
  codexTerminalIdle: boolean;
  operatorName: string;
  realUsage: RealUsageSnapshot;
  rateHistory: RateSample[];
  realAgents: RealAgentDispatch[];
  recentCompletedDispatches: RealAgentDispatch[];
  dispatchChannels: DispatchChannelStub[];
  dispatchUsage: Record<string, DispatchUsage>;
  activeWork: RealActiveWork[];
  anomalies: Anomaly[];
  cacheHitRatio: number;
  optimizeFindings: OptimizeFinding[];
  optimizeSummary: OptimizeSummary;
  optimizeBreakdown: GradeRow[];
  statusline: StatuslineSnapshot | null;
  fleet: FleetSessionRow[] | null;
  diagnostics: DiagnosticsSnapshot | null;
  ledger: LedgerSnapshot | null;
  projectsSnapshot: ProjectsSnapshot | null;
  pendingPermissionRequest: PermissionRequestUI | null;
  pendingPostToolFlag: PostToolFlagRequestUI | null;
  lastNotification: { reason: NotificationReason; atMs: number } | null;
  recap: RecapPayload | null;
  dispatchHeadlines: Record<string, string>;
  dispatchNarrations: Record<string, { narration: string; severity: number }>;
  narrationMessages: Record<string, NarrationMessage[]>;
  narrationBudgets: Record<string, InterruptionBudgetState>;
  crossEngineCfg: { enabled: boolean; provider: 'codex-chatgpt' };
  // User-intent config for the independent Codex terminal (Task 4's
  // CodexTerminalView/PtyCodexTerminal) -- default-off. Unlike
  // codexTerminalAlive above (a live signal recomputed every launch and
  // excluded from persistence), this is a deliberate operator choice and
  // must persist across restarts, same as crossEngineCfg.
  codexTerminalCfg: { enabled: boolean };
}

export type CommandResult = { kind: 'append'; lines: TermLine[]; patch?: Partial<AetherState> };
