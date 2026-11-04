// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseClear, parseSubmit, registerAetherChoiceIpc, type AetherChoiceRuntimeLike } from './aetherChoiceIpc';
import type { AetherChoiceSlotState } from '../../src/shared/aetherChoice/ipc';

const SLOT_STATE: AetherChoiceSlotState = { readout: 'steady', tier: 'sonnet', effort: 'medium', reason: 'default', auto: true };
const GOOD = { slot: 'claude', model: 'sonnet', effort: 'high' };

function setup(opts: { trusted?: boolean } = {}) {
  const runtime = {
    state: vi.fn((_slot: string): AetherChoiceSlotState | null => SLOT_STATE),
    submitPick: vi.fn((_slot: string, _pick: unknown): { rejected: string | null } => ({ rejected: null })),
    clearHalt: vi.fn((_slot: string) => undefined),
  };
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
  registerAetherChoiceIpc<unknown>(
    { handle: (c, h) => { handlers.set(c, h); } },
    runtime as unknown as AetherChoiceRuntimeLike,
    () => opts.trusted ?? true,
  );
  const call = (ch: string, ...args: unknown[]) => Promise.resolve().then(() => handlers.get(ch)!({}, ...args));
  const untouched = () => Object.values(runtime).every(f => f.mock.calls.length === 0);
  return { runtime, call, handlers, untouched };
}

const BAD_SUBMITS: Array<[string, unknown[]]> = [
  ['no args', []],
  ['two args', [GOOD, GOOD]],
  ['null', [null]],
  ['array', [[GOOD]]],
  ['string', ['claude']],
  ['missing effort', [{ slot: 'claude', model: 'sonnet' }]],
  ['extra reason', [{ ...GOOD, reason: 'x' }]],
  ['extra source', [{ ...GOOD, source: 'auto' }]],
  ['model fable', [{ ...GOOD, model: 'fable' }]],
  ['model Sonnet', [{ ...GOOD, model: 'Sonnet' }]],
  ['model trailing space', [{ ...GOOD, model: 'sonnet ' }]],
  ['model typed command', [{ ...GOOD, model: '/mo' + 'del' }]],
  ['effort top tier word', [{ ...GOOD, effort: 'ul' + 'tra' }]],
  ['effort MAX', [{ ...GOOD, effort: 'MAX' }]],
  ['effort number', [{ ...GOOD, effort: 5 }]],
  ['slot codex', [{ ...GOOD, slot: 'codex' }]],
  ['slot trailing space', [{ ...GOOD, slot: 'claude ' }]],
  ['slot array', [{ ...GOOD, slot: ['claude'] }]],
  ['own __proto__ key', [JSON.parse('{"__proto__":{},"slot":"claude","model":"sonnet","effort":"low"}')]],
];

const BAD_CLEARS: Array<[string, unknown[]]> = [
  ['slot codex', [{ slot: 'codex' }]],
  ['extra key', [{ slot: 'claude', extra: 1 }]],
  ['bare string', ['claude']],
  ['no args', []],
];

describe('registerAetherChoiceIpc', () => {
  it('registers exactly the three handle channels', () => {
    expect([...setup().handlers.keys()].sort()).toEqual(['aetherChoice:clear-halt', 'aetherChoice:state', 'aetherChoice:submit']);
  });

  it('rejects an untrusted sender on every channel without touching the runtime', async () => {
    const { call, untouched } = setup({ trusted: false });
    await expect(call('aetherChoice:state')).rejects.toThrow('NOT_AUTHORIZED');
    await expect(call('aetherChoice:submit', GOOD)).rejects.toThrow('NOT_AUTHORIZED');
    await expect(call('aetherChoice:clear-halt', { slot: 'claude' })).rejects.toThrow('NOT_AUTHORIZED');
    expect(untouched()).toBe(true);
  });

  it('state returns both slots, rejects an argument, and nulls only the slot whose runtime call throws', async () => {
    const { call, runtime } = setup();
    expect(await call('aetherChoice:state')).toEqual({ claude: SLOT_STATE, terminal2: SLOT_STATE });
    await expect(call('aetherChoice:state', 1)).rejects.toThrow('INVALID_INPUT');
    runtime.state.mockImplementation(slot => { if (slot === 'claude') throw new Error('boom'); return SLOT_STATE; });
    expect(await call('aetherChoice:state')).toEqual({ claude: null, terminal2: SLOT_STATE });
  });

  it('submit forwards exactly the pick keys and maps the outcome to a fixed enum', async () => {
    const { call, runtime } = setup();
    expect(await call('aetherChoice:submit', GOOD)).toEqual({ ok: true });
    expect(runtime.submitPick).toHaveBeenCalledTimes(1);
    expect(runtime.submitPick).toHaveBeenCalledWith('claude', { model: 'sonnet', effort: 'high' });
    expect(Object.keys(runtime.submitPick.mock.calls[0][1] as object)).toEqual(['model', 'effort']);
    runtime.submitPick.mockReturnValueOnce({ rejected: 'pending manual pick wins' });
    const rejected = await call('aetherChoice:submit', GOOD);
    expect(rejected).toEqual({ ok: false });
    expect(JSON.stringify(rejected)).not.toContain('pending');
    runtime.submitPick.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(await call('aetherChoice:submit', GOOD)).toEqual({ ok: false });
  });

  it.each(BAD_SUBMITS)('submit rejects %s with INVALID_INPUT and no runtime call', async (_name, args) => {
    const { call, untouched } = setup();
    await expect(call('aetherChoice:submit', ...args)).rejects.toThrow('INVALID_INPUT');
    expect(untouched()).toBe(true);
  });

  it('clear-halt forwards a valid slot, swallows a runtime throw, and resolves undefined', async () => {
    const { call, runtime } = setup();
    expect(await call('aetherChoice:clear-halt', { slot: 'terminal2' })).toBeUndefined();
    expect(runtime.clearHalt).toHaveBeenCalledTimes(1);
    expect(runtime.clearHalt).toHaveBeenCalledWith('terminal2');
    runtime.clearHalt.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(await call('aetherChoice:clear-halt', { slot: 'claude' })).toBeUndefined();
  });

  it.each(BAD_CLEARS)('clear-halt rejects %s with INVALID_INPUT and no runtime call', async (_name, args) => {
    const { call, untouched } = setup();
    await expect(call('aetherChoice:clear-halt', ...args)).rejects.toThrow('INVALID_INPUT');
    expect(untouched()).toBe(true);
  });
});

describe('parseSubmit / parseClear', () => {
  it('accept only the exact shapes', () => {
    expect(parseSubmit([GOOD])).toEqual(GOOD);
    expect(parseClear([{ slot: 'terminal2' }])).toEqual({ slot: 'terminal2' });
    for (const [, args] of BAD_SUBMITS) expect(parseSubmit(args)).toBeNull();
    for (const [, args] of BAD_CLEARS) expect(parseClear(args)).toBeNull();
  });
});

describe('aetherChoiceIpc.ts source', () => {
  it('has no electron import, port write, console or timer', () => {
    const src = readFileSync(new URL('./aetherChoiceIpc.ts', import.meta.url), 'utf8');
    const specifiers = [...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
    expect(specifiers.some(s => /^(node:)?electron$/.test(s))).toBe(false);
    expect(src).not.toContain('.write(');
    expect(src).not.toContain('console');
    expect(src).not.toContain('setTimeout');
  });
});
