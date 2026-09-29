import { describe, expect, it } from 'vitest';
import {
  DESKTOP_APP_REASON,
  HINT_COMMANDS,
  computeDigestPresence,
  computeReadiness,
  computeStripItems,
  formatReadinessTime,
  newestCollectorEventMs,
  splitHintCommands,
  type ReadinessKey,
  type ReadinessRow,
} from './readinessMath';
import { isSessionLive } from './dashboardMath';
import { initialState } from '../../state/initialState';
import { STATUSLINE_STALE_AFTER_MS } from '../../shared/depletion';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';
import type { AetherState } from '../../state/types';

// Every instant is built from LOCAL wall-clock parts, so '14:30' is the
// expected output in any timezone. Never use an epoch literal or ISO string here.
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime();
const NOW = at(2026, 8, 29, 14, 30); // Sep 29 2026, 14:30 local
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
type Diag = NonNullable<AetherState['diagnostics']>;
const EMPTY_DIAG: AetherState['diagnostics'] = { toolCalls: [], dispatches: [], anomalies: [] };
const anomalyAt = (detectedAtMs: number): AetherState['diagnostics'] => ({
  toolCalls: [],
  dispatches: [],
  anomalies: [{ kind: 'k', toolUseId: 't', detail: 'd', detectedAtMs }],
});
const COLD = { ...initialState, terminalOpenedAtMs: null };
const row = (rows: ReadinessRow[], key: ReadinessKey) => rows.find((r) => r.key === key)!;

describe('formatReadinessTime', () => {
  it('prints zero-padded 24-hour HH:MM for an instant on the same local day', () => {
    expect(formatReadinessTime(at(2026, 8, 29, 9, 5), NOW)).toBe('09:05');
    expect(formatReadinessTime(at(2026, 8, 29, 0, 0), NOW)).toBe('00:00');
    expect(formatReadinessTime(at(2026, 8, 29, 23, 59), NOW)).toBe('23:59');
  });

  it('prefixes the short date for an earlier local day', () => {
    expect(formatReadinessTime(at(2026, 8, 28, 14, 2), NOW)).toBe('Sep 28 14:02');
    expect(formatReadinessTime(at(2026, 8, 5, 7, 0), NOW)).toBe('Sep 5 07:00');
  });

  it('rolls over at local midnight', () => {
    const justAfterMidnight = at(2026, 8, 30, 0, 1);
    expect(formatReadinessTime(at(2026, 8, 29, 23, 59), justAfterMidnight)).toBe('Sep 29 23:59');
    expect(formatReadinessTime(at(2026, 8, 30, 0, 0), justAfterMidnight)).toBe('00:00');
  });

  it('prefixes the date for the same day-of-month in another month or year', () => {
    expect(formatReadinessTime(at(2026, 7, 29, 14, 2), NOW)).toBe('Aug 29 14:02');
    expect(formatReadinessTime(at(2025, 8, 29, 14, 2), NOW)).toBe('Sep 29 14:02');
  });
});

describe('newestCollectorEventMs', () => {
  it('finds the newest event across tool calls, dispatches and anomalies', () => {
    const diag: Diag = {
      toolCalls: [{ toolUseId: 'a', toolName: 'Read', filePathRel: null, startedAtMs: 1, closedAtMs: 50 }],
      dispatches: [{ endedAtMs: 70 } as Diag['dispatches'][number]],
      anomalies: [{ kind: 'k', toolUseId: 't', detail: 'd', detectedAtMs: 60 }],
    };
    expect(newestCollectorEventMs(diag)).toBe(70);
    expect(newestCollectorEventMs({ ...diag, dispatches: [] })).toBe(60);
  });

  it('has no newest event with no snapshot or an empty one', () => {
    expect(newestCollectorEventMs(null)).toBeNull();
    expect(newestCollectorEventMs(EMPTY_DIAG)).toBeNull();
  });
});

