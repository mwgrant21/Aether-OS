import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { AetherStoreProvider, useAetherStore } from '../../state/store';
import { ReadinessCard } from './ReadinessCard';
import { DESKTOP_APP_REASON } from './readinessMath';
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
  const utils = render(
    <AetherStoreProvider>
      <DispatchProbe />
      <ReadinessCard />
    </AetherStoreProvider>,
  );
  return utils;
}
function allMet() {
  act(() => {
    dispatchRef!({ type: 'SET_TERMINAL_ALIVE', alive: true });
    dispatchRef!({ type: 'SET_STATUSLINE', snapshot: freshStatusline() });
    dispatchRef!({ type: 'SET_DIAGNOSTICS', diagnostics: { toolCalls: [], dispatches: [], anomalies: [] } });
  });
}
const rowText = (key: string) => screen.getByTestId(`readiness-${key}`).textContent;
const dot = (key: string) => screen.getByTestId(`readiness-dot-${key}`);

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReadinessCard', () => {
  it('is an h2-headed list of four rows', () => {
    renderCard();
    expect(screen.getByRole('heading', { level: 2, name: 'READINESS' })).toBeTruthy();
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(4);
  });

  it('reads the cold browser-mode sentences', () => {
    renderCard();
    expect(rowText('desktop')).toBe(`Desktop app: not running. ${DESKTOP_APP_REASON}`);
    expect(rowText('terminal')).toBe('Terminal: no session yet.');
    expect(rowText('statusline')).toBe('Statusline: no reading yet.');
    expect(rowText('collector')).toBe('Collector: not running.');
  });

  it('reads all four met sentences in the desktop app with a session, a statusline and the collector', () => {
    vi.stubGlobal('aetherElectron', {});
    renderCard();
    allMet();
    expect(rowText('desktop')).toBe('Desktop app: running.');
    expect(rowText('terminal')).toBe('Terminal: open.');
    expect(rowText('statusline')).toBe('Statusline: live.');
    expect(rowText('collector')).toBe('Collector: running.');
  });

  it('updates a row within one store update', () => {
    renderCard();
    act(() => dispatchRef!({ type: 'SET_TERMINAL_ALIVE', alive: true }));
    expect(rowText('terminal')).toBe('Terminal: open.');
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
    expect(rowText('terminal')).toBe('Terminal: open.');
    expect(dot('terminal').style.background).not.toBe('transparent');
    expect(dot('terminal').style.boxShadow).toBe('');
  });

  it('draws an unmet row as a flat hollow ring', () => {
    renderCard();
    expect(dot('terminal').style.background).toBe('transparent');
    expect(dot('terminal').style.boxShadow).toBe('');
  });

  it('holds the OPEN TERMINAL action', () => {
    renderCard();
    expect(screen.getByRole('button', { name: 'OPEN TERMINAL' })).toBeTruthy();
  });
});
