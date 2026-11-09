// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// ownerEntry is a side-effecting entry module: capture the spawn factory it hands to createOwner.
const written: string[] = [];
const capture: { spawn?: (spec: unknown) => unknown } = {};
vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({ write: (d: string) => { written.push(d); } })) }));
vi.mock('./ownerCore', () => ({
  createOwner: (opts: { spawn: (spec: unknown) => unknown }) => {
    capture.spawn = opts.spawn;
    return { listening: new Promise(() => {}), closed: new Promise(() => {}) };
  },
}));

describe('ownerEntry spawn factory', () => {
  it('does not run spec.writes itself: ownerCore doSpawn writes them once, after wiring listeners', async () => {
    process.env.AETHER_PTY_OWNER_DISCOVERY = 'x';
    await import('./ownerEntry');
    capture.spawn!({ file: 'powershell.exe', args: [], cwd: '/',env: {}, cols: 80, rows: 24, writes: ["claude"+String.fromCharCode(13), "two"+String.fromCharCode(13)] });
    expect(written).toEqual([]);
  });
});