describe('splitHintCommands', () => {
  it('marks exactly the known commands so the card can set them in mono', () => {
    expect(HINT_COMMANDS).toEqual(['npm run electron:dev', 'npm run build', 'npm start']);
    expect(splitHintCommands('Start it with npm run electron:dev.')).toEqual([
      { text: 'Start it with ', command: false },
      { text: 'npm run electron:dev', command: true },
      { text: '.', command: false },
    ]);
    expect(splitHintCommands('Build and start it in collector/: npm run build, then npm start.')).toEqual([
      { text: 'Build and start it in collector/: ', command: false },
      { text: 'npm run build', command: true },
      { text: ', then ', command: false },
      { text: 'npm start', command: true },
      { text: '.', command: false },
    ]);
    expect(splitHintCommands('Needs the desktop app.')).toEqual([{ text: 'Needs the desktop app.', command: false }]);
  });
});

describe('computeReadiness', () => {
  it('lists Desktop app, Terminal, Statusline, Collector in that order', () => {
    expect(computeReadiness(COLD, false, NOW).map((r) => r.key)).toEqual(['desktop', 'terminal', 'statusline', 'collector']);
  });

  it('Desktop app: states the fact once, with no appended reason, and hints how to start it', () => {
    expect(row(computeReadiness(COLD, true, NOW), 'desktop')).toMatchObject({ met: true, text: 'Desktop app: running.', hint: null });
    const unmet = row(computeReadiness(COLD, false, NOW), 'desktop');
    expect(unmet).toMatchObject({ met: false, text: 'Desktop app: not running.', hint: 'Start it with npm run electron:dev.' });
    expect(unmet.text).not.toContain(DESKTOP_APP_REASON);
  });

  it('Terminal: open since the stamped time; defensive "open." when unstamped', () => {
    const open = { ...COLD, terminalAlive: true, terminalOpenedAtMs: at(2026, 8, 29, 14, 2) };
    expect(row(computeReadiness(open, true, NOW), 'terminal')).toMatchObject({ met: true, text: 'Terminal: open since 14:02.', hint: null });
    const yesterday = { ...open, terminalOpenedAtMs: at(2026, 8, 28, 22, 15) };
    expect(row(computeReadiness(yesterday, true, NOW), 'terminal').text).toBe('Terminal: open since Sep 28 22:15.');
    expect(row(computeReadiness({ ...COLD, terminalAlive: true }, true, NOW), 'terminal')).toMatchObject({ met: true, text: 'Terminal: open.' });
  });

  it('Terminal: with no session, points at OPEN TERMINAL only in the desktop app', () => {
    expect(row(computeReadiness(COLD, true, NOW), 'terminal')).toMatchObject({ met: false, text: 'Terminal: no session yet.', hint: 'Use OPEN TERMINAL below.' });
    expect(row(computeReadiness(COLD, false, NOW), 'terminal')).toMatchObject({ met: false, text: 'Terminal: no session yet.', hint: 'Needs the desktop app.' });
  });

  it('Statusline: live with its capture time, no reading yet, or stale with its last time', () => {
    expect(row(computeReadiness({ ...COLD, statusline: snap(at(2026, 8, 29, 14, 29)) }, true, NOW), 'statusline')).toMatchObject({
      met: true,
      text: 'Statusline: live, 14:29.',
      hint: null,
    });
    expect(row(computeReadiness(COLD, true, NOW), 'statusline')).toMatchObject({
      met: false,
      text: 'Statusline: no reading yet.',
      hint: 'Install it in Settings, then run a Claude Code turn.',
    });
    expect(row(computeReadiness({ ...COLD, statusline: snap(at(2026, 8, 28, 14, 2)) }, true, NOW), 'statusline')).toMatchObject({
      met: false,
      text: 'Statusline: last reading Sep 28 14:02.',
      hint: 'Refreshes on each Claude Code turn.',
    });
  });

  it('Collector: met (diagnostics non-null) is running with the newest event or "no events"; unmet (null) is not running', () => {
    const hint = 'Build and start it in collector/: npm run build, then npm start.';
    // met, has an event
    expect(row(computeReadiness({ ...COLD, diagnostics: anomalyAt(at(2026, 8, 29, 14, 25)) }, true, NOW), 'collector')).toMatchObject({
      met: true,
      text: 'Collector: running, last event 14:25.',
      hint: null,
    });
    // met, no events yet (EMPTY_DIAG is non-null: the heartbeat-gated diagnostics snapshot exists)
    expect(row(computeReadiness({ ...COLD, diagnostics: EMPTY_DIAG }, true, NOW), 'collector')).toMatchObject({
      met: true,
      text: 'Collector: running, no events in the last 24h.',
      hint: null,
    });
    // unmet: diagnostics null means readDiagnostics' heartbeat gate rejected it
    expect(row(computeReadiness(COLD, true, NOW), 'collector')).toMatchObject({ met: false, text: 'Collector: not running.', hint });
  });

  it('lets only met live signals glow: Terminal and Statusline, never Desktop app or Collector', () => {
    const rows = computeReadiness(
      { ...COLD, terminalAlive: true, terminalOpenedAtMs: NOW, statusline: snap(NOW), diagnostics: anomalyAt(NOW) },
      true,
      NOW,
    );
    expect(rows.map((r) => [r.key, r.glows])).toEqual([
      ['desktop', false],
      ['terminal', true],
      ['statusline', true],
      ['collector', false],
    ]);
    expect(computeReadiness(COLD, false, NOW).some((r) => r.glows)).toBe(false);
  });

  it('agrees with isSessionLive at the statusline freshness boundary', () => {
    for (const age of [STATUSLINE_STALE_AFTER_MS, STATUSLINE_STALE_AFTER_MS + 1]) {
      const state = { ...COLD, statusline: snap(NOW - age) };
      expect(row(computeReadiness(state, true, NOW), 'statusline').met).toBe(isSessionLive(state, NOW));
    }
  });
});

