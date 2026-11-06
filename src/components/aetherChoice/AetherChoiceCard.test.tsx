// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AetherChoiceCard } from './AetherChoiceCard';
import { LAUNCH_EFFORTS, MODEL_ALIASES } from '../../shared/aetherChoice/types';
import type { AetherChoiceSlotState, AetherChoiceState } from '../../shared/aetherChoice/ipc';

function slot(patch: Partial<AetherChoiceSlotState> = {}): AetherChoiceSlotState {
  return { readout: 'steady', tier: 'sonnet', effort: 'medium', reason: 'r', auto: true, ...patch };
}
function mk(claude: AetherChoiceSlotState | null, terminal2: AetherChoiceSlotState | null = null): AetherChoiceState {
  return { claude, terminal2 };
}
function bridge(over: Record<string, unknown> = {}, state: AetherChoiceState = mk(slot(), slot())) {
  const b = {
    state: vi.fn().mockResolvedValue(state),
    submit: vi.fn().mockResolvedValue({ ok: true }),
    clearHalt: vi.fn().mockResolvedValue(undefined),
    onHalted: vi.fn(() => vi.fn()),
    ...over,
  };
  (window as unknown as { aetherElectron: unknown }).aetherElectron = { aetherChoice: b };
  return b;
}
async function mount() {
  const view = render(<AetherChoiceCard />);
  await act(async () => {});
  return view;
}
afterEach(() => { cleanup(); delete (window as { aetherElectron?: unknown }).aetherElectron; vi.restoreAllMocks(); });

describe('AetherChoiceCard', () => {
  it('renders nothing with no bridge, a rejected state, or while loading', async () => {
    const a = render(<AetherChoiceCard />);
    expect(a.container.innerHTML).toBe('');
    a.unmount();
    bridge({ state: vi.fn().mockRejectedValue(new Error('x')) });
    const b = render(<AetherChoiceCard />);
    expect(b.container.innerHTML).toBe('');
    await act(async () => {});
    expect(b.container.innerHTML).toBe('');
    b.unmount();
    bridge({ state: vi.fn(() => new Promise(() => {})) });
    const c = render(<AetherChoiceCard />);
    await act(async () => {});
    expect(c.container.innerHTML).toBe('');
  });

  it('shows both slots with their readout and halted text; a null slot is skipped', async () => {
    bridge({}, mk(slot({ readout: 'notApplied', haltedText: 'halted here' }), slot({ readout: 'queued', target: { tier: 'sonnet', effort: 'high' } })));
    const { container } = await mount();
    const states = [...container.querySelectorAll('[data-state]')].map(e => e.getAttribute('data-state'));
    expect(states).toEqual(['notApplied', 'queued']);
    expect(screen.getByText('halted here')).toBeTruthy();
    expect(screen.getByText('TERMINAL ALPHA')).toBeTruthy();
    expect(screen.getByText('TERMINAL BETA')).toBeTruthy();
    cleanup();
    bridge({}, mk(slot(), null));
    const again = await mount();
    expect(again.container.querySelectorAll('[data-state]').length).toBe(1);
    expect(screen.queryByText('TERMINAL BETA')).toBeNull();
  });

  it('offers CLEAR HALT only for notApplied and clears then re-pulls', async () => {
    const b = bridge({}, mk(slot({ readout: 'steady' }), slot({ readout: 'queued' })));
    await mount();
    expect(screen.queryByText('CLEAR HALT')).toBeNull();
    cleanup();
    const b2 = bridge({}, mk(slot({ readout: 'notApplied' }), null));
    await mount();
    expect(b.clearHalt).not.toHaveBeenCalled();
    const before = b2.state.mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByText('CLEAR HALT')); });
    expect(b2.clearHalt).toHaveBeenCalledTimes(1);
    expect(b2.clearHalt).toHaveBeenCalledWith({ slot: 'claude' });
    expect(b2.state.mock.calls.length).toBe(before + 1);
  });

  it('submits exactly slot, model and effort; shows a failure for ok:false and a rejection', async () => {
    const b = bridge();
    await mount();
    const t2 = () => screen.getAllByText('SUBMIT PICK')[1];
    const within = (text: string) => screen.getAllByText(text)[1];
    fireEvent.click(within('opus'));
    fireEvent.click(within('high'));
    await act(async () => { fireEvent.click(t2()); });
    expect(b.submit).toHaveBeenCalledTimes(1);
    expect(b.submit).toHaveBeenCalledWith({ slot: 'terminal2', model: 'opus', effort: 'high' });
    expect(Object.keys(b.submit.mock.calls[0][0]).sort()).toEqual(['effort', 'model', 'slot']);
    expect(screen.queryByText('Pick not accepted.')).toBeNull();

    b.submit.mockResolvedValueOnce({ ok: false });
    await act(async () => { fireEvent.click(t2()); });
    expect(screen.getByText('Pick not accepted.')).toBeTruthy();

    b.submit.mockResolvedValueOnce({ ok: true });
    await act(async () => { fireEvent.click(t2()); });
    expect(screen.queryByText('Pick not accepted.')).toBeNull();
    b.submit.mockRejectedValueOnce(new Error('engine said no'));
    await act(async () => { fireEvent.click(t2()); });
    expect(screen.getByText('Pick not accepted.')).toBeTruthy();
    expect(screen.queryByText(/engine said no/)).toBeNull();
  });

  it('disables buttons while pending and a double click submits once', async () => {
    let finish: (r: { ok: boolean }) => void = () => {};
    const b = bridge({ submit: vi.fn(() => new Promise(r => { finish = r; })) });
    await mount();
    const btn = screen.getAllByText('SUBMIT PICK')[0];
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn); });
    expect(b.submit).toHaveBeenCalledTimes(1);
    expect((screen.getAllByText('SUBMIT PICK')[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('REFRESH') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish({ ok: true }); });
    expect((screen.getAllByText('SUBMIT PICK')[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers exactly the model and effort constants and no banned chip', async () => {
    bridge({}, mk(slot(), null));
    await mount();
    const texts = screen.getAllByRole('button').map(b => b.textContent ?? '');
    expect(texts.filter(t => (MODEL_ALIASES as readonly string[]).includes(t))).toEqual([...MODEL_ALIASES]);
    expect(texts.filter(t => (LAUNCH_EFFORTS as readonly string[]).includes(t))).toEqual([...LAUNCH_EFFORTS]);
    for (const banned of ['fable', 'ul' + 'tra', '/mo' + 'del']) {
      expect(texts.some(t => t.includes(banned))).toBe(false);
    }
    expect(screen.getByRole('button', { name: 'sonnet' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'medium' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('never renders the halt push payload', async () => {
    let push: (i: unknown) => void = () => {};
    bridge({ onHalted: (cb: (i: unknown) => void) => { push = cb; return vi.fn(); } });
    const { container } = await mount();
    await act(async () => { push({ threadId: 'SENTINEL-THREAD-123', wanted: { tier: 'opus' }, actual: null }); });
    expect(container.textContent).not.toContain('SENTINEL-THREAD-123');
  });
});
