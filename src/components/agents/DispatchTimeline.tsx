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
    // Dispatch rows belong here too: isEmpty already counts dispatches as
    // "something to show," so omitting them let a dispatch-only snapshot fall
    // through the empty-state check and render a blank card.
    ...diagnostics.dispatches.map((d) => ({ atMs: d.endedAtMs, kind: 'dispatch' as const, data: d })),
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
        ) : item.kind === 'dispatch' ? (
          <div key={`dp-${i}`} className="dispatch-timeline__row dispatch-timeline__row--dispatch">
            <span>Agent</span>
            <span>{item.data.tokens} tokens</span>
            <span>{item.data.toolUses} tool uses</span>
            <span>{Math.round(item.data.durationMs / 1000)}s</span>
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
