import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RetentionCard } from './RetentionCard';
import { AetherStoreProvider } from '../../state/store';
import { colors } from '../../styles/tokens';

// jsdom normalizes inline hex colors read back via el.style.color to
// rgb(...) form, so comparisons against the token's '#rrggbb' string need
// the same normalization.
function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

function mockRetention(overrides: Partial<{
  status: ReturnType<typeof vi.fn>;
  purge: ReturnType<typeof vi.fn>;
}> = {}) {
  const status =
    overrides.status ??
    vi.fn().mockResolvedValue({
      exists: true,
      readable: true,
      fileSizeBytes: 2_400_000,
      oldestRetainedAtMs: Date.UTC(2026, 6, 1),
      rowCounts: {
        events: 120, dailyRollups: 8, usageEvents: 40, toolCalls: 55,
        dispatches: 12, anomalies: 3, dailyAnomalyRollups: 2, driftLog: 0, fleetSessions: 1,
      },
    });
  const purge = overrides.purge ?? vi.fn().mockResolvedValue({ ok: true });
  (window as unknown as { aetherElectron: unknown }).aetherElectron = {
    retention: { status, purge },
  };
  return { status, purge };
}

describe('RetentionCard', () => {
  it('shows "No collector data yet" when the store does not exist', async () => {
    mockRetention({
      status: vi.fn().mockResolvedValue({
        exists: false, readable: true, fileSizeBytes: 0, oldestRetainedAtMs: null,
        rowCounts: { events: 0, dailyRollups: 0, usageEvents: 0, toolCalls: 0, dispatches: 0, anomalies: 0, dailyAnomalyRollups: 0, driftLog: 0, fleetSessions: 0 },
      }),
    });
    render(
      <AetherStoreProvider>
        <RetentionCard />
      </AetherStoreProvider>,
    );
    await waitFor(() => expect(screen.getByText(/no collector data yet/i)).toBeTruthy());
  });

  // Finding 1: a corrupt/unreadable store must render as a distinct,
  // danger-colored state, not fold into the same "no data yet" message a
  // genuinely empty store shows -- see StatuslineCard's `unreadable` status
  // for the existing color convention this follows.
  it('shows a distinct danger-colored message when the store exists but could not be read', async () => {
    mockRetention({
      status: vi.fn().mockResolvedValue({
        exists: true, readable: false, fileSizeBytes: 0, oldestRetainedAtMs: null,
        rowCounts: { events: 0, dailyRollups: 0, usageEvents: 0, toolCalls: 0, dispatches: 0, anomalies: 0, dailyAnomalyRollups: 0, driftLog: 0, fleetSessions: 0 },
      }),
    });
    render(
      <AetherStoreProvider>
        <RetentionCard />
      </AetherStoreProvider>,
    );
    const el = await waitFor(() => screen.getByText(/store present but could not be read/i));
    expect(el.style.color).toBe(hexToRgb(colors.danger));
    expect(screen.queryByText(/no collector data yet/i)).toBeNull();
  });

  it('renders the formatted store size and row count on load', async () => {
    mockRetention();
    render(
      <AetherStoreProvider>
        <RetentionCard />
      </AetherStoreProvider>,
    );
    await waitFor(() => expect(screen.getByText('2.4 MB')).toBeTruthy());
  });

  it('does not purge on the first click -- shows an inline confirm instead', async () => {
    const { purge } = mockRetention();
    render(
      <AetherStoreProvider>
        <RetentionCard />
      </AetherStoreProvider>,
    );
    await waitFor(() => expect(screen.getByText('2.4 MB')).toBeTruthy());

    fireEvent.click(screen.getByText(/purge all collected data/i));

    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();
    expect(purge).not.toHaveBeenCalled();
  });

  it('cancel closes the confirm panel without purging', async () => {
    const { purge } = mockRetention();
    render(
      <AetherStoreProvider>
        <RetentionCard />
      </AetherStoreProvider>,
    );
    await waitFor(() => expect(screen.getByText('2.4 MB')).toBeTruthy());

    fireEvent.click(screen.getByText(/purge all collected data/i));
    fireEvent.click(screen.getByText('CANCEL'));

    expect(screen.queryByText(/cannot be undone/i)).toBeNull();
    expect(purge).not.toHaveBeenCalled();
  });

  it('confirming calls purge and refreshes the status afterward', async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({
        exists: true, readable: true, fileSizeBytes: 2_400_000, oldestRetainedAtMs: Date.UTC(2026, 6, 1),
        rowCounts: { events: 120, dailyRollups: 8, usageEvents: 40, toolCalls: 55, dispatches: 12, anomalies: 3, dailyAnomalyRollups: 2, driftLog: 0, fleetSessions: 1 },
      })
      .mockResolvedValueOnce({
        exists: true, readable: true, fileSizeBytes: 4096, oldestRetainedAtMs: null,
        rowCounts: { events: 0, dailyRollups: 0, usageEvents: 0, toolCalls: 0, dispatches: 0, anomalies: 0, dailyAnomalyRollups: 0, driftLog: 0, fleetSessions: 0 },
      });
    const { purge } = mockRetention({ status });
    render(
      <AetherStoreProvider>
        <RetentionCard />
      </AetherStoreProvider>,
    );
    await waitFor(() => expect(screen.getByText('2.4 MB')).toBeTruthy());

    fireEvent.click(screen.getByText(/purge all collected data/i));
    fireEvent.click(screen.getByText(/I UNDERSTAND, PURGE/i));

    await waitFor(() => expect(purge).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('4.1 KB')).toBeTruthy());
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('surfaces a purge failure inline instead of swallowing it', async () => {
    mockRetention({ purge: vi.fn().mockResolvedValue({ ok: false, error: 'disk full' }) });
    render(
      <AetherStoreProvider>
        <RetentionCard />
      </AetherStoreProvider>,
    );
    await waitFor(() => expect(screen.getByText('2.4 MB')).toBeTruthy());

    fireEvent.click(screen.getByText(/purge all collected data/i));
    fireEvent.click(screen.getByText(/I UNDERSTAND, PURGE/i));

    const errorEl = await waitFor(() => screen.getByText(/disk full/i));
    // Finding 2a: a failed destructive action must not read the same as a
    // neutral hint ("Checking…" etc, styled with textSecondary) -- assert
    // the actual danger color, not just the text.
    expect(errorEl.style.color).toBe(hexToRgb(colors.danger));
  });

  it('reopening the confirm panel after a failed purge clears the stale error message', async () => {
    mockRetention({ purge: vi.fn().mockResolvedValue({ ok: false, error: 'disk full' }) });
    render(
      <AetherStoreProvider>
        <RetentionCard />
      </AetherStoreProvider>,
    );
    await waitFor(() => expect(screen.getByText('2.4 MB')).toBeTruthy());

    fireEvent.click(screen.getByText(/purge all collected data/i));
    fireEvent.click(screen.getByText(/I UNDERSTAND, PURGE/i));
    await waitFor(() => expect(screen.getByText(/disk full/i)).toBeTruthy());

    // Finding 2b: reopening the confirm panel (not just retrying the purge)
    // must clear the previous error, so it doesn't sit stale underneath the
    // freshly reopened confirm panel.
    fireEvent.click(screen.getByText(/purge all collected data/i));

    expect(screen.queryByText(/disk full/i)).toBeNull();
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();
  });
});
