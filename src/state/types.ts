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
// domain (tick.ts's random risk-event generator, the chat action-JSON
// pipeline's spawn/kill/throttle confirmations in actionExecutor.ts, and the
// Terminal's approvals/approve/deny commands in commands.ts) -- an entirely
// different axis from PermissionRequestUI, which gates a real, live Claude
// Code tool call. No file reviewed makes Approval redundant: tick.ts's
// generator is this app's deliberate ongoing "reactor simulation" narrative
// (same category as its burn-rate/sys-metrics randomness, per this project's
// own precedent of leaving fictional-simulation pieces additive rather than
// retrofitting them onto real data -- see PROGRESS.md's Files/Memory/Chat
// slices), and the chat/terminal paths are real, tested, still-used features
// built on top of it in later phases. See PROGRESS.md for the full write-up.
export interface Approval {
  id: number;
  agent: string;
  i: string;
  hue: string;
  action: string;
  detail: string;
  risk: 'HIGH' | 'MED' | 'LOW';
  // Phase 2b (chat action-JSON pipeline) — optional, so every pre-existing
  // (seed + tick.ts-generated) approval is unaffected. Set together only by
  // the chat feature's risky-verb path (see actionExecutor.ts).
  verb?: 'spawn' | 'kill' | 'throttle';
  targetAgentName?: string; // spawn: name of the agent to create; kill/throttle: name of the existing agent targeted
  channelId?: string; // originating chat channel id, so resolution can post a confirmation back to it
}

export interface ChatActionResult {
  channelId: string;
  text: string;
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
import type { PermissionRisk } from '../shared/permissionRisk';
import type { NotificationReason } from '../shared/alertSounds';
import type { RateSample } from '../components/reactor/reactorMath';

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

export type ProjectStatus = 'BUILDING' | 'REVIEW' | 'QUEUED' | 'SHIPPED';

export interface ProjectStub {
  name: string;
  status: ProjectStatus;
  pct: number;
  hue: string;
  crew: string[];
}

export interface Provider {
  name: string;
  connected: boolean;
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
  projects: ProjectStub[];
  memories: MemoryRow[];
  memoryTombstones: MemoryTombstone[];
  memoryScopeFilter: 'all' | 'shared' | string;
  memoryShowTombstones: boolean;
  providers: Provider[];
  routeDefault: string;
  operatorName: string;
  chatActionResults: ChatActionResult[];
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
  pendingPermissionRequest: PermissionRequestUI | null;
  pendingPostToolFlag: PostToolFlagRequestUI | null;
  lastNotification: { reason: NotificationReason; atMs: number } | null;
  recap: RecapPayload | null;
  dispatchHeadlines: Record<string, string>;
}

export type CommandResult = { kind: 'append'; lines: TermLine[]; patch?: Partial<AetherState> };
