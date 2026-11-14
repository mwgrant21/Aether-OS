import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GuiApp } from './GuiApp';

import type { ChatPaneStatus } from './ChatPane';

const flags = vi.hoisted(() => ({ markerReliable: true }));
vi.mock('./busyGate', async (orig) => {
  const m = await orig<typeof import('./busyGate')>();
  return { ...m, get GUI_BG_MARKER_RELIABLE() { return flags.markerReliable; } };
});

const mounts = { mount: 0, unmount: 0 };
// Test doubles for the panes' reports, keyed by chat key ('new' or a project id).
const reportStatus = new Map<string, (s: ChatPaneStatus) => void>();
const reportMode = new Map<string, (m: string) => void>();
vi.mock('./ChatPane', async () => {
  const { useEffect } = await import('react');
  return {
    ChatPane: ({ projectId, active, resume, mode, onModeChange, onStatus, onStopChat }: {
      projectId: string | null; active: boolean; resume?: boolean; mode: string;
      onModeChange: (m: string) => void; onStatus: (s: ChatPaneStatus) => void; onStopChat?: () => void;
    }) => {
      const key = projectId ?? 'new';
      reportStatus.set(key, onStatus);
      reportMode.set(key, onModeChange);
      useEffect(() => {
        mounts.mount += 1;
        return () => {
          mounts.unmount += 1;
        };
      }, []);
      return (
        <div data-testid="chat-pane" data-key={key} data-active={String(active)} data-resume={String(resume)} data-mode={mode} style={{ display: active ? 'block' : 'none' }}>
          chat:{String(projectId)}
          {onStopChat && <button onClick={onStopChat}>stop-chat:{key}</button>}
        </div>
      );
    },
  };
});

type AddResult = { ok: true; project: { id: string; name: string } } | { ok: false; reason: string };
const gui = {
  projects: { list: vi.fn(), add: vi.fn(), remove: vi.fn() },
  stop: vi.fn(),
};
const win = { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() };

async function renderApp() {
  render(<GuiApp />);
  await act(async () => {});
}

