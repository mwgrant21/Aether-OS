import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from './memoryStore.js';
import { runExtractor } from './memoryExtract.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-memextract-'));
  const store = createMemoryStore(join(dir, 'memory.db'), { now: () => 1_700_000_000 });
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe('runExtractor', () => {
  it('applies a well-formed op list returned by the model', async () => {
    const { store, cleanup } = tempStore();
    try {
      const result = await runExtractor(
        {
          store,
          writer: 'CINDER',
          sourceKind: 'run',
          sourceRunId: 'run-1',
          runSummary: 'The user asked CINDER to always double-check migrations before applying them.',
          existingMemories: [],
        },
        async () => ({ stdout: '[{"op":"ADD","kind":"habit","content":"Matt always asks CINDER to double-check migrations."}]' }),
      );
      expect(result.parseError).toBeNull();
      expect(result.added).toBe(1);
      expect(result.rejected).toEqual([]);
      expect(store.getPrivateCandidates('CINDER')).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('applies zero ops and reports no error when the model deliberately returns []', async () => {
    const { store, cleanup } = tempStore();
    try {
      const result = await runExtractor(
        { store, writer: 'CINDER', sourceKind: 'run', runSummary: 'Nothing notable happened.', existingMemories: [] },
        async () => ({ stdout: '[]' }),
      );
      expect(result.parseError).toBeNull();
      expect(result.added).toBe(0);
      expect(result.rejected).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('reports a parseError and applies zero ops when the model output is not parseable', async () => {
    const { store, cleanup } = tempStore();
    try {
      const result = await runExtractor(
        { store, writer: 'CINDER', sourceKind: 'run', runSummary: 'x', existingMemories: [] },
        async () => ({ stdout: 'I refuse to answer in JSON today.' }),
      );
      expect(result.parseError).toBe('no_json_array_found');
      expect(result.added).toBe(0);
      expect(result.rejected).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('reports an exec_failed parseError and applies zero ops when the CLI call throws', async () => {
    const { store, cleanup } = tempStore();
    try {
      const result = await runExtractor(
        { store, writer: 'CINDER', sourceKind: 'run', runSummary: 'x', existingMemories: [] },
        async () => { throw new Error('spawn ENOENT'); },
      );
      expect(result.parseError).toBe('exec_failed: spawn ENOENT');
      expect(result.added).toBe(0);
      expect(result.rejected).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('enforces single-writer even when the model output claims a different scope: writer identity never comes from model output', async () => {
    const { store, cleanup } = tempStore();
    try {
      // 'decision' is a SHARED kind, writable only by SHARED_WRITER ('STEWARD').
      // This model output tries to write one while the caller-supplied writer
      // is a plain agent id -- proving the reject comes from ctx.writer
      // (supplied by the caller of runExtractor), never from anything in the
      // model's JSON, which contains no writer/identity field at all.
      const result = await runExtractor(
        { store, writer: 'CINDER', sourceKind: 'run', runSummary: 'x', existingMemories: [] },
        async () => ({ stdout: '[{"op":"ADD","kind":"decision","content":"Matt decided X."}]' }),
      );
      expect(result.added).toBe(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toBe('scope_violation');
    } finally {
      cleanup();
    }
  });

  it('still enforces §3.4 forbidden-content rejection when the model emits a file path', async () => {
    const { store, cleanup } = tempStore();
    try {
      const result = await runExtractor(
        { store, writer: 'CINDER', sourceKind: 'run', runSummary: 'x', existingMemories: [] },
        async () => ({ stdout: '[{"op":"ADD","kind":"habit","content":"Matt approved the change in main.ts."}]' }),
      );
      expect(result.added).toBe(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].reason).toBe('forbidden_content');
    } finally {
      cleanup();
    }
  });
});
