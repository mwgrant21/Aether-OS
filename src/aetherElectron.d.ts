import type { RealUsageSnapshot, FleetSessionRow } from './state/types';
import type { RealAgentDispatch, CompletedDispatchUsage, RealActiveWork } from './state/liveAgentsMath';
import type { AttachmentInfo } from './components/files/attachmentsMath';
import type { Anomaly } from './shared/anomalyDetectors';
import type { OptimizeFinding, OptimizeSummary } from './shared/optimizeRules';
import type { GradeRow } from './shared/optimizeGrade';
import type { StatuslineSnapshot } from './shared/statuslinePayload';
import type { DiagnosticsSnapshot } from '../electron/collectorStore';
import type { MemoryRowUI, MemoryTombstoneUI } from '../electron/memoryStore';
import type { PermissionRequestUI, PostToolFlagRequestUI } from './state/types';
import type { PermissionDecision, PostToolFlagDecision } from '../electron/permissionServer';

export {};

declare global {
  interface Window {
    aetherElectron?: {
      app: {
        getVersion: () => Promise<string>;
      };
      pty: {
        start: (opts: { cols: number; rows: number }) => Promise<void>;
        write: (input: string) => void;
        resize: (cols: number, rows: number) => void;
        onData: (callback: (data: string) => void) => () => void;
      };
      usage: {
        onSnapshot: (callback: (snapshot: RealUsageSnapshot) => void) => () => void;
      };
      agents: {
        onSnapshot: (callback: (dispatches: RealAgentDispatch[]) => void) => () => void;
        onCompleted: (callback: (completed: CompletedDispatchUsage[]) => void) => () => void;
        onActiveWork: (callback: (work: RealActiveWork[]) => void) => () => void;
        onAnomalies: (callback: (anomalies: Anomaly[]) => void) => () => void;
        onCacheHitRatio: (callback: (ratio: number) => void) => () => void;
        onNotification: (callback: (payload: { reason: string }) => void) => () => void;
        onHeadline: (callback: (payload: { toolUseId: string; headline: string }) => void) => () => void;
        onNarration: (callback: (payload: { toolUseId: string; narration: string; severity: number }) => void) => () => void;
        setAutoHeadlines: (enabled: boolean) => void;
        setModelPolicyMode: (mode: 'Local' | 'API' | 'Off') => void;
        getModelSpend: () => Promise<{ monthTotalUsd: number; gate: 'ok' | 'degrade' | 'blocked' }>;
      };
      fleet: {
        onSnapshot: (callback: (rows: FleetSessionRow[] | null) => void) => () => void;
      };
      diagnostics: {
        onSnapshot: (callback: (snapshot: DiagnosticsSnapshot | null) => void) => () => void;
      };
      memory: {
        onSnapshot: (callback: (rows: MemoryRowUI[] | null) => void) => () => void;
        onTombstones: (callback: (rows: MemoryTombstoneUI[] | null) => void) => () => void;
      };
      optimize: {
        onFindings: (callback: (findings: OptimizeFinding[]) => void) => () => void;
        onSummary: (callback: (summary: OptimizeSummary) => void) => () => void;
        onBreakdown: (callback: (rows: GradeRow[]) => void) => () => void;
        targets: () => Promise<{ global: { path: string; exists: boolean }; project: { path: string; exists: boolean } | null }>;
        apply: (args: { findingId: string; target: 'global' | 'project' }) => Promise<{ ok: boolean; added?: boolean; alreadyPresent?: boolean; targetPath?: string; backupPath?: string | null; error?: string }>;
      };
      attachments: {
        list: () => Promise<AttachmentInfo[]>;
        add: () => Promise<string[]>;
        remove: (name: string) => Promise<void>;
        thumbnail: (name: string) => Promise<string | null>;
        open: (name: string) => Promise<void>;
      };
      statusline: {
        onSnapshot: (callback: (snapshot: StatuslineSnapshot) => void) => () => void;
        state: () => Promise<{
          status: 'installed' | 'installed-other' | 'not-installed' | 'unreadable';
          existingCommand: string | null;
          settingsPath: string;
          scriptPath: string;
        }>;
        currentSnapshot: () => Promise<StatuslineSnapshot | null>;
        install: () => Promise<{ ok: boolean; backupPath?: string | null; error?: string }>;
        uninstall: () => Promise<{ ok: boolean; backupPath?: string | null; error?: string }>;
      };
      permission: {
        onRequest: (callback: (request: PermissionRequestUI) => void) => () => void;
        respond: (requestId: string, decision: PermissionDecision) => Promise<void>;
      };
      postToolFlag: {
        onRequest: (callback: (request: PostToolFlagRequestUI) => void) => () => void;
        respond: (requestId: string, decision: PostToolFlagDecision) => Promise<void>;
      };
      presence: {
        onRecap: (callback: (recap: { entries: unknown[]; tokensBurned: number }) => void) => () => void;
      };
      chat: {
        send: (body: unknown) => Promise<{ reply: string } | { error: string }>;
        hasKey: () => Promise<boolean>;
      };
      window: {
        minimize: () => void;
        toggleMaximize: () => void;
        close: () => void;
        isMaximized: () => Promise<boolean>;
        onMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void;
      };
    };
  }
}
