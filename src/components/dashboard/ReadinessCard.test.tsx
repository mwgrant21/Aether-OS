import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { ReadinessCard } from './ReadinessCard';
import { DESKTOP_APP_REASON } from './readinessMath';
import { colors, fonts } from '../../styles/tokens';
import type { StatuslineSnapshot } from '../../shared/statuslinePayload';

const freshStatusline = (): StatuslineSnapshot => ({
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
});

let dispatchRef: ReturnType<typeof useAetherStore>['dispatch'] | null = null;
function DispatchProbe() {
  dispatchRef = useAetherStore().dispatch;
  return null;
}
function renderCard() {
  return render(
    <AetherStoreProvider>
      <DispatchProbe />
      <ReadinessCard />
    </AetherStoreProvider>,
  );
}
function allMet() {
  act(() => {
    dispatchRef!({ type: 'SET_TERMINAL_ALIVE', alive: true });
    dispatchRef!({ type: 'SET_STATUSLINE', snapshot: freshStatusline() });
    dispatchRef!({
      type: 'SET_DIAGNOSTICS',
      diagnostics: { toolCalls: [], dispatches: [], anomalies: [{ kind: 'k', toolUseId: 't', detail: 'd', detectedAtMs: Date.now() }] },
    });
  });
}

// jsdom normalizes colours (hex -> rgb) and font lists (quote style), so compare through the same parser.
function cssColor(value: string): string {
  const el = document.createElement('span');
  el.style.color = value;
  return el.style.color;
}
function cssFontFamily(value: string): string {
  const el = document.createElement('span');
  el.style.fontFamily = value;
  return el.style.fontFamily;
}

const KEYS = ['desktop', 'terminal', 'statusline', 'collector'] as const;
const text = (key: string) => screen.getByTestId(`readiness-text-${key}`).textContent;
const hint = (key: string) => screen.queryByTestId(`readiness-hint-${key}`);
const dot = (key: string) => screen.getByTestId(`readiness-dot-${key}`);
const card = () => screen.getByRole('heading', { name: 'READINESS' }).closest('section')!;

