// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { registerGuiIpc } from './guiIpc';
import { GUI_CHANNELS as C } from './guiTypes';

const DIR = 'D:\secret\proj';
type H = (e: unknown, ...a: unknown[]) => unknown;

function setup(opts: { trusted?: boolean; store?: 'ok' | 'none'; picked?: string | null } = {}) {
  const handlers = new Map<string, H>();
  const ons = new Map<string, H>();
  const ipc = { handle: (c: string, h: H) => void handlers.set(c, h), on: (c: string, h: H) => void ons.set(c, h) };
  const store = {
    list: vi.fn(() => [{ id: 'i1', name: 'proj' }]),
    add: vi.fn(async () => ({ ok: true as const, project: { id: 'i1', name: 'proj' } })),
    remove: vi.fn(async () => true),
    pathOf: vi.fn(() => DIR),
  };
  const session = {
    start: vi.fn(() => ({ ok: true as const, reused: false })),
    write: vi.fn(() => true), resize: vi.fn(), submit: vi.fn(() => true), live: vi.fn(() => true), dispose: vi.fn(), stop: vi.fn(),
  };
  const pickFolder = vi.fn(async () => (opts.picked === undefined ? DIR : opts.picked));
  const getStore = vi.fn(async () => (opts.store === 'none' ? null : (store as never)));
  const isTrusted = vi.fn(() => opts.trusted !== false);
  registerGuiIpc(ipc as never, { isTrusted, getStore, session: session as never, pickFolder });
  return { handlers, ons, store, session, pickFolder, getStore, isTrusted };
}
const ev = {};

