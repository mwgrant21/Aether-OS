import type { RealUsageSnapshot } from './state/types';
import type { RealAgentDispatch, CompletedDispatchUsage, RealActiveWork } from './state/liveAgentsMath';
import type { AttachmentInfo } from './components/files/attachmentsMath';
import type { Anomaly } from './shared/anomalyDetectors';
import type { OptimizeFinding, OptimizeSummary } from './shared/optimizeRules';
import type { GradeRow } from './shared/optimizeGrade';

export {};

declare global {
  interface Window {
    aetherElectron?: {
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
