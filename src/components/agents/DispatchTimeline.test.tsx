import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DispatchTimeline } from './DispatchTimeline';
import type { DispatchRow } from '../../../electron/collectorStore';

// Stage 15 widened DispatchRow with the schema-v5 telemetry columns. This view
// doesn't read them, so its fixtures default them to null (the same "not
// available" value a pre-v5 collector database yields) and stay focused on the
// fields under test. Spelling them out per-fixture would be noise here, but
// they are NOT optional on the type -- a caller that needs them must handle
// null explicitly.
function dispatch(base: Pick<DispatchRow, 'toolUseId' | 'tokens' | 'toolUses' | 'durationMs' | 'startedAtMs' | 'endedAtMs'>): DispatchRow {
  return {
    ...base,
    agentId: null,
    taskKind: null,
    sessionId: null,
    retries: null,
    exitState: null,
    severity: null,
    medianMsAtEval: null,
  };
}

describe('DispatchTimeline', () => {
  it('shows "collector isn\'t running" when diagnostics is null', () => {
    render(<DispatchTimeline diagnostics={null} />);
    expect(screen.getByText(/collector isn't running/i)).toBeTruthy();
  });

  it('shows "No recent activity" when diagnostics is an empty snapshot', () => {
    render(<DispatchTimeline diagnostics={{ toolCalls: [], dispatches: [], anomalies: [] }} />);
    expect(screen.getByText(/no recent activity/i)).toBeTruthy();
  });

  it('renders a basename-only file path, never the full relative path with directories collapsed away from view', () => {
    render(
      <DispatchTimeline
        diagnostics={{
          toolCalls: [{ toolUseId: 'tu_1', toolName: 'Read', filePathRel: 'src/deep/nested/foo.ts', startedAtMs: 1000, closedAtMs: 2000, sourceFileRel: null }],
          dispatches: [],
          anomalies: [],
        }}
      />
    );
    expect(screen.getByText('foo.ts')).toBeTruthy();
  });

  it('renders a visible row for a dispatch-only snapshot instead of a blank card', () => {
    render(
      <DispatchTimeline
        diagnostics={{
          toolCalls: [],
          dispatches: [dispatch({ toolUseId: 'tu_task', tokens: 1234, toolUses: 7, durationMs: 4200, startedAtMs: 1000, endedAtMs: 5200 })],
          anomalies: [],
        }}
      />
    );
    expect(screen.getByText(/1,?234 tokens/i)).toBeTruthy();
    expect(screen.getByText(/7 tool uses/i)).toBeTruthy();
  });

  it('renders an anomaly row with its kind and detail', () => {
    render(
      <DispatchTimeline
        diagnostics={{
          toolCalls: [],
          dispatches: [],
          anomalies: [{ kind: 'reReadLoop', toolUseId: 'tu_1', detail: 'foo.ts read 3 times', detectedAtMs: 1000 }],
        }}
      />
    );
    expect(screen.getByText('foo.ts read 3 times')).toBeTruthy();
  });
});
