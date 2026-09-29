import type { AetherState } from '../../state/types';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';
import { STATUSLINE_STALE_AFTER_MS } from '../../shared/depletion';

export type ReadinessKey = 'desktop' | 'terminal' | 'statusline' | 'collector';

export interface ReadinessRow {
  readonly key: ReadinessKey;
  readonly met: boolean;
  /**
   * Light Is Energy: only a met row backed by a live signal (Terminal,
   * Statusline) may glow. Desktop app and Collector are static facts.
   */
  readonly glows: boolean;
  readonly text: string;
  /** How to make an unmet row true, in one line. Null on a met row, never null on an unmet one. */
  readonly hint: string | null;
}

/** Printed once, under a disabled OPEN TERMINAL (OpenTerminalButton). The Desktop row no longer repeats it. */
export const DESKTOP_APP_REASON = 'The Terminal and live tracking need the desktop app.';

/** The commands a hint may name; ReadinessCard sets these in the mono font. */
export const HINT_COMMANDS = ['npm run electron:dev', 'npm run build', 'npm start'] as const;

/** True inside Electron, where preload exposes window.aetherElectron; plain `npm run dev` has none. */
export function hasDesktopApp(): boolean {
  return typeof window !== 'undefined' && window.aetherElectron !== undefined;
}

/** Same threshold and comparison as isSessionLive's statusline signal (dashboardMath.ts). */
export function isStatuslineFresh(snap: StatuslineSnapshot | null, nowMs: number): boolean {
  return snap !== null && nowMs - snap.capturedAtMs <= STATUSLINE_STALE_AFTER_MS;
}

// A fixed table, not toLocale*: the OS locale must not change READINESS copy.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Absolute local time, `HH:MM`, prefixed with the short date (`Sep 28 14:02`)
 * when `atMs` is not on `nowMs`'s local calendar day. Pure: compares against
 * `nowMs`, never `new Date()`, so a test fixes both ends. No relative times --
 * they would need a ticking re-render and go stale on screen.
 */
export function formatReadinessTime(atMs: number, nowMs: number): string {
  const t = new Date(atMs);
  const now = new Date(nowMs);
  const hhmm = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  const sameDay = t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
  return sameDay ? hhmm : `${MONTHS[t.getMonth()]} ${t.getDate()} ${hhmm}`;
}

/**
 * The newest event the collector recorded, across tool calls, dispatches and
 * anomalies. Used only for the {t} in the Collector row's met text -- whether
 * the row is met at all comes from readDiagnostics' own heartbeat gate (see
 * computeReadiness below), not from this value's age.
 */
export function newestCollectorEventMs(diagnostics: AetherState['diagnostics']): number | null {
  if (diagnostics === null) return null;
  let newest: number | null = null;
  const stamps = [
    ...diagnostics.toolCalls.map((t) => t.closedAtMs),
    ...diagnostics.dispatches.map((d) => d.endedAtMs),
    ...diagnostics.anomalies.map((a) => a.detectedAtMs),
  ];
  for (const ms of stamps) if (newest === null || ms > newest) newest = ms;
  return newest;
}

