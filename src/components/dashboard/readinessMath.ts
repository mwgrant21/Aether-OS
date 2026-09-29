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
}

/** One sentence, two places: after "Desktop app: not running." and under a disabled OPEN TERMINAL. */
export const DESKTOP_APP_REASON = 'The Terminal and live tracking need the desktop app.';

/** True inside Electron, where preload exposes window.aetherElectron; plain `npm run dev` has none. */
export function hasDesktopApp(): boolean {
  return typeof window !== 'undefined' && window.aetherElectron !== undefined;
}

/** Same threshold and comparison as isSessionLive's statusline signal (dashboardMath.ts). */
export function isStatuslineFresh(snap: StatuslineSnapshot | null, nowMs: number): boolean {
  return snap !== null && nowMs - snap.capturedAtMs <= STATUSLINE_STALE_AFTER_MS;
}

/**
 * The READINESS rows. Every signal is already in the store or on
 * window.aetherElectron (passed in as `desktop` so this stays pure). None of
 * these is a request for the operator, so none is amber: met or not met.
 */
export function computeReadiness(
  state: Pick<AetherState, 'terminalAlive' | 'statusline' | 'diagnostics'>,
  desktop: boolean,
  nowMs: number,
): ReadinessRow[] {
  const statuslineFresh = isStatuslineFresh(state.statusline, nowMs);
  const collector = state.diagnostics !== null;
  return [
    {
      key: 'desktop',
      met: desktop,
      glows: false,
      text: desktop ? 'Desktop app: running.' : `Desktop app: not running. ${DESKTOP_APP_REASON}`,
    },
    {
      key: 'terminal',
      met: state.terminalAlive,
      glows: state.terminalAlive,
      text: state.terminalAlive ? 'Terminal: open.' : 'Terminal: no session yet.',
    },
    {
      key: 'statusline',
      met: statuslineFresh,
      glows: statuslineFresh,
      text: statuslineFresh
        ? 'Statusline: live.'
        : state.statusline === null
          ? 'Statusline: no reading yet.'
          : 'Statusline: last reading is stale.',
    },
    { key: 'collector', met: collector, glows: false, text: collector ? 'Collector: running.' : 'Collector: not running.' },
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
