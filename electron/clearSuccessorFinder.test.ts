// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'fs';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { createClearSuccessorFinder } from './clearSuccessorFinder';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LAUNCH = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const clearRecord = JSON.stringify({ type: 'system', commandRun: { command: 'clear' } }) + '\n';
const startupRecord = JSON.stringify({ type: 'user', message: 'hello' }) + '\n';
const linkRecord = (id: string) => JSON.stringify({ type: 'attachment', session_id: id }) + '\n';

function tmpDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'aether-clear-'));
  dirs.push(d);
  return d;
}
// Creates files in order with a gap so birth ordering is real.
async function create(dir: string, name: string, body: string): Promise<string> {
  const f = path.join(dir, name + '.jsonl');
  writeFileSync(f, body, 'utf8');
  await sleep(20);
  return f;
}

describe('createClearSuccessorFinder', () => {
  it('finds the /clear successor that carries the launch id as session_id', async () => {
    const dir = tmpDir();
    const pinned = await create(dir, LAUNCH, startupRecord);
    const succ = await create(dir, 'succ', clearRecord + linkRecord(LAUNCH));
    expect(await createClearSuccessorFinder()(dir, LAUNCH, pinned)).toBe(succ);
  });

  it('returns null while the successor has the /clear record but no session_id yet, then matches after it is appended', async () => {
    const dir = tmpDir();
    const pinned = await create(dir, LAUNCH, startupRecord);
    const succ = await create(dir, 'succ', clearRecord);
    const find = createClearSuccessorFinder();
    expect(await find(dir, LAUNCH, pinned)).toBeNull();
    appendFileSync(succ, linkRecord(LAUNCH));
    expect(await find(dir, LAUNCH, pinned)).toBe(succ);
  });

  it('ignores a newer startup session (no /clear record) and does not re-read it', async () => {
    const dir = tmpDir();
    const pinned = await create(dir, LAUNCH, startupRecord);
    // Large enough to hit the stage-1 window and be rejected permanently.
    await create(dir, 'startup', startupRecord.repeat(7000));
    const reads: string[] = [];
    const find = createClearSuccessorFinder({
      readHead: async (file, max) => {
        reads.push(path.basename(file));
        const fh = await fsp.open(file, 'r');
        try {
          const buf = Buffer.alloc(max);
          const { bytesRead } = await fh.read(buf, 0, max, 0);
          return buf.toString('utf8', 0, bytesRead);
        } finally {
          await fh.close();
        }
      },
    });
    expect(await find(dir, LAUNCH, pinned)).toBeNull();
    expect(await find(dir, LAUNCH, pinned)).toBeNull();
    expect(reads).toEqual(['startup.jsonl']);
  });

  it('does not steal: a /clear file whose session_id is a different chain id is rejected', async () => {
    const dir = tmpDir();
    const pinned = await create(dir, LAUNCH, startupRecord);
    await create(dir, 'foreign', clearRecord + linkRecord(OTHER));
    expect(await createClearSuccessorFinder()(dir, LAUNCH, pinned)).toBeNull();
  });

  it('ignores a matching file born before the pin', async () => {
    const dir = tmpDir();
    await create(dir, 'early', clearRecord + linkRecord(LAUNCH));
    const pinned = await create(dir, LAUNCH, startupRecord);
    expect(await createClearSuccessorFinder()(dir, LAUNCH, pinned)).toBeNull();
  });

  it('picks the newest of two successors (second /clear) and never returns the pinned file', async () => {
    const dir = tmpDir();
    const pinned = await create(dir, LAUNCH, clearRecord + linkRecord(OTHER));
    await create(dir, 'first', clearRecord + linkRecord(LAUNCH));
    const second = await create(dir, 'second', clearRecord + linkRecord(LAUNCH));
    expect(await createClearSuccessorFinder()(dir, LAUNCH, pinned)).toBe(second);
  });

  it('a changed launch id re-evaluates files rejected under the previous launch id', async () => {
    const dir = tmpDir();
    const pinned = await create(dir, 'pin', startupRecord);
    const succ = await create(dir, 'succ', clearRecord + linkRecord(LAUNCH));
    const find = createClearSuccessorFinder();
    expect(await find(dir, OTHER, pinned)).toBeNull();
    expect(await find(dir, LAUNCH, pinned)).toBe(succ);
  });
});
