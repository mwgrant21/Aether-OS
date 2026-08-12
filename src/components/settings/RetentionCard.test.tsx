import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RetentionCard } from './RetentionCard';
import { AetherStoreProvider } from '../../state/store';

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
        exists: false, fileSizeBytes: 0, oldestRetainedAtMs: null,
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
        exists: true, fileSizeBytes: 2_400_000, oldestRetainedAtMs: Date.UTC(2026, 6, 1),
        rowCounts: { events: 120, dailyRollups: 8, usageEvents: 40, toolCalls: 55, dispatches: 12, anomalies: 3, dailyAnomalyRollups: 2, driftLog: 0, fleetSessions: 1 },
      })
      .mockResolvedValueOnce({
        exists: true, fileSizeBytes: 4096, oldestRetainedAtMs: null,
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

    await waitFor(() => expect(screen.getByText(/disk full/i)).toBeTruthy());
  });
});
