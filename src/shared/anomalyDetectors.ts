import { type ClosedToolCall } from '../../electron/toolCallHistory';
import { type RealActiveWork } from '../state/liveAgentsMath';

export interface Anomaly {
  kind: 'reReadLoop' | 'writeDeleteRewrite' | 'zeroEditBurn' | 'stalledPermission';
  toolUseId: string;
  detail: string;
}

export function detectReReadLoop(events: ClosedToolCall[]): Anomaly[] {
  const byPath = new Map<string, ClosedToolCall[]>();

  // Group by filePath, only for Read operations
  for (const event of events) {
    if (event.toolName === 'Read' && event.filePath !== null) {
      if (!byPath.has(event.filePath)) {
        byPath.set(event.filePath, []);
      }
      byPath.get(event.filePath)!.push(event);
    }
  }

  const anomalies: Anomaly[] = [];
  for (const [filePath, reads] of byPath.entries()) {
    if (reads.length >= 3) {
      // Most recent read in the group
      const mostRecent = reads.reduce((a, b) => (b.closedAt > a.closedAt ? b : a));
      anomalies.push({
        kind: 'reReadLoop',
        toolUseId: mostRecent.toolUseId,
        detail: `${filePath} read ${reads.length} times`,
      });
    }
  }

  return anomalies;
}

export function detectWriteDeleteRewrite(events: ClosedToolCall[], nowMs: number): Anomaly[] {
  const fiveMinMs = 300000;
  const windowStart = nowMs - fiveMinMs;
  const byPath = new Map<string, ClosedToolCall[]>();

  // Group by filePath, only for Write/Edit operations within 5-minute window
  for (const event of events) {
    if ((event.toolName === 'Write' || event.toolName === 'Edit') && event.filePath !== null) {
      if (event.closedAt >= windowStart) {
        if (!byPath.has(event.filePath)) {
          byPath.set(event.filePath, []);
        }
        byPath.get(event.filePath)!.push(event);
      }
    }
  }

  const anomalies: Anomaly[] = [];
  for (const [filePath, writes] of byPath.entries()) {
    if (writes.length >= 3) {
      // Most recent write in the group
      const mostRecent = writes.reduce((a, b) => (b.closedAt > a.closedAt ? b : a));
      anomalies.push({
        kind: 'writeDeleteRewrite',
        toolUseId: mostRecent.toolUseId,
        detail: `${filePath} written ${writes.length} times in 5min`,
      });
    }
  }

  return anomalies;
}

export function detectZeroEditBurn(events: ClosedToolCall[], tokensUsed: number): Anomaly[] {
  if (tokensUsed < 20000) return [];

  // Check if there are any edit operations
  const hasEdits = events.some(
    (e) => e.toolName === 'Write' || e.toolName === 'Edit' || e.toolName === 'NotebookEdit',
  );

  if (!hasEdits) {
    return [
      {
        kind: 'zeroEditBurn',
        toolUseId: '',
        detail: `${tokensUsed} tokens used with zero file edits`,
      },
    ];
  }

  return [];
}

export function detectStalledPermission(
  openWork: RealActiveWork[],
  events: ClosedToolCall[],
  nowMs: number,
): Anomaly[] {
  const sixtySecMs = 60000;
  const closedIds = new Set(events.map((e) => e.toolUseId));
  const anomalies: Anomaly[] = [];

  for (const work of openWork) {
    const ageMs = nowMs - new Date(work.startedAt).getTime();
    if (ageMs > sixtySecMs && !closedIds.has(work.toolUseId)) {
      anomalies.push({
        kind: 'stalledPermission',
        toolUseId: work.toolUseId,
        detail: `${work.label} open for ${Math.round(ageMs / 1000)}s`,
      });
    }
  }

  return anomalies;
}

export function detectAnomalies(
  history: { events: ClosedToolCall[] },
  work: RealActiveWork[],
  tokensUsed: number,
  nowMs: number,
): Anomaly[] {
  const events = history.events;
  const anomalies: Anomaly[] = [];

  anomalies.push(...detectReReadLoop(events));
  anomalies.push(...detectWriteDeleteRewrite(events, nowMs));
  anomalies.push(...detectZeroEditBurn(events, tokensUsed));
  anomalies.push(...detectStalledPermission(work, events, nowMs));

  return anomalies;
}
