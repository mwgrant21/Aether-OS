// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { STARTER_BOARDS } from '../../src/shared/dashboards/starters';
import { validateSpec } from '../../src/shared/dashboards/spec';
import { createRequire } from 'node:module';
import { DAY_MS, createFixtureCollectorDb, itWithAuthorizer } from './collectorDb.fixture';
import { evaluatePanel } from './evaluatePanel';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

describe('starter boards', () => {
  it('are spend-cache and agent-fleet and pass validation', () => {
    expect(STARTER_BOARDS.map((b) => b.id)).toEqual(['spend-cache', 'agent-fleet']);
    for (const b of STARTER_BOARDS) expect(validateSpec(b)).toEqual({ ok: true, spec: b });
  });

  itWithAuthorizer('anomalies-by-kind counts retained rollups alongside live anomalies', async () => {
    const now = Date.now();
    const dbPath = createFixtureCollectorDb(now);
    const panel = STARTER_BOARDS.flatMap((b) => b.panels).find((p) => p.id === 'anomalies-by-kind')!;
    const r = await evaluatePanel(panel, { dbPath, nowMs: now, rowCap: 1000, rangeOverride: 'all' });
    expect(r.error).toBeNull();
    const byKind = Object.fromEntries(r.rows.map((row) => [row.kind, row.anomalies]));
    expect(byKind).toMatchObject({ loop: 2, reReadLoop: 1, zeroEditBurn: 1 });
  });

  itWithAuthorizer('anomalies-by-kind excludes rollups on or before the range boundary day', async () => {
    const now = Date.now();
    const dbPath = createFixtureCollectorDb(now);
    const db = new DatabaseSync(dbPath);
    const boundaryDay = new Date(now - 30 * DAY_MS).toISOString().slice(0, 10);
    db.prepare('INSERT INTO daily_anomaly_rollups (day, kind, anomaly_count) VALUES (?, ?, ?)').run(boundaryDay, 'expired', 100);
    db.close();
    const panel = STARTER_BOARDS.flatMap((b) => b.panels).find((p) => p.id === 'anomalies-by-kind')!;
    const r = await evaluatePanel(panel, { dbPath, nowMs: now, rowCap: 1000 });
    expect(r.error).toBeNull();
    expect(r.rows.map((row) => row.kind)).not.toContain('expired');
  });

  itWithAuthorizer('every panel evaluates without error against a collector-shaped db', async () => {
    const now = Date.now();
    const dbPath = createFixtureCollectorDb(now);
    for (const board of STARTER_BOARDS) {
      for (const panel of board.panels) {
        const r = await evaluatePanel(panel, { dbPath, nowMs: now, rowCap: 1000 });
        expect({ board: board.id, panel: panel.id, error: r.error }).toEqual({ board: board.id, panel: panel.id, error: null });
        expect(r.rows.length, `${board.id}/${panel.id} returned no rows`).toBeGreaterThan(0);
      }
    }
  });
});