beforeEach(() => {
  mounts.mount = 0;
  mounts.unmount = 0;
  gui.projects.list.mockResolvedValue([
    { id: 'p1', name: 'alpha' },
    { id: 'p2', name: 'beta' },
  ]);
  gui.projects.add.mockReset();
  gui.projects.remove.mockReset();
  gui.stop.mockReset();
  flags.markerReliable = true;
  reportStatus.clear();
  reportMode.clear();
  Object.values(win).forEach((f) => f.mockReset());
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: { gui, window: win } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

const panesEl = () => screen.queryAllByTestId('chat-pane');
const paneOf = (key: string) => panesEl().find((e) => e.getAttribute('data-key') === key);
const pane = () => panesEl().find((e) => e.getAttribute('data-active') === 'true')!;
const report = (key: string, st: Partial<ChatPaneStatus>) =>
  act(() => reportStatus.get(key)!({ live: true, state: 'idle', trusted: true, hasSent: false, settled: false, ...st }));

describe('GuiApp shell', () => {
  it('names the app Aether Chat in the title strip', async () => {
    await renderApp();
    expect(screen.getByTestId('gui-title-strip').textContent).toContain('AETHER CHAT');
  });

  it('labels the navigation Aether Chat navigation', async () => {
    await renderApp();
    expect(screen.getByRole('navigation', { name: 'Aether Chat navigation' })).toBeTruthy();
  });

  it('renders all seven nav labels with New selected and stubs for the rest', async () => {
    await renderApp();
    for (const n of ['New', 'Search', 'Projects', 'Artifacts', 'Scheduled', 'Design', 'Customize']) {
      expect(screen.getByText(n)).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'New' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByText('Not built yet - arrives in a later slice')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Search' }).getAttribute('aria-current')).toBe('page');
  });

  it('keeps the ChatPane mounted (hidden) while a stub is open and shows it again after', async () => {
    await renderApp();
    expect(mounts.mount).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Design' }));
    expect(mounts.mount).toBe(1);
    expect(mounts.unmount).toBe(0);
    expect(pane().parentElement!.style.display).toBe('none');
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(pane().parentElement!.style.display).not.toBe('none');
    expect(mounts.mount).toBe(1);
  });

  it('lists pinned folders and selects one on click', async () => {
    await renderApp();
    expect(screen.getByRole('button', { name: 'alpha' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'beta' }));
    expect(pane().textContent).toContain('chat:p2');
    expect(screen.getByRole('button', { name: 'beta' }).getAttribute('aria-current')).toBe('page');
  });

  it('pins a folder and shows duplicate / unavailable messages', async () => {
    const results: AddResult[] = [
      { ok: true, project: { id: 'p3', name: 'gamma' } },
      { ok: false, reason: 'duplicate' },
      { ok: false, reason: 'unavailable' },
      { ok: false, reason: 'canceled' },
    ];
    gui.projects.add.mockImplementation(async () => results.shift());
    await renderApp();
    const pin = screen.getByRole('button', { name: 'Pin folder' });
    await act(async () => fireEvent.click(pin));
    expect(screen.getByRole('button', { name: 'gamma' })).toBeTruthy();
    await act(async () => fireEvent.click(pin));
    expect(screen.getByRole('alert').textContent).toBe('That folder is already pinned');
    await act(async () => fireEvent.click(pin));
    expect(screen.getByRole('alert').textContent).toBe('Folder storage is not available this run');
    await act(async () => fireEvent.click(pin));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

  it('switching away from an idle chat stops it, unmounts its pane and never asks', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    await renderApp();
    click('alpha');
    report('p1', { hasSent: true });
    click('beta');
    expect(gui.stop).toHaveBeenCalledWith('p1');
    expect(paneOf('p1')).toBeUndefined();
    expect(pane().textContent).toContain('chat:p2');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('returning resumes only a chat that had sent a turn; New always resumes', async () => {
    await renderApp();
    expect(paneOf('new')!.getAttribute('data-resume')).toBe('true');
    click('alpha');
    report('p1', { hasSent: true });
    click('beta');
    report('p2', { hasSent: false });
    click('alpha');
    expect(paneOf('p1')!.getAttribute('data-resume')).toBe('true');
    expect(paneOf('p2')).toBeUndefined(); // never used: stopped on the switch
    click('beta');
    expect(paneOf('p2')!.getAttribute('data-resume')).toBe('false');
    click('New');
    expect(paneOf('new')!.getAttribute('data-resume')).toBe('true'); // New, even though it never sent a turn
  });

  it.each(['working', 'waiting'] as const)('switching away from a %s chat keeps it running, hidden, and switching back reuses the pane', async (state) => {
    await renderApp();
    click('alpha');
    report('p1', { state, hasSent: true });
    const mountedBefore = mounts.mount;
    click('beta');
    expect(gui.stop).not.toHaveBeenCalledWith('p1');
    expect(paneOf('p1')!.getAttribute('data-active')).toBe('false');
    expect(paneOf('p1')!.style.display).toBe('none');
    click('alpha');
    expect(pane().getAttribute('data-key')).toBe('p1');
    expect(mounts.mount).toBe(mountedBefore + 1); // only beta mounted; alpha's pane was reused
    expect(gui.stop).not.toHaveBeenCalledWith('p1');
  });

  it('with auto-stop off an idle chat that has sent a turn is not stopped; one that has not is', async () => {
    await renderApp();
    click('alpha');
    report('p1', { trusted: false, hasSent: true });
    click('beta');
    expect(gui.stop).not.toHaveBeenCalledWith('p1');
    expect(paneOf('p1')).toBeTruthy();
    report('p2', { trusted: false, hasSent: false });
    click('alpha');
    expect(gui.stop).toHaveBeenCalledWith('p2');
    expect(paneOf('p2')).toBeUndefined();
  });

  it("a chat's mode survives an idle stop and return", async () => {
    await renderApp();
    click('alpha');
    act(() => reportMode.get('p1')!('plan'));
    expect(paneOf('p1')!.getAttribute('data-mode')).toBe('plan');
    report('p1', { hasSent: true });
    click('beta');
    expect(paneOf('p1')).toBeUndefined();
    click('alpha');
    expect(paneOf('p1')!.getAttribute('data-mode')).toBe('plan');
    expect(paneOf('p2')).toBeUndefined();
  });

  it('does nothing when clicking the already-open chat', async () => {
    await renderApp();
    report('new', { state: 'working' });
    click('New');
    expect(gui.stop).not.toHaveBeenCalled();
    expect(mounts.mount).toBe(1);
  });

  it('unpinning an idle chat stops it silently', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    gui.projects.remove.mockResolvedValue(true);
    await renderApp();
    click('alpha');
    report('p1', { hasSent: true });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove alpha' })));
    expect(confirm).not.toHaveBeenCalled();
    expect(gui.projects.remove).toHaveBeenCalledWith('p1');
    expect(gui.stop).toHaveBeenCalledWith('p1');
    expect(paneOf('p1')).toBeUndefined();
  });

  it('unpinning a busy chat asks first and respects Cancel', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    gui.projects.remove.mockResolvedValue(true);
    await renderApp();
    click('alpha');
    report('p1', { state: 'working', hasSent: true });
    click('beta'); // alpha keeps running in the background
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove alpha' })));
    expect(confirm).toHaveBeenCalledWith('This chat is working. Remove it anyway? Its Claude will stop.');
    expect(gui.projects.remove).not.toHaveBeenCalled();
    expect(gui.stop).not.toHaveBeenCalledWith('p1');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove alpha' })));
    expect(gui.projects.remove).toHaveBeenCalledWith('p1');
    expect(gui.stop).toHaveBeenCalledWith('p1');
    expect(paneOf('p1')).toBeUndefined();
  });

  it('removing the open project goes to New', async () => {
    gui.projects.remove.mockResolvedValue(true);
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove alpha' })));
    expect(gui.projects.remove).toHaveBeenCalledWith('p1');
    expect(screen.queryByRole('button', { name: 'alpha' })).toBeNull();
    expect(pane().textContent).toContain('chat:null');
  });

  const dots = () => screen.queryAllByRole('img').map((e) => e.getAttribute('aria-label'));

  it('shows working, needs you and reply ready dots after the chat names', async () => {
    await renderApp();
    click('alpha');
    report('p1', { state: 'working', hasSent: true });
    expect(dots()).toEqual(['working']);
    report('p1', { state: 'waiting', hasSent: true });
    expect(dots()).toEqual(['needs you']);
    click('beta');
    report('p1', { state: 'idle', hasSent: true }); // back to idle but not settled: no mark, not stopped
    expect(dots()).toEqual([]);
    expect(gui.stop).not.toHaveBeenCalledWith('p1');
    report('p1', { state: 'idle', hasSent: true, settled: true });
    expect(dots()).toEqual(['reply ready']);
  });

  it('a background chat stops itself only once settled, marks reply ready, and the mark clears when opened', async () => {
    await renderApp();
    click('alpha');
    report('p1', { state: 'working', hasSent: true });
    click('beta');
    report('p1', { state: 'idle', hasSent: true, settled: false }); // idle read only: the settle window may still be cancelled
    expect(gui.stop).not.toHaveBeenCalledWith('p1');
    expect(paneOf('p1')).toBeTruthy();
    report('p1', { state: 'idle', hasSent: true, settled: true });
    expect(gui.stop).toHaveBeenCalledWith('p1');
    expect(paneOf('p1')).toBeUndefined();
    expect(dots()).toEqual(['reply ready']);
    click('alpha');
    expect(dots()).toEqual([]);
    expect(paneOf('p1')!.getAttribute('data-resume')).toBe('true');
  });

  it('a waiting background chat shows needs you and is never stopped', async () => {
    await renderApp();
    click('alpha');
    report('p1', { state: 'waiting', hasSent: true });
    click('beta');
    report('p1', { state: 'waiting', hasSent: true, settled: true });
    expect(gui.stop).not.toHaveBeenCalledWith('p1');
    expect(dots()).toEqual(['needs you']);
  });

  it.each([
    ['an untrusted gate', () => report('p1', { trusted: false, hasSent: true, settled: true })],
    ['no reliable background marker', () => { flags.markerReliable = false; report('p1', { hasSent: true, settled: true }); }],
  ])('with %s nothing self-stops, and Stop chat ends the chat', async (_name, settle) => {
    await renderApp();
    click('alpha');
    report('p1', { state: 'working', hasSent: true });
    click('beta');
    settle();
    expect(gui.stop).not.toHaveBeenCalledWith('p1');
    expect(paneOf('p1')).toBeTruthy();
    fireEvent.click(screen.getByText('stop-chat:p1'));
    expect(gui.stop).toHaveBeenCalledWith('p1');
    expect(paneOf('p1')).toBeUndefined();
    expect(pane().textContent).toContain('chat:p2'); // the open chat is untouched
    click('alpha');
    expect(paneOf('p1')!.getAttribute('data-resume')).toBe('true');
  });

  it('Stop chat on the open New chat stops it and mounts a fresh pane instead of reusing the old one', async () => {
    await renderApp();
    report('new', { trusted: false, hasSent: true });
    const before = mounts.mount;
    fireEvent.click(screen.getByText('stop-chat:new'));
    expect(gui.stop).toHaveBeenCalledTimes(1);
    expect(gui.stop).toHaveBeenCalledWith('new');
    expect(mounts.mount).toBe(before + 1);
    expect(mounts.unmount).toBe(1);
    expect(pane().getAttribute('data-key')).toBe('new');
  });

  it('title strip window controls call the existing window api', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(win.minimize).toHaveBeenCalledTimes(1);
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it('outside Electron shows a notice and no window controls instead of crashing', async () => {
    delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
    await renderApp();
    expect(screen.getByText('Requires the Electron app')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});