export interface HintPart {
  readonly text: string;
  readonly command: boolean;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HINT_COMMAND_SPLIT = new RegExp(`(${HINT_COMMANDS.map(escapeRegExp).join('|')})`);

/** Splits a hint into plain text and HINT_COMMANDS runs, in order, dropping empty pieces. */
export function splitHintCommands(hint: string): HintPart[] {
  return hint
    .split(HINT_COMMAND_SPLIT)
    .filter((text) => text !== '')
    .map((text) => ({ text, command: (HINT_COMMANDS as readonly string[]).includes(text) }));
}

/**
 * The READINESS rows. Every signal is already in the store or on
 * window.aetherElectron (passed in as `desktop` so this stays pure). None of
 * these is a request for the operator, so none is amber: met or not met. A
 * met row says when it was last true; an unmet row says how to fix it.
 */
export function computeReadiness(
  state: Pick<AetherState, 'terminalAlive' | 'terminalOpenedAtMs' | 'statusline' | 'diagnostics'>,
  desktop: boolean,
  nowMs: number,
): ReadinessRow[] {
  const time = (ms: number) => formatReadinessTime(ms, nowMs);
  const statuslineFresh = isStatuslineFresh(state.statusline, nowMs);
  const newest = newestCollectorEventMs(state.diagnostics);
  // Only the desktop app reads the collector's heartbeat-gated snapshot; in the
  // browser `diagnostics` is always null, which says nothing about the collector.
  const collectorRunning = desktop && state.diagnostics !== null;
  return [
    {
      key: 'desktop',
      met: desktop,
      glows: false,
      text: desktop ? 'Desktop app: running.' : 'Desktop app: not running.',
      hint: desktop ? null : 'Start it with npm run electron:dev.',
    },
    {
      key: 'terminal',
      met: state.terminalAlive,
      glows: state.terminalAlive,
      text: !state.terminalAlive
        ? 'Terminal: no session yet.'
        : state.terminalOpenedAtMs === null
          ? 'Terminal: open.'
          : `Terminal: open since ${time(state.terminalOpenedAtMs)}.`,
      // Rule 1: name OPEN TERMINAL only when it can actually open one.
      hint: state.terminalAlive ? null : desktop ? 'Use OPEN TERMINAL below.' : 'Needs the desktop app.',
    },
    {
      key: 'statusline',
      met: statuslineFresh,
      glows: statuslineFresh,
      text:
        state.statusline === null
          ? 'Statusline: no reading yet.'
          : statuslineFresh
            ? `Statusline: live, ${time(state.statusline.capturedAtMs)}.`
            : `Statusline: last reading ${time(state.statusline.capturedAtMs)}.`,
      hint: state.statusline === null ? 'Install it in Settings, then run a Claude Code turn.' : statuslineFresh ? null : 'Refreshes on each Claude Code turn.',
    },
    {
      key: 'collector',
      met: collectorRunning,
      glows: false,
      text: !desktop
        ? 'Collector: not visible from the browser.'
        : !collectorRunning
          ? 'Collector: not running.'
          : newest === null
            ? 'Collector: running, no events in the last 24h.'
            : `Collector: running, last event ${time(newest)}.`,
      hint: collectorRunning
        ? null
        : desktop
          ? 'Build and start it in collector/: npm run build, then npm start.'
          : 'Needs the desktop app.',
    },
  ];
}

export interface DigestPresence {
  readonly agents: boolean;
  readonly projects: boolean;
  readonly alerts: boolean;
}

/**
 * A digest earns a panel only when it has something to show. Agents also need
 * a live terminal (the same gate as isSessionLive): the tracker retains its
 * open dispatches after the PTY dies.
 */
export function computeDigestPresence(state: Pick<AetherState, 'realAgents' | 'terminalAlive' | 'projectsSnapshot' | 'notifs'>): DigestPresence {
  return {
    agents: state.realAgents.length > 0 && state.terminalAlive,
    projects: (state.projectsSnapshot?.roots.length ?? 0) > 0,
    alerts: state.notifs.length > 0,
  };
}

export type StripItemKey = 'agents' | 'projects' | 'alerts' | 'memory';

export interface StripItem {
  readonly key: StripItemKey;
  readonly label: string;
  readonly count: number;
  readonly unit: string | null;
}

/**
 * The STANDBY STRIP: one item per digest without data, then the memory count
 * (memory has no dashboard panel, so it rides along whenever the strip shows).
 * Empty -- the strip hides -- once every digest has a panel.
 */
export function computeStripItems(presence: DigestPresence, memoryCount: number): StripItem[] {
  if (presence.agents && presence.projects && presence.alerts) return [];
  const items: StripItem[] = [];
  if (!presence.agents) items.push({ key: 'agents', label: 'Agents', count: 0, unit: null });
  if (!presence.projects) items.push({ key: 'projects', label: 'Projects', count: 0, unit: null });
  if (!presence.alerts) items.push({ key: 'alerts', label: 'Alerts', count: 0, unit: null });
  items.push({ key: 'memory', label: 'Memory', count: memoryCount, unit: memoryCount === 1 ? 'engram' : 'engrams' });
  return items;
}