describe('registerGuiIpc', () => {
  it('registers every renderer-to-main channel', () => {
    const s = setup();
    expect([...s.handlers.keys()].sort()).toEqual([C.projectsList, C.projectsAdd, C.projectsRemove, C.start, C.submit].sort());
    expect([...s.ons.keys()].sort()).toEqual([C.write, C.resize, C.stop].sort());
  });

  it('refuses an untrusted sender on every channel and touches nothing', async () => {
    const s = setup({ trusted: false });
    expect(await s.handlers.get(C.projectsList)!(ev)).toEqual([]);
    expect(await s.handlers.get(C.projectsAdd)!(ev)).toEqual({ ok: false, reason: 'canceled' });
    expect(await s.handlers.get(C.projectsRemove)!(ev, 'i1')).toBe(false);
    expect(await s.handlers.get(C.start)!(ev, { projectId: null, cols: 80, rows: 24 })).toEqual({ ok: false, reason: 'bad-request' });
    expect(await s.handlers.get(C.submit)!(ev, 'k1', 'hi')).toBe(false);
    s.ons.get(C.write)!(ev, 'k1', 'x');
    s.ons.get(C.resize)!(ev, 'k1', { cols: 80, rows: 24 });
    s.ons.get(C.stop)!(ev, 'k1');
    expect(s.getStore).not.toHaveBeenCalled();
    expect(s.pickFolder).not.toHaveBeenCalled();
    expect(s.store.list).not.toHaveBeenCalled();
    expect(s.store.add).not.toHaveBeenCalled();
    expect(s.store.remove).not.toHaveBeenCalled();
    for (const f of Object.values(s.session)) expect(f).not.toHaveBeenCalled();
  });

  it('list returns the store list; add with a null pick is canceled and does not add', async () => {
    const s = setup({ picked: null });
    expect(await s.handlers.get(C.projectsList)!(ev)).toEqual([{ id: 'i1', name: 'proj' }]);
    expect(await s.handlers.get(C.projectsAdd)!(ev)).toEqual({ ok: false, reason: 'canceled' });
    expect(s.store.add).not.toHaveBeenCalled();
  });

  it('add forwards the picked folder to the store without echoing the path', async () => {
    const s = setup();
    const r = await s.handlers.get(C.projectsAdd)!(ev);
    expect(s.store.add).toHaveBeenCalledWith(DIR);
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('fails closed when the private dir is not confirmed', async () => {
    const s = setup({ store: 'none' });
    expect(await s.handlers.get(C.projectsList)!(ev)).toEqual([]);
    expect(await s.handlers.get(C.projectsAdd)!(ev)).toEqual({ ok: false, reason: 'unavailable' });
    expect(s.pickFolder).not.toHaveBeenCalled();
    expect(await s.handlers.get(C.projectsRemove)!(ev, 'i1')).toBe(false);
    expect(await s.handlers.get(C.start)!(ev, { projectId: 'i1', cols: 80, rows: 24 })).toEqual({ ok: false, reason: 'unavailable' });
    expect(s.session.start).not.toHaveBeenCalled();
    expect(await s.handlers.get(C.start)!(ev, { projectId: null, cols: 80, rows: 24 })).toEqual({ ok: false, reason: 'unavailable' });
    expect(s.session.start).not.toHaveBeenCalled();
  });

  it('a trusted start with no store stops the session, for a project and for the New chat', async () => {
    const s = setup({ store: 'none' });
    expect(await s.handlers.get(C.start)!(ev, { projectId: 'i1', cols: 80, rows: 24 })).toEqual({ ok: false, reason: 'unavailable' });
    expect(s.session.stop).toHaveBeenCalledTimes(1);
    expect(s.session.stop).toHaveBeenLastCalledWith('i1');
    expect(s.session.start).not.toHaveBeenCalled();
    expect(await s.handlers.get(C.start)!(ev, { projectId: null, cols: 80, rows: 24 })).toEqual({ ok: false, reason: 'unavailable' });
    expect(s.session.stop).toHaveBeenCalledTimes(2);
    expect(s.session.stop).toHaveBeenLastCalledWith('new');
    expect(s.session.start).not.toHaveBeenCalled();
  });

  it('a New chat start awaits getStore before session.start', async () => {
    const s = setup();
    const order: string[] = [];
    s.getStore.mockImplementation((async () => { await Promise.resolve(); order.push('getStore'); return s.store as never; }) as never);
    s.session.start.mockImplementation((() => { order.push('start'); return { ok: true as const, reused: false }; }) as never);
    await s.handlers.get(C.start)!(ev, { projectId: null, cols: 80, rows: 24 });
    expect(order).toEqual(['getStore', 'start']);
  });

  it('remove validates the id type; start/submit/write/resize forward raw payloads', async () => {
    const s = setup();
    expect(await s.handlers.get(C.projectsRemove)!(ev, 5)).toBe(false);
    expect(s.store.remove).not.toHaveBeenCalled();
    expect(await s.handlers.get(C.projectsRemove)!(ev, 'i1')).toBe(true);
    const req = { projectId: 'i1', cols: 80, rows: 24 };
    await s.handlers.get(C.start)!(ev, req);
    expect(s.session.start).toHaveBeenCalledWith(req);
    await s.handlers.get(C.submit)!(ev, 'k1', 'hello');
    expect(s.session.submit).toHaveBeenCalledWith('k1', 'hello');
    s.ons.get(C.write)!(ev, 'k1', 'k');
    expect(s.session.write).toHaveBeenCalledWith('k1', 'k');
    s.ons.get(C.resize)!(ev, 'k1', { cols: 90, rows: 30 });
    expect(s.session.resize).toHaveBeenCalledWith('k1', 90, 30);
    s.ons.get(C.resize)!(ev, 'k1', 'junk');
    expect(s.session.resize).toHaveBeenLastCalledWith('k1', undefined, undefined);
  });

  it('stop passes a valid key through and ignores an untrusted sender', () => {
    const s = setup();
    s.ons.get(C.stop)!(ev, 'k1');
    expect(s.session.stop).toHaveBeenCalledWith('k1');
    const u = setup({ trusted: false });
    u.ons.get(C.stop)!(ev, 'k1');
    expect(u.session.stop).not.toHaveBeenCalled();
  });

  it('every keyed channel drops an invalid key (non-string, empty, over 64 chars) before touching the session', async () => {
    const s = setup();
    for (const bad of [undefined, 5, null, {}, '', 'x'.repeat(65)]) {
      s.ons.get(C.stop)!(ev, bad);
      s.ons.get(C.write)!(ev, bad, 'x');
      s.ons.get(C.resize)!(ev, bad, { cols: 80, rows: 24 });
      expect(await s.handlers.get(C.submit)!(ev, bad, 'x')).toBe(false);
    }
    for (const f of [s.session.stop, s.session.write, s.session.resize, s.session.submit]) expect(f).not.toHaveBeenCalled();
    s.ons.get(C.stop)!(ev, 'x'.repeat(64));
    expect(s.session.stop).toHaveBeenCalledTimes(1);
  });
});
