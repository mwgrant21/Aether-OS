// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUI_MAX_PROJECTS } from './guiTypes';
import { GUI_PROJECTS_FILE, MAX_GUI_PROJECTS_BYTES, createProjectsStore } from './projectsStore';

const win32 = process.platform === 'win32';
const ID = '123e4567-e89b-42d3-a456-426614174000';
let dir: string;
let work: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guiprojects-'));
  work = join(dir, 'work');
  mkdirSync(work);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const yes = () => true;
const file = () => join(dir, GUI_PROJECTS_FILE);
const store = (isDirectory: (p: string) => boolean = yes) => createProjectsStore({ dir, isDirectory });
const writeRaw = (projects: unknown, v: unknown = 1) => writeFileSync(file(), JSON.stringify({ v, projects }));
const entry = (id: string, path: string) => ({ id, path, addedAt: 1 });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('projectsStore', () => {
  it('round-trips across two instances and keeps the path in main only', async () => {
    const r = await store().add(work);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = store();
    expect(b.list()).toEqual([{ id: r.project.id, name: 'work' }]);
    expect(b.pathOf(r.project.id)).toBe(work);
  });

  it('list() and add results carry no path', async () => {
    const s = store();
    const r = await s.add(work);
    expect(JSON.stringify(r)).not.toContain(dir);
    expect(JSON.stringify(s.list())).not.toContain(dir);
  });

  it('reads a corrupt, oversize or wrong-version file as empty and a later add still works', async () => {
    const bodies = [
      '{not json',
      JSON.stringify({ v: 2, projects: [entry(ID, work)] }),
      'x'.repeat(MAX_GUI_PROJECTS_BYTES + 1),
    ];
    for (const body of bodies) {
      writeFileSync(file(), body);
      const s = store();
      expect(s.list()).toEqual([]);
      expect((await s.add(work)).ok).toBe(true);
    }
  });

  it('drops bad entries and keeps good ones', () => {
    writeRaw([
      entry(ID, work),
      entry('not-a-uuid', work),
      entry('__proto__', work),
      entry(uuid(1), 'relative/dir'),
      entry(uuid(2), `${work}\0x`),
      { id: uuid(3), path: work, addedAt: 'x' },
      { id: uuid(4), path: 5, addedAt: 1 },
      entry(uuid(5), join(dir, 'a'.repeat(1100))),
      null,
    ]);
    expect(store().list()).toEqual([{ id: ID, name: 'work' }]);
  });

  it('rejects a duplicate folder', async () => {
    const s = store();
    expect((await s.add(work)).ok).toBe(true);
    expect(await s.add(work)).toEqual({ ok: false, reason: 'duplicate' });
  });

  it.runIf(win32)('treats a different-case path as a duplicate on win32', async () => {
    const s = store();
    await s.add(work);
    expect(await s.add(work.toUpperCase())).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('rejects a relative path and a non-directory without storing them', async () => {
    const s = store((p) => p !== join(dir, 'afile'));
    expect(await s.add('relative/dir')).toEqual({ ok: false, reason: 'not-a-directory' });
    expect(await s.add(join(dir, 'afile'))).toEqual({ ok: false, reason: 'not-a-directory' });
    expect(s.list()).toEqual([]);
  });

  it.runIf(win32)('rejects UNC and extended paths on add without statting them', async () => {
    const spy = vi.fn(() => true);
    const s = store(spy);
    for (const p of ['\\\\host\\share\\x', '//host/share/x', '\\\\?\\C:\\x', '\\\\.\\C:\\x']) {
      expect(await s.add(p)).toEqual({ ok: false, reason: 'not-a-directory' });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it.runIf(win32)('drops UNC and extended paths found in the file on load', () => {
    writeRaw([
      entry(uuid(1), '\\\\host\\share\\x'),
      entry(uuid(2), '//host/share/x'),
      entry(uuid(3), '\\\\?\\C:\\x'),
      entry(ID, work),
    ]);
    expect(store().list()).toEqual([{ id: ID, name: 'work' }]);
  });

  it('pathOf answers only for UUID-shaped ids present in the store', async () => {
    const s = store();
    const r = await s.add(work);
    for (const bad of ['constructor', '__proto__', 'toString', 'not-a-uuid', uuid(9)]) {
      expect(s.pathOf(bad)).toBeUndefined();
    }
    expect(r.ok && s.pathOf(r.project.id)).toBe(work);
  });

  it('refuses the 51st folder', async () => {
    let n = 0;
    const s = createProjectsStore({ dir, isDirectory: yes, randomUUID: () => uuid(++n) });
    for (let i = 0; i < GUI_MAX_PROJECTS; i++) expect((await s.add(join(dir, `d${i}`))).ok).toBe(true);
    expect(await s.add(join(dir, 'extra'))).toEqual({ ok: false, reason: 'too-many' });
    expect(s.list()).toHaveLength(GUI_MAX_PROJECTS);
  });

  it('remove drops the project, persists, and pathOf goes undefined', async () => {
    const s = store();
    const r = await s.add(work);
    if (!r.ok) throw new Error('add failed');
    expect(await s.remove(r.project.id)).toBe(true);
    expect(s.pathOf(r.project.id)).toBeUndefined();
    expect(JSON.parse(readFileSync(file(), 'utf8')).projects).toEqual([]);
    expect(await s.remove(r.project.id)).toBe(false);
    expect(await s.remove('constructor')).toBe(false);
  });

  it('serialises two quick adds so both persist', async () => {
    const s = store();
    const [a, b] = await Promise.all([s.add(work), s.add(dir)]);
    expect(a.ok && b.ok).toBe(true);
    expect(store().list()).toHaveLength(2);
  });

  it('a write failure returns write-failed and leaves the list unchanged', async () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const s = createProjectsStore({ dir: join(blocker, 'sub'), isDirectory: yes });
    expect(await s.add(work)).toEqual({ ok: false, reason: 'write-failed' });
    expect(s.list()).toEqual([]);
  });
});
