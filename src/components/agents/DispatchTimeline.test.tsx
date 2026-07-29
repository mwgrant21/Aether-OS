import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DispatchTimeline } from './DispatchTimeline';

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
          toolCalls: [{ toolUseId: 'tu_1', toolName: 'Read', filePathRel: 'src/deep/nested/foo.ts', startedAtMs: 1000, closedAtMs: 2000 }],
          dispatches: [],
          anomalies: [],
        }}
      />
    );
    expect(screen.getByText('foo.ts')).toBeTruthy();
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
