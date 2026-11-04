// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useAetherChoice } from './useAetherChoice';
import type { AetherChoiceState } from '../../shared/aetherChoice/ipc';

const STATE: AetherChoiceState = {
  claude: { readout: 'steady', tier: 'sonnet', effort: 'medium', reason: 'r', auto: true },
  terminal2: null,
};
type Out = ReturnType<typeof useAetherChoice>;
function Probe({ out }: { out: { v: Out | null } }) { out.v = useAetherChoice(); return null; }
function bridge(aetherChoice: unknown) { (window as unknown as { aetherElectron: unknown }).aetherElectron = { aetherChoice }; }
afterEach(() => { cleanup(); delete (window as { aetherElectron?: unknown }).aetherElectron; vi.restoreAllMocks(); });

describe('useAetherChoice', () => {
  it('is unavailable with no bridge', () => {
    const out = { v: null as Out | null };
    render(<Probe out={out} />);
    expect(out.v?.status).toBe('unavailable');
  });
  it('is unavailable when state() rejects', async () => {
    bridge({ state: vi.fn().mockRejectedValue(new Error('no handler')), onHalted: () => vi.fn() });
    const out = { v: null as Out | null };
    render(<Probe out={out} />);
    expect(out.v?.status).toBe('loading');
    await act(async () => {});
    expect(out.v?.status).toBe('unavailable');
  });
  it('is ready with the state, re-pulls on a halt push and on refresh', async () => {
    let push: (i: unknown) => void = () => {};
    const state = vi.fn().mockResolvedValue(STATE);
    bridge({ state, onHalted: (cb: (i: unknown) => void) => { push = cb; return vi.fn(); } });
    const out = { v: null as Out | null };
    render(<Probe out={out} />);
    await act(async () => {});
    expect(out.v?.status).toBe('ready');
    expect(out.v?.state).toEqual(STATE);
    expect(state).toHaveBeenCalledTimes(1);
    await act(async () => { push({}); });
    expect(state).toHaveBeenCalledTimes(2);
    await act(async () => { await out.v?.refresh(); });
    expect(state).toHaveBeenCalledTimes(3);
  });
  it('unsubscribes on unmount and ignores a late resolve', async () => {
    let resolve: (s: AetherChoiceState) => void = () => {};
    const unsub = vi.fn();
    bridge({ state: vi.fn(() => new Promise<AetherChoiceState>(r => { resolve = r; })), onHalted: () => unsub });
    const err = vi.spyOn(console, 'error');
    const out = { v: null as Out | null };
    const view = render(<Probe out={out} />);
    view.unmount();
    await act(async () => { resolve(STATE); });
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(out.v?.state).toBeNull();
    expect(err).not.toHaveBeenCalled();
  });
});
