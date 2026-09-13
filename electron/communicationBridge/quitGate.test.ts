import { describe, expect, it, vi } from 'vitest';
import { createCommunicationQuitGate } from './quitGate';

describe('communication quit gate', () => {
  it('re-observes after an explicit retry and never forces exit on its own', async () => {
    const dispose = vi.fn().mockResolvedValueOnce({ ok: false, code: 'SHUTDOWN_TIMEOUT' }).mockResolvedValue({ ok: true });
    const held = vi.fn().mockResolvedValue('retry'), quit = vi.fn();
    const gate = createCommunicationQuitGate(dispose, quit, held);
    gate({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(held).toHaveBeenCalledWith('SHUTDOWN_TIMEOUT');
  });
  it('accepts a separately confirmed forced exit without changing cleanup evidence', async () => {
    const result = { ok: false, code: 'CLEANUP_FAILED' }, quit = vi.fn();
    const gate = createCommunicationQuitGate(async () => result, quit, async () => 'force');
    gate({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    expect(result.ok).toBe(false);
    expect(gate({ preventDefault: vi.fn() })).toBe(true);
  });
  it('holds and deduplicates quit until cleanup confirms', async () => {
    let finish!: (value: { ok: boolean }) => void;
    const dispose = vi.fn(() => new Promise<{ ok: boolean }>(resolve => { finish = resolve; }));
    const quit = vi.fn(), event = { preventDefault: vi.fn() };
    const gate = createCommunicationQuitGate(dispose, quit);
    expect(gate(event)).toBe(false);
    expect(gate(event)).toBe(false);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    expect(quit).not.toHaveBeenCalled();
    finish({ ok: true });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    expect(gate(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
  });
  it.each(['failure', 'rejection'])('keeps ownership on %s', async kind => {
    const dispose = vi.fn(() => kind === 'failure' ? Promise.resolve({ ok: false }) : Promise.reject(new Error('cleanup')));
    const quit = vi.fn(), gate = createCommunicationQuitGate(dispose, quit);
    expect(gate({ preventDefault: vi.fn() })).toBe(false);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    expect(quit).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(gate({ preventDefault: vi.fn() })).toBe(false);
      expect(dispose).toHaveBeenCalledTimes(2);
    });
  });
});
