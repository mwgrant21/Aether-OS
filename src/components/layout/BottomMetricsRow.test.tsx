import { afterEach, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { useEffect } from 'react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';
import { BAR_MAX_HEIGHT, BAR_TRACK_CLIP, BottomMetricsRow, MIN_BAR_WIDTH, usageBarGap } from './BottomMetricsRow';
import { NO_DATA } from '../dashboard/dashboardMath';

afterEach(cleanup);

function renderRow() {
  return render(
    <AetherStoreProvider>
      <BottomMetricsRow />
    </AetherStoreProvider>,
  );
}

describe('BottomMetricsRow', () => {
  it('exposes the active usage range through aria-pressed', () => {
    renderRow();
    const weekly = screen.getByRole('button', { name: 'WEEKLY' });
    const live = screen.getByRole('button', { name: 'LIVE' });
    expect(weekly.getAttribute('aria-pressed')).toBe('true');
    expect(live.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(live);
    expect(live.getAttribute('aria-pressed')).toBe('true');
    expect(weekly.getAttribute('aria-pressed')).toBe('false');
  });

  it('draws no glowing arc on the context ring before the first reading', () => {
    const { container } = renderRow();
    expect(container.querySelector('[data-context-arc]')).toBeNull();
    expect(container.querySelector('svg [style*="drop-shadow"]')).toBeNull();
  });

  it('shows the shared NO_DATA mark, not "--", for the context percentage with no reading', () => {
    renderRow();
    expect(screen.getByTestId('context-pct').textContent).toBe(NO_DATA);
  });

  it('renders the no-commands empty state as one sentence', () => {
    renderRow();
    expect(screen.getByText('No commands run this session.')).toBeTruthy();
  });

  it('slides fixed-height bars up out of a bottom-clipped track with translateY (never scaleY, never animated height)', () => {
    const { container } = renderRow();
    const bars = container.querySelectorAll<HTMLElement>('[data-usage-bar]');
    expect(bars.length).toBe(7);
    for (const bar of bars) {
      expect(bar.style.height).toBe(`${BAR_MAX_HEIGHT}px`);
      // Before the first scan every bucket is a 2px baseline tick: still visible.
      expect(bar.style.transform).toBe(`translateY(${BAR_MAX_HEIGHT - 2}px)`);
      expect(bar.style.transform).not.toContain('scale');
      expect(bar.style.transition).toContain('transform');
      expect(bar.style.transition).not.toContain('height');
      const track = bar.parentElement!;
      expect(track.dataset.usageTrack).toBe('true');
      expect(track.style.height).toBe(`${BAR_MAX_HEIGHT}px`);
      expect(track.style.clipPath).toBe(BAR_TRACK_CLIP);
      expect(track.style.overflow).toBe('');
    }
  });

  it('fills unlabelled buckets with an escaped no-break space, never an invisible literal one in source', () => {
    renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'DAILY' }));
    const labels = Array.from(screen.getByTestId('usage-bars').children).map((c) => c.querySelector('span')!.textContent);
    expect(labels[1]).toBe('\u00A0');
    const source = readFileSync('src/components/layout/BottomMetricsRow.tsx', 'utf8');
    expect(source).not.toContain('\u00A0');
    expect(source).toContain("'\\u00A0'");
  });

  it('paint-contains the usage card so the clipped bar slabs add no scroll height', () => {
    renderRow();
    const card = screen.getByText('TOKEN USAGE').parentElement!.parentElement!;
    expect(card.style.contain).toBe('paint');
  });

  it('tightens the bar gap as the bucket count grows', () => {
    expect(usageBarGap(7)).toBe(9);
    expect(usageBarGap(12)).toBe(6);
    expect(usageBarGap(24)).toBe(3);
  });

  it('gives every DAILY bucket a column with a floor width and a gap that fits 24 bars', () => {
    const { container } = renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'DAILY' }));
    const row = screen.getByTestId('usage-bars');
    const columns = Array.from(row.children) as HTMLElement[];
    expect(columns).toHaveLength(24);
    expect(row.style.gap).toBe('3px');
    expect(row.style.minWidth).toBe('0');
    for (const col of columns) expect(col.style.minWidth).toBe(`${MIN_BAR_WIDTH}px`);
    expect(container.querySelectorAll('[data-usage-bar]')).toHaveLength(24);
  });

  it('labels every third minute on LIVE so the labels fit beside the total', () => {
    renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'LIVE' }));
    const labels = Array.from(screen.getByTestId('usage-bars').children).map((c) => c.textContent?.trim());
    expect(labels.filter(Boolean)).toEqual(['-9m', '-6m', '-3m', 'now']);
  });

  it('hides the decorative context ring SVG from assistive tech', () => {
    const { container } = renderRow();
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('reads — for Session start and Uptime at STANDBY, and real values once a session is live', () => {
    const value = (k: string) => screen.getByText(k).nextElementSibling!.textContent;
    const { unmount } = renderRow();
    expect(value('Session start')).toBe(NO_DATA);
    expect(value('Uptime')).toBe(NO_DATA);
    unmount();

    // A fresh statusline capture is one of isSessionLive's signals.
    const fresh: StatuslineSnapshot = {
      capturedAtMs: Date.now(),
      sessionId: null,
      modelId: null,
      modelDisplayName: null,
      fiveHour: null,
      sevenDay: null,
      contextUsedPercentage: null,
      contextWindowSize: null,
      contextUsage: null,
      totalCostUsd: null,
      currentDir: null,
      projectDir: null,
    };
    function GoLive() {
      const { dispatch } = useAetherStore();
      useEffect(() => {
        dispatch({ type: 'SET_STATUSLINE', snapshot: fresh });
        dispatch({ type: 'SET_TERMINAL_ALIVE', alive: true }); // stamps sessionStartedAt
      }, [dispatch]);
      return null;
    }
    render(
      <AetherStoreProvider>
        <GoLive />
        <BottomMetricsRow />
      </AetherStoreProvider>,
    );
    expect(value('Session start')).not.toBe(NO_DATA);
    expect(value('Uptime')).not.toBe(NO_DATA);
  });
});
