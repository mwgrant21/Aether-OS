// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureCollectorDb } from './collectorDb.fixture';
import { createDashboardsStore } from './dashboardsStore';
import type { DashboardSpec } from '../../src/shared/dashboards/spec';

const now = Date.now();
const starter: DashboardSpec = { version: 1, id: 'starter', title: 'Starter', panels: [{ id: 'n', title: 'N', type: 'table', range: '7d', sql: 'SELECT COUNT(*) AS n FROM usage_events' }] };
const dirs: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aether-boards-store-'));
  dirs.push(root);
  const dir = join(root, 'dashboards');
  return { dir, store: createDashboardsStore({ dir, dbPath: createFixtureCollectorDb(now), starters: [starter], now: () => now, debounceMs: 20 }) };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('dashboardsStore', () => {
  it('seeds starters once and never overwrites or re-seeds', () => {
    const { dir, store } = setup();
    store.seedStarters();
    expect(store.list().boards.map((b) => b.id)).toEqual(['starter']);
    writeFileSync(join(dir, 'starter.json'), JSON.stringify({ ...starter, title: 'Edited' }));
    store.seedStarters();
    expect(store.list().boards[0].title).toBe('Edited');
    unlinkSync(join(dir, 'starter.json'));
    store.seedStarters();
    expect(store.list().boards).toEqual([]);
  });

  it('lists an invalid board with its first error, without hiding valid ones (Review Focus 3)', () => {
    const { dir, store } = setup();
    store.seedStarters();
    writeFileSync(join(dir, 'broken.json'), '{ nope');
    writeFileSync(join(dir, 'renamed.json'), JSON.stringify({ ...starter, id: 'other' }));
    const boards = store.list().boards;
    expect(boards.map((b) => [b.id, b.error === null])).toEqual([['broken', false], ['renamed', false], ['starter', true]]);
    expect(boards.find((b) => b.id === 'renamed')?.error).toContain('does not match');
  });

  it('an unreadable or invalid board error carries neither the dir path nor file content', async () => {
    const { dir, store } = setup();
    store.seedStarters();
    writeFileSync(join(dir, 'broken.json'), '{ SECRET-CONTENT-123');
    // A directory named like a board makes readFileSync fail (EISDIR) with a message containing the full path.
    mkdirSync(join(dir, 'unreadable.json'));
    const listing = store.list();
    const broken = listing.boards.find((b) => b.id === 'broken')?.error;
    const unreadable = listing.boards.find((b) => b.id === 'unreadable')?.error;
    expect(broken).toBe('invalid JSON');
    expect(unreadable).toBe('could not read (EISDIR)');
    const payload = JSON.stringify([listing, await store.refresh('broken'), await store.refresh('unreadable')]);
    expect(payload).not.toContain('SECRET-CONTENT');
    expect(payload).not.toContain(dir);
    expect(payload).not.toContain(dir.replace(/\\/g, '\\\\'));
  });

  it('refresh returns one result per panel, and one failing panel does not fail the rest', async () => {
    const { dir, store } = setup();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'two.json'), JSON.stringify({ ...starter, id: 'two', panels: [starter.panels[0], { ...starter.panels[0], id: 'bad', sql: 'SELECT nope FROM usage_events' }] }));
    const r = await store.refresh('two');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.panels.map((p) => [p.panelId, p.error === null])).toEqual([['n', true], ['bad', false]]);
  });

  it('refresh and remove refuse ids that are not board ids', async () => {
    const { store } = setup();
    expect(await store.refresh('../x')).toEqual({ ok: false, error: 'Unknown board.' });
    expect(store.remove('../x')).toEqual({ ok: false, error: 'Unknown board.' });
  });

  it('remove deletes the board file', () => {
    const { dir, store } = setup();
    store.seedStarters();
    expect(store.remove('starter')).toEqual({ ok: true });
    expect(existsSync(join(dir, 'starter.json'))).toBe(false);
  });

  it('remove of a missing board reports the errno code, not the path', () => {
    const { dir, store } = setup();
    store.seedStarters();
    const r = store.remove('absent');
    expect(r).toEqual({ ok: false, error: 'could not delete (ENOENT)' });
    expect(JSON.stringify(r)).not.toContain(dir);
  });

  it('the watcher survives its folder being removed, and stop stays safe', async () => {
    const { dir, store } = setup();
    store.seedStarters();
    const stop = store.startWatching(() => {});
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(() => stop()).not.toThrow();
    expect(() => stop()).not.toThrow();
  });

  it('nothing it returns contains an absolute path', async () => {
    const { dir, store } = setup();
    store.seedStarters();
    const payload = JSON.stringify([store.list(), await store.refresh('starter')]);
    expect(payload).not.toContain(dir);
    expect(payload).not.toMatch(/[A-Za-z]:\\\\|\/Users\/|\/home\//);
  });

  it('watching reports changed board ids, debounced', async () => {
    const { dir, store } = setup();
    store.seedStarters();
    const seen: string[][] = [];
    const stop = store.startWatching((ids) => seen.push(ids));
    writeFileSync(join(dir, 'starter.json'), readFileSync(join(dir, 'starter.json'), 'utf8'));
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(seen.flat()).toContain('starter');
  });
});
