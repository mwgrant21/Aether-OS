import { describe, expect, it, vi } from 'vitest';
import { createCommunicationQuitGate } from './quitGate';

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
describe('communication quit gate', () => {
  it('holds and deduplicates quit until cleanup confirms', async () => {
    let finish!: (value: { ok: boolean }) => void;
    const dispose = vi.fn(() => new Promise<{ ok: boolean }>(resolve => { finish = resolve; }));
    const quit = vi.fn(), event = { preventDefault: vi.fn() };
    const gate = createCommunicationQuitGate(dispose, quit);
    expect(gate(event)).toBe(false);
    expect(gate(event)).toBe(false);
    await flush();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    finish({ ok: true });
    await flush();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(gate(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
  });
  it.each(['failure', 'rejection'])('keeps ownership on %s', async kind => {
    const dispose = vi.fn(() => kind === 'failure' ? Promise.resolve({ ok: false }) : Promise.reject(new Error('cleanup')));
    const quit = vi.fn(), gate = createCommunicationQuitGate(dispose, quit);
    expect(gate({ preventDefault: vi.fn() })).toBe(false);
    await flush();
    expect(quit).not.toHaveBeenCalled();
    expect(gate({ preventDefault: vi.fn() })).toBe(false);
    await flush();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
