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

  describe('clear hint (provisional successor)', () => {
    const H = 1_900_000_000_000;
    const clearRecordAt = (ms: number) =>
      JSON.stringify({ type: 'system', timestamp: new Date(ms).toISOString(), commandRun: { command: 'clear' } }) + '\n';

    it('a. accepts the single in-window candidate that has no session_id yet', async () => {
      const dir = tmpDir();
      const pinned = await create(dir, LAUNCH, startupRecord);
      const succ = await create(dir, 'succ', clearRecordAt(H + 200));
      expect(await createClearSuccessorFinder()(dir, LAUNCH, pinned, H)).toBe(succ);
    });

    it('b. without a hint the same fixture returns null', async () => {
      const dir = tmpDir();
      const pinned = await create(dir, LAUNCH, startupRecord);
      await create(dir, 'succ', clearRecordAt(H + 200));
      expect(await createClearSuccessorFinder()(dir, LAUNCH, pinned)).toBeNull();
    });

    it('c. a /clear record far from the hint is not accepted', async () => {
      const dir = tmpDir();
      const pinned = await create(dir, LAUNCH, startupRecord);
      await create(dir, 'far', clearRecordAt(H - 60_000));
      expect(await createClearSuccessorFinder()(dir, LAUNCH, pinned, H)).toBeNull();
    });

    it('d. two in-window candidates return null; a launch-id link then confirms one normally', async () => {
      const dir = tmpDir();
      const pinned = await create(dir, LAUNCH, startupRecord);
      await create(dir, 'one', clearRecordAt(H + 100));
      const two = await create(dir, 'two', clearRecordAt(H + 300));
      const find = createClearSuccessorFinder();
      expect(await find(dir, LAUNCH, pinned, H)).toBeNull();
      appendFileSync(two, linkRecord(LAUNCH));
      expect(await find(dir, LAUNCH, pinned, H)).toBe(two);
    });

    it('e. an in-window candidate born before the pinned file is not accepted', async () => {
      const dir = tmpDir();
      await create(dir, 'early', clearRecordAt(H + 200));
      const pinned = await create(dir, LAUNCH, startupRecord);
      expect(await createClearSuccessorFinder()(dir, LAUNCH, pinned, H)).toBeNull();
    });

    it('f. a contradicting foreign id reverts to the previous pin and C is never offered again', async () => {
      const dir = tmpDir();
      const P = await create(dir, LAUNCH, startupRecord);
      const C = await create(dir, 'succ', clearRecordAt(H + 200));
      const find = createClearSuccessorFinder();
      expect(await find(dir, LAUNCH, P, H)).toBe(C);
      // Same size as at acceptance: the pinned-file re-check must still not misfire.
      expect(await find(dir, LAUNCH, C, H)).toBeNull();
      appendFileSync(C, linkRecord(OTHER));
      expect(await find(dir, LAUNCH, C, H)).toBe(P);
      expect(await find(dir, LAUNCH, P, H)).toBeNull();
    });

    it('g. a launch-id link promotes the provisional file and it keeps being returned', async () => {
      const dir = tmpDir();
      const P = await create(dir, LAUNCH, startupRecord);
      const C = await create(dir, 'succ', clearRecordAt(H + 200));
      const find = createClearSuccessorFinder();
      expect(await find(dir, LAUNCH, P, H)).toBe(C);
      appendFileSync(C, linkRecord(LAUNCH));
      expect(await find(dir, LAUNCH, C, H)).toBe(C);
      expect(await find(dir, LAUNCH, C, H)).toBe(C);
    });

    it('h. a /clear record without a timestamp is ineligible even with a hint', async () => {
      const dir = tmpDir();
      const pinned = await create(dir, LAUNCH, startupRecord);
      await create(dir, 'succ', clearRecord);
      expect(await createClearSuccessorFinder()(dir, LAUNCH, pinned, H)).toBeNull();
    });
  });
});