describe('READINESS honesty rules', () => {
  const cases: { desktop: boolean; diagnostics: AetherState['diagnostics']; rows: ReadinessRow[] }[] = [];
  for (const desktop of [false, true])
    for (const terminalAlive of [false, true])
      for (const statusline of [null, snap(NOW), snap(NOW - STATUSLINE_STALE_AFTER_MS - 1)])
        for (const diagnostics of [null, EMPTY_DIAG, anomalyAt(NOW), anomalyAt(NOW - 24 * 60 * 60 * 1000)])
          cases.push({
            desktop,
            diagnostics,
            rows: computeReadiness({ terminalAlive, terminalOpenedAtMs: terminalAlive ? NOW : null, statusline, diagnostics }, desktop, NOW),
          });

  it('rule 1: names OPEN TERMINAL in a hint only when the desktop app is present', () => {
    for (const { desktop, rows } of cases) for (const r of rows) if (r.hint?.includes('OPEN TERMINAL')) expect(desktop).toBe(true);
    expect(cases.some(({ rows }) => rows.some((r) => r.hint === 'Use OPEN TERMINAL below.'))).toBe(true);
  });

  it('rule 2: the collector row is met exactly when the desktop app reads non-null diagnostics', () => {
    for (const { desktop, diagnostics, rows } of cases) expect(row(rows, 'collector').met).toBe(desktop && diagnostics !== null);
  });

  it('rule 6: in the browser the collector row claims nothing about the collector, and points at the desktop app', () => {
    for (const { desktop, rows } of cases) {
      if (desktop) continue;
      const r = row(rows, 'collector');
      expect(r.text).toBe('Collector: not visible from the browser.');
      expect(r.hint).toBe('Needs the desktop app.');
    }
  });

  it('rule 4: a met row never has a hint, an unmet row always does', () => {
    for (const { rows } of cases) for (const r of rows) expect(r.hint === null).toBe(r.met);
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
        terminalAlive: true,
        projectsSnapshot: { roots: [root], unscoped: null, computedAtMs: NOW },
        notifs: [{ t: '10:00', m: 'x', c: '#3be0a0' }],
      }),
    ).toEqual({ agents: true, projects: true, alerts: true });
    expect(computeDigestPresence({ ...initialState, realAgents: [agent], terminalAlive: false }).agents).toBe(false);
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
