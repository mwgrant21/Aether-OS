import { describe, expect, it } from 'vitest';
import {
  DESKTOP_APP_REASON,
  computeDigestPresence,
  computeReadiness,
  computeStripItems,
  type ReadinessKey,
} from './readinessMath';
import { isSessionLive } from './dashboardMath';
import { initialState } from '../../state/initialState';
import { STATUSLINE_STALE_AFTER_MS } from '../../shared/depletion';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';
import type { AetherState } from '../../state/types';

const NOW = 1_800_000_000_000;
const snap = (capturedAtMs: number): StatuslineSnapshot => ({
  capturedAtMs,
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
});
const DIAG: AetherState['diagnostics'] = { toolCalls: [], dispatches: [], anomalies: [] };
const row = (rows: ReturnType<typeof computeReadiness>, key: ReadinessKey) => rows.find((r) => r.key === key)!;

describe('computeReadiness', () => {
  it('lists Desktop app, Terminal, Statusline, Collector in that order', () => {
    expect(computeReadiness(initialState, false, NOW).map((r) => r.key)).toEqual(['desktop', 'terminal', 'statusline', 'collector']);
  });

  it('Desktop app: met copy in Electron, unmet copy with the reason in the browser', () => {
    expect(row(computeReadiness(initialState, true, NOW), 'desktop')).toMatchObject({ met: true, text: 'Desktop app: running.' });
    expect(row(computeReadiness(initialState, false, NOW), 'desktop')).toMatchObject({
      met: false,
      text: `Desktop app: not running. ${DESKTOP_APP_REASON}`,
    });
    expect(DESKTOP_APP_REASON).toBe('The Terminal and live tracking need the desktop app.');
  });

  it('Terminal: met when the pty is alive', () => {
    expect(row(computeReadiness({ ...initialState, terminalAlive: true }, true, NOW), 'terminal')).toMatchObject({ met: true, text: 'Terminal: open.' });
    expect(row(computeReadiness(initialState, true, NOW), 'terminal')).toMatchObject({ met: false, text: 'Terminal: no session yet.' });
  });

  it('Statusline: live, no reading yet, or stale', () => {
    expect(row(computeReadiness({ ...initialState, statusline: snap(NOW) }, true, NOW), 'statusline')).toMatchObject({ met: true, text: 'Statusline: live.' });
    expect(row(computeReadiness(initialState, true, NOW), 'statusline')).toMatchObject({ met: false, text: 'Statusline: no reading yet.' });
    expect(
      row(computeReadiness({ ...initialState, statusline: snap(NOW - STATUSLINE_STALE_AFTER_MS - 1) }, true, NOW), 'statusline'),
    ).toMatchObject({ met: false, text: 'Statusline: last reading is stale.' });
  });

  it('Collector: met when a diagnostics snapshot has arrived', () => {
    expect(row(computeReadiness({ ...initialState, diagnostics: DIAG }, true, NOW), 'collector')).toMatchObject({ met: true, text: 'Collector: running.' });
    expect(row(computeReadiness(initialState, true, NOW), 'collector')).toMatchObject({ met: false, text: 'Collector: not running.' });
  });

  it('lets only met live signals glow: Terminal and Statusline, never Desktop app or Collector', () => {
    const rows = computeReadiness({ ...initialState, terminalAlive: true, statusline: snap(NOW), diagnostics: DIAG }, true, NOW);
    expect(rows.map((r) => [r.key, r.glows])).toEqual([
      ['desktop', false],
      ['terminal', true],
      ['statusline', true],
      ['collector', false],
    ]);
    expect(computeReadiness(initialState, false, NOW).some((r) => r.glows)).toBe(false);
  });

  it('agrees with isSessionLive at the statusline freshness boundary', () => {
    for (const age of [STATUSLINE_STALE_AFTER_MS, STATUSLINE_STALE_AFTER_MS + 1]) {
      const state = { ...initialState, statusline: snap(NOW - age) };
      expect(row(computeReadiness(state, true, NOW), 'statusline').met).toBe(isSessionLive(state, NOW));
    }
  });
});

describe('computeDigestPresence', () => {
  it('marks a digest present only when it has something to show', () => {
    expect(computeDigestPresence(initialState)).toEqual({ agents: false, projects: false, alerts: false });
    const agent = {} as AetherState['realAgents'][number];
    const root = {} as NonNullable<AetherState['projectsSnapshot']>['roots'][number];
    expect(
      computeDigestPresence({
        realAgents: [agent],
        projectsSnapshot: { roots: [root], unscoped: null, computedAtMs: NOW },
        notifs: [{ t: '10:00', m: 'x', c: '#3be0a0' }],
      }),
    ).toEqual({ agents: true, projects: true, alerts: true });
    expect(computeDigestPresence({ ...initialState, projectsSnapshot: { roots: [], unscoped: null, computedAtMs: NOW } }).projects).toBe(false);
  });
});

describe('computeStripItems', () => {
  const none = { agents: false, projects: false, alerts: false };

  it('lists every digest without data, then the memory count', () => {
    expect(computeStripItems(none, 12)).toEqual([
      { key: 'agents', label: 'Agents', count: 0, unit: null },
      { key: 'projects', label: 'Projects', count: 0, unit: null },
      { key: 'alerts', label: 'Alerts', count: 0, unit: null },
      { key: 'memory', label: 'Memory', count: 12, unit: 'engrams' },
    ]);
  });

  it('drops a digest that has data', () => {
    expect(computeStripItems({ ...none, agents: true }, 0).map((i) => i.key)).toEqual(['projects', 'alerts', 'memory']);
  });

  it('is empty when every digest has data', () => {
    expect(computeStripItems({ agents: true, projects: true, alerts: true }, 5)).toEqual([]);
  });

  it('says "1 engram", singular', () => {
    expect(computeStripItems(none, 1).slice(-1)[0]).toEqual({ key: 'memory', label: 'Memory', count: 1, unit: 'engram' });
  });
});
