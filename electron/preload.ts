import { contextBridge, ipcRenderer } from 'electron';
import type { RealUsageSnapshot, FleetSessionRow } from '../src/state/types';
import type { RealAgentDispatch, CompletedDispatchUsage, RealActiveWork } from '../src/state/liveAgentsMath';
import type { AttachmentInfo } from '../src/components/files/attachmentsMath';
import type { Anomaly } from '../src/shared/anomalyDetectors';
import type { OptimizeFinding, OptimizeSummary } from '../src/shared/optimizeRules';
import type { GradeRow } from '../src/shared/optimizeGrade';
import type { StatuslineSnapshot } from '../src/shared/statuslinePayload';
import type { StatuslineInstallState } from './statuslineInstaller';
import type { DiagnosticsSnapshot } from './collectorStore';
import type { PermissionRequestUI, PostToolFlagRequestUI } from '../src/state/types';
import type { PermissionDecision, PostToolFlagDecision } from './permissionServer';

contextBridge.exposeInMainWorld('aetherElectron', {
  pty: {
    start: (opts: { cols: number; rows: number }) => ipcRenderer.invoke('pty:start', opts),
    write: (input: string) => ipcRenderer.send('pty:write', input),
    resize: (cols: number, rows: number) => ipcRenderer.send('pty:resize', { cols, rows }),
    onData: (callback: (data: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: string) => callback(data);
      ipcRenderer.on('pty:data', listener);
      return () => ipcRenderer.removeListener('pty:data', listener);
    },
  },
  usage: {
    onSnapshot: (callback: (snapshot: RealUsageSnapshot) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: RealUsageSnapshot) => callback(snapshot);
      ipcRenderer.on('usage:snapshot', listener);
      return () => ipcRenderer.removeListener('usage:snapshot', listener);
    },
  },
  agents: {
    onSnapshot: (callback: (dispatches: RealAgentDispatch[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, dispatches: RealAgentDispatch[]) => callback(dispatches);
      ipcRenderer.on('agents:snapshot', listener);
      return () => ipcRenderer.removeListener('agents:snapshot', listener);
    },
    onCompleted: (callback: (completed: CompletedDispatchUsage[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, completed: CompletedDispatchUsage[]) => callback(completed);
      ipcRenderer.on('agents:completed', listener);
      return () => ipcRenderer.removeListener('agents:completed', listener);
    },
    onActiveWork: (callback: (work: RealActiveWork[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, work: RealActiveWork[]) => callback(work);
      ipcRenderer.on('agents:activeWork', listener);
      return () => ipcRenderer.removeListener('agents:activeWork', listener);
    },
    onAnomalies: (callback: (anomalies: Anomaly[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, anomalies: Anomaly[]) => callback(anomalies);
      ipcRenderer.on('agents:anomalies', listener);
      return () => ipcRenderer.removeListener('agents:anomalies', listener);
    },
    onCacheHitRatio: (callback: (ratio: number) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, ratio: number) => callback(ratio);
      ipcRenderer.on('agents:cacheHitRatio', listener);
      return () => ipcRenderer.removeListener('agents:cacheHitRatio', listener);
    },
    onNotification: (callback: (payload: { reason: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { reason: string }) => callback(payload);
      ipcRenderer.on('agents:notification', listener);
      return () => ipcRenderer.removeListener('agents:notification', listener);
    },
  },
  fleet: {
    onSnapshot: (callback: (rows: FleetSessionRow[] | null) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, rows: FleetSessionRow[] | null) => callback(rows);
      ipcRenderer.on('fleet:snapshot', listener);
      return () => ipcRenderer.removeListener('fleet:snapshot', listener);
    },
  },
  diagnostics: {
    onSnapshot: (callback: (snapshot: DiagnosticsSnapshot | null) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: DiagnosticsSnapshot | null) => callback(snapshot);
      ipcRenderer.on('diagnostics:snapshot', listener);
      return () => ipcRenderer.removeListener('diagnostics:snapshot', listener);
    },
  },
  optimize: {
    onFindings: (callback: (findings: OptimizeFinding[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, findings: OptimizeFinding[]) => callback(findings);
      ipcRenderer.on('optimize:findings', listener);
      return () => ipcRenderer.removeListener('optimize:findings', listener);
    },
    onSummary: (callback: (summary: OptimizeSummary) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, summary: OptimizeSummary) => callback(summary);
      ipcRenderer.on('optimize:summary', listener);
      return () => ipcRenderer.removeListener('optimize:summary', listener);
    },
    onBreakdown: (callback: (rows: GradeRow[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, rows: GradeRow[]) => callback(rows);
      ipcRenderer.on('optimize:breakdown', listener);
      return () => ipcRenderer.removeListener('optimize:breakdown', listener);
    },
    targets: (): Promise<{ global: { path: string; exists: boolean }; project: { path: string; exists: boolean } | null }> =>
      ipcRenderer.invoke('optimize:targets'),
    apply: (args: { findingId: string; target: 'global' | 'project' }): Promise<{ ok: boolean; added?: boolean; alreadyPresent?: boolean; targetPath?: string; backupPath?: string | null; error?: string }> =>
      ipcRenderer.invoke('optimize:apply', args),
  },
  attachments: {
    list: (): Promise<AttachmentInfo[]> => ipcRenderer.invoke('attachments:list'),
    add: (): Promise<string[]> => ipcRenderer.invoke('attachments:add'),
    remove: (name: string): Promise<void> => ipcRenderer.invoke('attachments:remove', name),
    thumbnail: (name: string): Promise<string | null> => ipcRenderer.invoke('attachments:thumbnail', name),
    open: (name: string): Promise<void> => ipcRenderer.invoke('attachments:open', name),
  },
  statusline: {
    onSnapshot: (callback: (snapshot: StatuslineSnapshot) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, snapshot: StatuslineSnapshot) => callback(snapshot);
      ipcRenderer.on('statusline:snapshot', listener);
      return () => ipcRenderer.removeListener('statusline:snapshot', listener);
    },
    state: (): Promise<StatuslineInstallState> => ipcRenderer.invoke('statusline:state'),
    currentSnapshot: (): Promise<StatuslineSnapshot | null> => ipcRenderer.invoke('statusline:snapshot:current'),
    install: (): Promise<{ ok: boolean; backupPath?: string | null; error?: string }> => ipcRenderer.invoke('statusline:install'),
    uninstall: (): Promise<{ ok: boolean; backupPath?: string | null; error?: string }> => ipcRenderer.invoke('statusline:uninstall'),
  },
  permission: {
    onRequest: (callback: (request: PermissionRequestUI) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, request: PermissionRequestUI) => callback(request);
      ipcRenderer.on('permission:request', listener);
      return () => ipcRenderer.removeListener('permission:request', listener);
    },
    respond: (requestId: string, decision: PermissionDecision): Promise<void> => ipcRenderer.invoke('permission:respond', { requestId, decision }),
  },
  postToolFlag: {
    onRequest: (callback: (request: PostToolFlagRequestUI) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, request: PostToolFlagRequestUI) => callback(request);
      ipcRenderer.on('postToolFlag:request', listener);
      return () => ipcRenderer.removeListener('postToolFlag:request', listener);
    },
    respond: (requestId: string, decision: PostToolFlagDecision): Promise<void> => ipcRenderer.invoke('postToolFlag:respond', { requestId, decision }),
  },
  chat: {
    send: (body: unknown): Promise<{ reply: string } | { error: string }> => ipcRenderer.invoke('chat:send', body),
    hasKey: (): Promise<boolean> => ipcRenderer.invoke('chat:hasKey'),
  },
  presence: {
    onRecap: (callback: (recap: { entries: unknown[]; tokensBurned: number }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, recap: { entries: unknown[]; tokensBurned: number }) => callback(recap);
      ipcRenderer.on('presence:recap', listener);
      return () => ipcRenderer.removeListener('presence:recap', listener);
    },
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    onMaximizedChange: (callback: (isMaximized: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, isMaximized: boolean) => callback(isMaximized);
      ipcRenderer.on('window:isMaximized', listener);
      return () => ipcRenderer.removeListener('window:isMaximized', listener);
    },
  },
});
