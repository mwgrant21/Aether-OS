// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { STARTER_BOARDS } from '../../src/shared/dashboards/starters';
import { validateSpec } from '../../src/shared/dashboards/spec';
import { createFixtureCollectorDb } from './collectorDb.fixture';
import { evaluatePanel } from './evaluatePanel';

describe('starter boards', () => {
  it('are spend-cache and agent-fleet and pass validation', () => {
    expect(STARTER_BOARDS.map((b) => b.id)).toEqual(['spend-cache', 'agent-fleet']);
    for (const b of STARTER_BOARDS) expect(validateSpec(b)).toEqual({ ok: true, spec: b });
  });

  it('every panel evaluates without error against a collector-shaped db', async () => {
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
