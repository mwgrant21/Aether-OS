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

import type { RealAgentDispatch } from './liveAgentsMath';

export interface RealUsageSnapshot {
  weeklyTokens: number[];
  usedThisMonth: number;
  burnRatePerMin: number;
  weekOverWeekPct: number | null;
  lastScanAt: string | null;
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

export interface MemoryStub {
  id: number;
  name: string;
  content: string;
  source: string;
  ts: string;
  pinned: boolean;
  strength: number;
}

export type OpMode = 'PLAN' | 'EDITS' | 'AUTO';
export type RendererMode = 'classic' | 'volumetric' | 'warp';
export type ThemeName = 'cyan' | 'blue' | 'teal' | 'violet' | 'amber' | 'red';
export type AlarmLevel = 'ok' | 'warn' | 'crit';

export interface Cfg {
  opMode: OpMode;
  renderer: RendererMode;
  pulseMode: 'live' | 'ambient';
  theme: ThemeName;
  glow: number;
  glowFx: boolean;
  capM: number;
  alarm: number;
  autoThrottle: boolean;
  sound: boolean;
}

export interface AetherState {
  used: number;
  rate: number;
  ctxUsed: number;
  weekRaw: number[];
  commandsRun: number;
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
  memories: MemoryStub[];
  memSeq: number;
  providers: Provider[];
  routeDefault: string;
  operatorName: string;
  chatActionResults: ChatActionResult[];
  realUsage: RealUsageSnapshot;
  realAgents: RealAgentDispatch[];
}

export type CommandResult = { kind: 'append'; lines: TermLine[]; patch?: Partial<AetherState> };