beforeEach(() => {
  localStorage.clear();
  // Pin the clock so tests that read a timestamp at dispatch time and again
  // at render time (formatReadinessTime's HH:MM regex) can't straddle a
  // local-midnight rollover and pick up a date prefix mid-test.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2024, 0, 15, 12, 0, 0));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ReadinessCard', () => {
  it('is an h2-headed list of four rows', () => {
    renderCard();
    expect(screen.getByRole('heading', { level: 2, name: 'READINESS' })).toBeTruthy();
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(4);
  });

  it('reads the cold browser-mode sentences, with the desktop reason printed once (under the button)', () => {
    renderCard();
    expect(text('desktop')).toBe('Desktop app: not running.');
    expect(text('terminal')).toBe('Terminal: no session yet.');
    expect(text('statusline')).toBe('Statusline: no reading yet.');
    expect(text('collector')).toBe('Collector: no events in the last 24h.');
    expect(within(card()).getAllByText(DESKTOP_APP_REASON)).toHaveLength(1);
  });

  it('prints a hint under every unmet row in browser mode', () => {
    renderCard();
    expect(hint('desktop')!.textContent).toBe('Start it with npm run electron:dev.');
    expect(hint('terminal')!.textContent).toBe('Needs the desktop app.');
    expect(hint('statusline')!.textContent).toBe('Install it in Settings, then run a Claude Code turn.');
    expect(hint('collector')!.textContent).toBe('Build and start it in collector/: npm run build, then npm start.');
  });

  it('in the desktop app points the Terminal hint at OPEN TERMINAL and drops the Desktop hint', () => {
    vi.stubGlobal('aetherElectron', {});
    renderCard();
    expect(hint('desktop')).toBeNull();
    expect(hint('terminal')!.textContent).toBe('Use OPEN TERMINAL below.');
  });

  it('reads all four met sentences with absolute times, and no hints', () => {
    vi.stubGlobal('aetherElectron', {});
    renderCard();
    allMet();
    expect(text('desktop')).toBe('Desktop app: running.');
    expect(text('terminal')).toMatch(/^Terminal: open since \d{2}:\d{2}\.$/);
    expect(text('statusline')).toMatch(/^Statusline: live, \d{2}:\d{2}\.$/);
    expect(text('collector')).toMatch(/^Collector: last event \d{2}:\d{2}\.$/);
    for (const key of KEYS) expect(hint(key)).toBeNull();
  });

  it('indents the hint to the sentence edge, clear of the dot, in 11px Text Muted UI type', () => {
    renderCard();
    expect(dot('desktop').style.gridColumn).toBe('1');
    expect(screen.getByTestId('readiness-text-desktop').style.gridColumn).toBe('2');
    const h = hint('desktop')!;
    expect(h.style.gridColumn).toBe('2');
    expect(h.style.gridRow).toBe('2');
    expect(h.style.fontSize).toBe('11px');
    expect(h.style.fontWeight).toBe('400');
    expect(h.style.color).toBe(cssColor(colors.textMuted));
    expect(h.style.fontFamily).toBe(cssFontFamily(fonts.ui));
  });

  it('sets command text in the mono font, and only command text', () => {
    renderCard();
    const desktopCmd = hint('desktop')!.querySelector('code')!;
    expect(desktopCmd.textContent).toBe('npm run electron:dev');
    expect(desktopCmd.style.fontFamily).toBe(cssFontFamily(fonts.mono));
    // The collector hint names two commands (`npm run build`, then `npm start`);
    // both must render as <code>, in the mono font, in order.
    const collectorCodes = [...hint('collector')!.querySelectorAll('code')];
    expect(collectorCodes.map((c) => c.textContent)).toEqual(['npm run build', 'npm start']);
    for (const c of collectorCodes) expect((c as HTMLElement).style.fontFamily).toBe(cssFontFamily(fonts.mono));
    expect(hint('terminal')!.querySelector('code')).toBeNull();
  });

  it('fills the column and pins OPEN TERMINAL to the bottom; the stretch is not between rows', () => {
    renderCard();
    expect(card().style.flexGrow).toBe('1');
    const action = screen.getByTestId('readiness-action');
    expect(action.style.marginTop).toBe('auto');
    expect(within(action).getByRole('button', { name: 'OPEN TERMINAL' })).toBeTruthy();
    const list = screen.getByRole('list');
    expect(list.style.gap).toBe('9px');
    expect(list.style.flexGrow).toBe('');
  });

  it('updates a row within one store update', () => {
    renderCard();
    act(() => dispatchRef!({ type: 'SET_TERMINAL_ALIVE', alive: true }));
    expect(text('terminal')).toMatch(/^Terminal: open since \d{2}:\d{2}\.$/);
  });

  it('lights only the live signals: Terminal and Statusline glow, Desktop app and Collector stay flat', () => {
    vi.stubGlobal('aetherElectron', {});
    renderCard();
    allMet();
    expect(dot('terminal').style.boxShadow).not.toBe('');
    expect(dot('statusline').style.boxShadow).not.toBe('');
    expect(dot('desktop').style.boxShadow).toBe('');
    expect(dot('collector').style.boxShadow).toBe('');
  });

  it('keeps a met Terminal dot flat green while the console is idle (STANDBY)', () => {
    renderCard();
    act(() => dispatchRef!({ type: 'SET_TERMINAL_ALIVE', alive: true }));
    expect(dot('terminal').style.background).not.toBe('transparent');
    expect(dot('terminal').style.boxShadow).toBe('');
  });

  it('rule 3: draws every unmet dot as a hollow Text Muted ring, and uses no amber anywhere', () => {
    const noAmber = () => {
      const html = card().outerHTML.toLowerCase();
      expect(html).not.toContain(cssColor(colors.warn));
      expect(html).not.toContain(colors.warn.toLowerCase());
    };
    const { unmount } = renderCard();
    for (const key of KEYS) {
      expect(dot(key).style.background).toBe('transparent');
      expect(dot(key).style.border).toContain(cssColor(colors.textMuted));
      expect(dot(key).style.boxShadow).toBe('');
    }
    noAmber();
    unmount();
    vi.stubGlobal('aetherElectron', {});
    renderCard();
    allMet();
    noAmber();
  });

  it('holds the OPEN TERMINAL action', () => {
    renderCard();
    expect(screen.getByRole('button', { name: 'OPEN TERMINAL' })).toBeTruthy();
  });
});
