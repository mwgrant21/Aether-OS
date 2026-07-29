import type { DiagnosticsSnapshot } from '../../../electron/collectorStore';

export function DispatchTimeline({ diagnostics }: { diagnostics: DiagnosticsSnapshot | null }) {
  if (diagnostics === null) {
    return <div className="dispatch-timeline dispatch-timeline--unavailable">collector isn&apos;t running -- diagnostics unavailable</div>;
  }

  const isEmpty = diagnostics.toolCalls.length === 0 && diagnostics.dispatches.length === 0 && diagnostics.anomalies.length === 0;
  if (isEmpty) {
    return <div className="dispatch-timeline dispatch-timeline--empty">No recent activity</div>;
  }

  const items = [
    ...diagnostics.toolCalls.map((t) => ({ atMs: t.closedAtMs, kind: 'toolCall' as const, data: t })),
    ...diagnostics.anomalies.map((a) => ({ atMs: a.detectedAtMs, kind: 'anomaly' as const, data: a })),
  ].sort((a, b) => b.atMs - a.atMs);

  return (
    <div className="dispatch-timeline">
      {items.map((item, i) =>
        item.kind === 'toolCall' ? (
          <div key={`tc-${i}`} className="dispatch-timeline__row dispatch-timeline__row--tool-call">
            <span>{item.data.toolName}</span>
            {item.data.filePathRel && <span>{item.data.filePathRel.split(/[\\/]/).pop()}</span>}
          </div>
        ) : (
          <div key={`an-${i}`} className="dispatch-timeline__row dispatch-timeline__row--anomaly">
            <span>{item.data.kind}</span>
            <span>{item.data.detail}</span>
          </div>
        ),
      )}
    </div>
  );
}
