import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GuiApp } from './GuiApp';

const mounts = { mount: 0, unmount: 0 };
vi.mock('./ChatPane', async () => {
  const { useEffect } = await import('react');
  return {
    ChatPane: ({ projectId, onLiveChange }: { projectId: string | null; onLiveChange: (b: boolean) => void }) => {
      useEffect(() => {
        mounts.mount += 1;
        return () => {
          mounts.unmount += 1;
        };
      }, []);
      return (
        <div data-testid="chat-pane">
          chat:{String(projectId)}
          <button onClick={() => onLiveChange(true)}>go-live</button>
        </div>
      );
    },
  };
});

type AddResult = { ok: true; project: { id: string; name: string } } | { ok: false; reason: string };
const gui = {
  projects: { list: vi.fn(), add: vi.fn(), remove: vi.fn() },
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
  Object.values(win).forEach((f) => f.mockReset());
  Object.defineProperty(window, 'aetherElectron', { configurable: true, value: { gui, window: win } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { aetherElectron?: unknown }).aetherElectron;
});

const pane = () => screen.getByTestId('chat-pane');

describe('GuiApp shell', () => {
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

  it('asks before switching while live, and stays when cancelled', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderApp();
    fireEvent.click(screen.getByText('go-live'));
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
    expect(confirm).toHaveBeenCalledWith('End the current chat? Its Claude session will stop.');
    expect(pane().textContent).toContain('chat:null');
    expect(mounts.unmount).toBe(0);
  });

  it('switches when the confirm is accepted, and does not ask when not live', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('go-live'));
    fireEvent.click(screen.getByRole('button', { name: 'beta' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(pane().textContent).toContain('chat:p2');
  });

  it('does nothing when clicking the already-open chat', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderApp();
    fireEvent.click(screen.getByText('go-live'));
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(mounts.mount).toBe(1);
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
