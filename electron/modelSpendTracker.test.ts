// electron/modelSpendTracker.test.ts
import { describe, it, expect } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { costUsd, loadSpendState, recordSpend, spendGate, MONTHLY_SPEND_CEILING_USD } from './modelSpendTracker';

async function tempStatePath(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aether-model-spend-'));
  return path.join(dir, 'model-spend.json');
}

describe('costUsd', () => {
  it('computes cost for the opus (chat) model', () => {
    expect(costUsd('claude-opus-4-8', 1_000_000, 1_000_000)).toBe(15 + 75);
  });

  it('computes cost for the haiku (headline) model', () => {
    expect(costUsd('claude-haiku-4-5', 1_000_000, 1_000_000)).toBe(1 + 5);
  });

  it('returns 0 for an unrecognized model rather than throwing', () => {
    expect(costUsd('some-future-model', 1000, 1000)).toBe(0);
  });
});

describe('spend persistence', () => {
  it('loadSpendState on a missing file -> {}', async () => {
    const statePath = await tempStatePath();
    expect(await loadSpendState(statePath)).toEqual({});
  });

  it('loadSpendState on invalid JSON -> {} (must not throw)', async () => {
    const statePath = await tempStatePath();
    await fsp.writeFile(statePath, 'not json{{', 'utf8');
    expect(await loadSpendState(statePath)).toEqual({});
  });

  it('recordSpend accumulates within the same month and returns the running total', async () => {
    const statePath = await tempStatePath();
    await recordSpend(statePath, '2026-07', 1.5);
    const total = await recordSpend(statePath, '2026-07', 2.5);
    expect(total).toBe(4);
    expect(await loadSpendState(statePath)).toEqual({ '2026-07': 4 });
  });

  it('recordSpend keeps separate months independent', async () => {
    const statePath = await tempStatePath();
    await recordSpend(statePath, '2026-07', 4);
    await recordSpend(statePath, '2026-08', 1);
    expect(await loadSpendState(statePath)).toEqual({ '2026-07': 4, '2026-08': 1 });
  });
});

describe('spendGate', () => {
  it('is "ok" well below the ceiling', () => {
    expect(spendGate(1, MONTHLY_SPEND_CEILING_USD)).toBe('ok');
  });

  it('is "degrade" at or above 80% of the ceiling', () => {
    expect(spendGate(MONTHLY_SPEND_CEILING_USD * 0.8, MONTHLY_SPEND_CEILING_USD)).toBe('degrade');
  });

  it('is "blocked" at or above the ceiling', () => {
    expect(spendGate(MONTHLY_SPEND_CEILING_USD, MONTHLY_SPEND_CEILING_USD)).toBe('blocked');
  });
});
