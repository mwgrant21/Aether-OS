/**
 * Layer 2 memory store — Phase A tests.
 *
 * Every claim AETHER_MEMORY_LAYER_2.md makes about the store is pinned here.
 * Miriel's discipline (docs/memory-engine.md): "a memory that quietly drifts is
 * worse than no memory at all."
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMemoryStore,
  findForbiddenContent,
  scorePrivateCandidate,
  SHARED_WRITER,
  type MemoryRow,
  type MemoryStore,
} from './memoryStore.js';

let dir: string;
let store: MemoryStore;
let clock = 1_000_000;

const steward = { writer: SHARED_WRITER, sourceKind: 'run' as const, sourceRunId: 'r1' };
const cinder = { writer: 'CINDER', sourceKind: 'run' as const, sourceRunId: 'r1' };
const forge = { writer: 'FORGE', sourceKind: 'run' as const, sourceRunId: 'r1' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aether-mem-'));
  clock = 1_000_000;
  store = createMemoryStore(join(dir, 'memory.db'), { now: () => clock });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const decision = (content: string) => ({ op: 'ADD', kind: 'decision', content, salience: 4 });

describe('schema + basic writes', () => {
  it('adds a shared decision with no owner', () => {
    const r = store.applyOps([decision('Matt accepts unbounded retry on token refresh')], steward);
    expect(r.added).toBe(1);
    expect(r.rejected).toEqual([]);
    const shared = store.getShared();
    expect(shared).toHaveLength(1);
    expect(shared[0].scope).toBe('shared');
    expect(shared[0].owner_agent).toBeNull();
  });

  it('derives scope from kind, not from the caller', () => {
    store.applyOps([{ op: 'ADD', kind: 'overrule', content: 'Matt went the other way on the queue depth' }], cinder);
    const all = store.admin.listAll();
    expect(all[0].scope).toBe('private');
    expect(all[0].owner_agent).toBe('CINDER');
  });

  it('clamps salience into 1..5 and defaults to 3', () => {
    store.applyOps([
      { op: 'ADD', kind: 'preference', content: 'Matt wants diffs before explanations', salience: 99 },
      { op: 'ADD', kind: 'preference', content: 'Matt prefers terse status lines' },
    ], steward);
    const s = store.getShared();
    expect(s.map((r) => r.salience).sort()).toEqual([3, 5]);
  });

  it('rejects a present-but-non-numeric salience rather than defaulting it', () => {
    const r = store.applyOps([
      { op: 'ADD', kind: 'preference', content: 'Matt wants the reject list surfaced', salience: 'high' },
    ], steward);
    expect(r.added).toBe(0);
    expect(r.rejected[0]).toMatchObject({ reason: 'invalid_salience', detail: 'high' });
  });

  it('returns plain objects, not null-prototype rows', () => {
    store.applyOps([decision('Matt accepts a slower build for a simpler config')], steward);
    const row = store.getShared()[0];
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });
});

describe('rejects are returned, never swallowed (§4.2)', () => {
  it('rejects an unknown op kind', () => {
    const r = store.applyOps([{ op: 'FROB', id: 1 }], steward);
    expect(r.rejected).toEqual([{ op: { op: 'FROB', id: 1 }, reason: 'unknown_op', detail: 'FROB' }]);
  });

  it('rejects an invalid kind', () => {
    const r = store.applyOps([{ op: 'ADD', kind: 'feeling', content: 'x' }], steward);
    expect(r.rejected[0].reason).toBe('invalid_kind');
    expect(r.added).toBe(0);
  });

  it('rejects an invalid status', () => {
    const r = store.applyOps([
      { op: 'ADD', kind: 'decision', content: 'Matt accepts eventual consistency here', status: 'dormant' },
    ], steward);
    expect(r.rejected[0].reason).toBe('invalid_status');
  });

  it('rejects empty content', () => {
    const r = store.applyOps([{ op: 'ADD', kind: 'decision', content: '   ' }], steward);
    expect(r.rejected[0].reason).toBe('empty_content');
  });

  it('rejects a missing target', () => {
    const r = store.applyOps([{ op: 'TOUCH', id: 999 }], steward);
    expect(r.rejected[0]).toMatchObject({ reason: 'not_found', detail: 'id=999' });
  });

  it('rejects a non-array ops payload rather than throwing', () => {
    const r = store.applyOps('nope', steward);
    expect(r.rejected[0].reason).toBe('unknown_op');
  });

  it('a reject does not abort the rest of the batch', () => {
    const r = store.applyOps([
      decision('Matt accepts unbounded retry on token refresh'),
      { op: 'ADD', kind: 'nonsense', content: 'x' },
      decision('Matt wants the collector to own migrations'),
    ], steward);
    expect(r.added).toBe(2);
    expect(r.rejected).toHaveLength(1);
  });
});

describe('scope enforcement lives in the store, not the prompt (§3.2)', () => {
  it('a non-STEWARD writer cannot create shared rows', () => {
    const r = store.applyOps([decision('Matt accepts unbounded retry on token refresh')], cinder);
    expect(r.added).toBe(0);
    expect(r.rejected[0]).toMatchObject({ reason: 'scope_violation', detail: 'CINDER_cannot_write_shared' });
  });

  it('an agent cannot write into another agent private scope', () => {
    const r = store.applyOps([
      { op: 'ADD', kind: 'habit', content: 'Matt always asks about the collector after a schema change', owner_agent: 'FORGE' },
    ], cinder);
    expect(r.rejected[0]).toMatchObject({ reason: 'scope_violation', detail: 'CINDER_cannot_write_for_FORGE' });
  });

  it('an agent cannot UPDATE another agent private row', () => {
    store.applyOps([{ op: 'ADD', kind: 'habit', content: 'Matt reviews migrations before anything else' }], forge);
    const id = store.admin.listAll()[0].id;
    const r = store.applyOps([{ op: 'UPDATE', id, content: 'rewritten by a stranger' }], cinder);
    expect(r.updated).toBe(0);
    expect(r.rejected[0].reason).toBe('scope_violation');
  });

  it('a non-STEWARD writer cannot UPDATE a shared row', () => {
    store.applyOps([decision('Matt accepts unbounded retry on token refresh')], steward);
    const id = store.getShared()[0].id;
    const r = store.applyOps([{ op: 'UPDATE', id, salience: 1 }], cinder);
    expect(r.rejected[0].reason).toBe('scope_violation');
  });

  it('getPrivateCandidates never returns another agent rows', () => {
    store.applyOps([{ op: 'ADD', kind: 'habit', content: 'Matt asks for the reject list first' }], cinder);
    store.applyOps([{ op: 'ADD', kind: 'habit', content: 'Matt wants migrations guarded' }], forge);
    expect(store.getPrivateCandidates('CINDER')).toHaveLength(1);
    expect(store.getPrivateCandidates('CINDER')[0].owner_agent).toBe('CINDER');
    expect(store.getPrivateCandidates('FORGE')).toHaveLength(1);
  });

  it('getPrivateCandidates refuses an empty owner rather than returning everything', () => {
    expect(() => store.getPrivateCandidates('')).toThrow();
  });

  it('getPrivateCandidates orders by score, not raw salience/updated_at', () => {
    // A low-salience 'overrule' should outrank a high-salience 'habit', because
    // kind_weight (coefficient 2.0) dominates salience (coefficient 1.5) at
    // these values: overrule score ≈ 2.0*1.0 + 1.5*0.2 + 1.0 = 3.3;
    // habit score ≈ 2.0*0.33 + 1.5*1.0 + 1.0 = 3.16. The OLD placeholder
    // ordering (ORDER BY salience DESC) would have put the habit row first;
    // the real formula puts the overrule row first.
    store.applyOps([{ op: 'ADD', kind: 'overrule', content: 'Low-salience overrule.', salience: 1 }], cinder);
    store.applyOps([{ op: 'ADD', kind: 'habit', content: 'High-salience habit.', salience: 5 }], cinder);

    const results = store.getPrivateCandidates('CINDER');
    expect(results[0].kind).toBe('overrule');
    expect(results[1].kind).toBe('habit');
  });

  it('getPrivateCandidates still respects the caller-supplied limit after scoring', () => {
    for (let i = 0; i < 10; i++) {
      store.applyOps([{ op: 'ADD', kind: 'habit', content: `Habit ${i}.`, salience: 3 }], cinder);
    }
    const results = store.getPrivateCandidates('CINDER', 3);
    expect(results).toHaveLength(3);
  });

  it('getPrivateCandidates never returns a shared-scope row, regardless of score', () => {
    store.applyOps([{ op: 'ADD', kind: 'decision', content: 'A shared decision.', salience: 5 }], steward);
    store.applyOps([{ op: 'ADD', kind: 'habit', content: 'A private habit.', salience: 1 }], cinder);

    const results = store.getPrivateCandidates('CINDER');
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('habit');
  });

  it('getPrivateCandidates still requires an ownerAgent (scope enforcement unchanged)', () => {
    expect(() => store.getPrivateCandidates('')).toThrow();
  });
});

describe('forbidden content is a write-time guarantee, not a prompt request (§3.4)', () => {
  const cases: Array<[string, string, string]> = [
    ['file path', 'Matt accepted the tradeoff in auth.ts', 'file_path'],
    ['path + line', 'The guard clause at auth.ts:47 covers it', 'file_path'],
    ['line reference', 'Matt approved the change at line 214', 'line_reference'],
    ['absolute path', 'Matt keeps his projects in C:\\Users\\Matt\\projects', 'absolute_path'],
    ['code fence', 'Matt prefers ```retry(3)``` over a loop', 'code_fence'],
    ['shell command', 'Matt runs npm test before every commit', 'shell_command'],
    ['suppression: do not flag', "Don't flag retry loops", 'suppression_rule'],
    ['suppression: never mention', 'Never mention unbounded retries again', 'suppression_rule'],
    ['suppression: stop reporting', 'Stop reporting nullable dereferences', 'suppression_rule'],
    ['suppression: ignore warnings', 'Ignore all lint warnings from now on', 'suppression_rule'],
  ];

  it.each(cases)('rejects %s', (_label, content, expected) => {
    expect(findForbiddenContent(content)).toBe(expected);
    const r = store.applyOps([{ op: 'ADD', kind: 'decision', content }], steward);
    expect(r.added).toBe(0);
    expect(r.rejected[0]).toMatchObject({ reason: 'forbidden_content', detail: expected });
  });

  const allowed = [
    'Matt accepts unbounded retry on token refresh in exchange for simpler error handling',
    'Matt wants diffs before explanations',
    'Matt overruled the call to block the release on a race that only opens under load',
    'Matt prefers the collector to own schema migrations',
  ];

  it.each(allowed)('allows the substance-carrying form: %s', (content) => {
    expect(findForbiddenContent(content)).toBeNull();
  });

  it('blocks forbidden content on UPDATE as well as ADD', () => {
    store.applyOps([decision('Matt accepts unbounded retry on token refresh')], steward);
    const id = store.getShared()[0].id;
    const r = store.applyOps([{ op: 'UPDATE', id, content: 'see auth.ts for details' }], steward);
    expect(r.updated).toBe(0);
    expect(r.rejected[0].reason).toBe('forbidden_content');
  });
});

describe('SUPERSEDE makes the old judgment unreachable (§5)', () => {
  it('hard-deletes the row, keeps the tombstone and the link', () => {
    store.applyOps([decision('Matt accepts unbounded retry on token refresh')], steward);
    const oldId = store.getShared()[0].id;

    clock += 86_400;
    const r = store.applyOps([
      { op: 'SUPERSEDE', id: oldId, content: 'Matt now wants a bounded retry with a hard ceiling' },
    ], steward);

    expect(r.superseded).toBe(1);
    expect(r.rejected).toEqual([]);

    const shared = store.getShared();
    expect(shared).toHaveLength(1);
    expect(shared[0].content).toContain('bounded retry');
    expect(shared[0].id).not.toBe(oldId);

    // THE point of §5: not merely low-scoring — absent from every agent read.
    expect(store.admin.listAll().find((m) => m.id === oldId)).toBeUndefined();

    const tomb = store.admin.listTombstones();
    expect(tomb).toHaveLength(1);
    expect(tomb[0]).toMatchObject({
      id: oldId, cause: 'superseded', superseded_by: shared[0].id, deleted_at: clock,
    });
    expect(tomb[0].content).toContain('unbounded retry');

    expect(store.admin.linksFor(oldId)).toEqual([
      { from_id: shared[0].id, to_id: oldId, relation: 'supersedes' },
    ]);
  });

  it('carries forward status, salience and subject when not overridden', () => {
    store.applyOps([
      { op: 'ADD', kind: 'decision', content: 'Matt accepts a slower build for a simpler config', salience: 5, status: 'open', subject: 'build' },
    ], steward);
    const oldId = store.getShared()[0].id;
    store.applyOps([{ op: 'SUPERSEDE', id: oldId, content: 'Matt now wants the faster build back' }], steward);
    const row = store.getShared()[0];
    expect(row).toMatchObject({ salience: 5, status: 'open', subject: 'build' });
  });

  it('refuses a supersede that would change scope', () => {
    store.applyOps([decision('Matt accepts unbounded retry on token refresh')], steward);
    const id = store.getShared()[0].id;
    const r = store.applyOps([
      { op: 'SUPERSEDE', id, kind: 'habit', content: 'Matt asks about retries a lot' },
    ], steward);
    expect(r.superseded).toBe(0);
    expect(r.rejected[0]).toMatchObject({ reason: 'scope_violation', detail: 'supersede_changes_scope' });
    expect(store.getShared()).toHaveLength(1);
  });

  it('rejects forbidden content in the replacement without deleting the original', () => {
    store.applyOps([decision('Matt accepts unbounded retry on token refresh')], steward);
    const id = store.getShared()[0].id;
    const r = store.applyOps([{ op: 'SUPERSEDE', id, content: 'now handled in retry.ts' }], steward);
    expect(r.rejected[0].reason).toBe('forbidden_content');
    expect(store.getShared()[0].id).toBe(id);
    expect(store.admin.listTombstones()).toHaveLength(0);
  });

  it('operator delete uses the same tombstoned hard-delete path', () => {
    store.applyOps([decision('Matt accepts unbounded retry on token refresh')], steward);
    const id = store.getShared()[0].id;
    expect(store.deleteMemory(id)).toBe(true);
    expect(store.getShared()).toHaveLength(0);
    expect(store.admin.listTombstones()[0]).toMatchObject({ id, cause: 'operator', superseded_by: null });
  });

  it('deleting a missing row reports false rather than throwing', () => {
    expect(store.deleteMemory(4242)).toBe(false);
  });
});

describe('REVISE — Layer 1 §7 durable half (§6)', () => {
  it('records the cause and detail, linked to the revised row', () => {
    store.applyOps([{ op: 'ADD', kind: 'overrule', content: 'Matt went the other way on blocking the release' }], cinder);
    const target = store.getPrivateCandidates('CINDER')[0].id;

    const r = store.applyOps([
      { op: 'REVISE', id: target, cause: 'reasoning_flaw', detail: 'a guard clause upstream makes that path unreachable' },
    ], cinder);

    expect(r.revised).toBe(1);
    const rows = store.getPrivateCandidates('CINDER');
    const revision = rows.find((m) => m.kind === 'revision')!;
    expect(revision.subject).toBe('reasoning_flaw');
    expect(revision.content).toContain('guard clause upstream');
    expect(store.admin.linksFor(target)).toContainEqual({
      from_id: revision.id, to_id: target, relation: 'revises',
    });
  });

  it('rejects a revision with no cause — the contract breach must be visible', () => {
    store.applyOps([{ op: 'ADD', kind: 'overrule', content: 'Matt went the other way on the queue depth' }], cinder);
    const id = store.getPrivateCandidates('CINDER')[0].id;
    const r = store.applyOps([{ op: 'REVISE', id, detail: 'he pushed back twice' }], cinder);
    expect(r.revised).toBe(0);
    expect(r.rejected[0]).toMatchObject({ reason: 'missing_revision_cause', detail: 'cause=absent' });
  });

  it('rejects a revision with an unrecognised cause (social pressure is not a cause)', () => {
    store.applyOps([{ op: 'ADD', kind: 'overrule', content: 'Matt went the other way on the queue depth' }], cinder);
    const id = store.getPrivateCandidates('CINDER')[0].id;
    const r = store.applyOps([{ op: 'REVISE', id, cause: 'user_disagreed', detail: 'he said no' }], cinder);
    expect(r.rejected[0].reason).toBe('missing_revision_cause');
  });

  it('rejects a revision with an empty detail', () => {
    store.applyOps([{ op: 'ADD', kind: 'overrule', content: 'Matt went the other way on the queue depth' }], cinder);
    const id = store.getPrivateCandidates('CINDER')[0].id;
    const r = store.applyOps([{ op: 'REVISE', id, cause: 'new_evidence', detail: '  ' }], cinder);
    expect(r.rejected[0]).toMatchObject({ reason: 'missing_revision_cause', detail: 'detail_empty' });
  });
});

describe('shared retrieval is unconditional (§4.4)', () => {
  it('returns every in-force shared row with no cap and no relevance filter', () => {
    const ops = Array.from({ length: 40 }, (_, i) => decision(`Matt made standing call number ${i} about the collector`));
    store.applyOps(ops, steward);
    expect(store.getShared()).toHaveLength(40);
  });

  it('surfacing a row does not penalise it — no overuse term exists', () => {
    store.applyOps([decision('Matt accepts unbounded retry on token refresh')], steward);
    const id = store.getShared()[0].id;
    store.markReferenced([id, id, id, id, id]);
    const after = store.getShared();
    expect(after).toHaveLength(1);
    expect(after[0].reference_count).toBe(5);
  });

  // REGRESSION: markReferenced originally reused the TOUCH statement, which
  // writes updated_at. That silently reset §4.4's staleness_risk clock, so
  // surfacing a memory RAISED its own future score — the surfacing→score
  // feedback loop §4.4 exists to eliminate, running backwards. Miriel keeps the
  // two statements separate for the mirror-image reason; collapsing them is the
  // tempting and wrong simplification.
  it('markReferenced does not touch updated_at — surfacing must not reset staleness', () => {
    store.applyOps([{ op: 'ADD', kind: 'habit', content: 'Matt asks for the reject list first' }], cinder);
    const before = store.getPrivateCandidates('CINDER')[0];

    clock += 90 * 86_400;
    store.markReferenced([before.id]);

    const after = store.getPrivateCandidates('CINDER')[0];
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.reference_count).toBe(before.reference_count + 1);
  });

  it('TOUCH does advance updated_at — the extractor confirming a row is still live', () => {
    store.applyOps([{ op: 'ADD', kind: 'habit', content: 'Matt reviews migrations before anything else' }], cinder);
    const before = store.getPrivateCandidates('CINDER')[0];

    clock += 90 * 86_400;
    store.applyOps([{ op: 'TOUCH', id: before.id }], cinder);

    const after = store.getPrivateCandidates('CINDER')[0];
    expect(after.updated_at).toBe(clock);
    expect(after.updated_at).toBeGreaterThan(before.updated_at);
  });
});

describe('durability', () => {
  it('reopens an existing database without losing rows or re-running migrations', () => {
    store.applyOps([decision('Matt accepts unbounded retry on token refresh')], steward);
    store.close();
    const reopened = createMemoryStore(join(dir, 'memory.db'), { now: () => clock });
    expect(reopened.getShared()).toHaveLength(1);
    reopened.close();
    store = createMemoryStore(join(dir, 'memory.db'), { now: () => clock });
  });

  it('meta round-trips', () => {
    store.setMeta('schema_rev', '1');
    expect(store.getMeta('schema_rev')).toBe('1');
    expect(store.getMeta('absent')).toBeNull();
  });
});

describe("the 'constraint' kind stays removed (§9 #3)", () => {
  // Removed because every candidate member was either probe-settleable (P2:
  // that is a lookup, not memory) or silently-changing world state (P3 forbids
  // it outright). The canonical example, "no VS Build Tools on this box", was
  // falsified one day after it was written. This test exists so re-adding the
  // kind is a deliberate act with a reason attached, not a quiet convenience.
  it('is rejected rather than stored', () => {
    const r = store.applyOps([
      { op: 'ADD', kind: 'constraint', content: 'Matt has no second machine to test on' },
    ], steward);
    expect(r.added).toBe(0);
    expect(r.rejected[0]).toMatchObject({ reason: 'invalid_kind', detail: 'constraint' });
  });
});

describe('scorePrivateCandidate', () => {
  const NOW = 1_000_000; // seconds, arbitrary fixed epoch matching this file's `clock` convention
  const DAY = 86_400;

  function row(overrides: Partial<MemoryRow> = {}): MemoryRow {
    return {
      id: 1,
      scope: 'private',
      owner_agent: 'CINDER',
      kind: 'habit',
      content: 'x',
      status: null,
      salience: 3,
      subject: null,
      source_kind: 'run',
      source_run_id: null,
      created_at: NOW,
      updated_at: NOW,
      asked_at: null,
      reference_count: 0,
      ...overrides,
    };
  }

  it('weights kind in the order overrule > revision > habit, all else equal', () => {
    const overruleScore = scorePrivateCandidate(row({ kind: 'overrule' }), NOW);
    const revisionScore = scorePrivateCandidate(row({ kind: 'revision' }), NOW);
    const habitScore = scorePrivateCandidate(row({ kind: 'habit' }), NOW);
    expect(overruleScore).toBeGreaterThan(revisionScore);
    expect(revisionScore).toBeGreaterThan(habitScore);
  });

  it('pins the exact kind_weight values (overrule=1.0, revision=0.67, habit=0.33)', () => {
    // With salience=3 (norm 0.6), created_at=updated_at=NOW (recency=1, staleness_risk=0
    // since status defaults to null, not 'open'): score = 2.0*kindWeight + 1.5*0.6 + 1.0*1 - 0 = 2.0*kindWeight + 1.9
    expect(scorePrivateCandidate(row({ kind: 'overrule' }), NOW)).toBeCloseTo(2.0 * 1.0 + 1.9, 5);
    expect(scorePrivateCandidate(row({ kind: 'revision' }), NOW)).toBeCloseTo(2.0 * 0.67 + 1.9, 5);
    expect(scorePrivateCandidate(row({ kind: 'habit' }), NOW)).toBeCloseTo(2.0 * 0.33 + 1.9, 5);
  });

  it('scales linearly with salience via /5 normalization', () => {
    const low = scorePrivateCandidate(row({ salience: 1 }), NOW);
    const mid = scorePrivateCandidate(row({ salience: 3 }), NOW);
    const high = scorePrivateCandidate(row({ salience: 5 }), NOW);
    expect(high).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(low);
    // 1.5 * (salience/5) is the salience term's exact contribution; difference
    // between salience=5 and salience=1 is 1.5 * (5/5 - 1/5) = 1.5 * 0.8 = 1.2
    expect(high - low).toBeCloseTo(1.2, 5);
  });

  it('recency is 1.0 at age zero and 0.5 at exactly 90 days, keyed on created_at not updated_at', () => {
    const fresh = row({ created_at: NOW, updated_at: NOW });
    const ninetyDaysOld = row({ created_at: NOW - 90 * DAY, updated_at: NOW - 90 * DAY });
    const freshScore = scorePrivateCandidate(fresh, NOW);
    const oldScore = scorePrivateCandidate(ninetyDaysOld, NOW);
    // Both have kind='habit', salience=3, status=null (staleness_risk=0) --
    // only recency differs. recency term contribution: 1.0*1.0 vs 1.0*0.5,
    // so the score difference should be exactly 0.5 (the 1.0 coefficient on recency).
    expect(freshScore - oldScore).toBeCloseTo(0.5, 5);
  });

  it('a row updated recently (created long ago) still uses created_at for recency, not updated_at', () => {
    // created 200 days ago, but updated (e.g. via TOUCH) just now -- recency
    // must still reflect the OLD created_at, not the fresh updated_at, per
    // the design doc's explicit "keyed on created_at, never updated_at" rule.
    const oldButTouched = row({ created_at: NOW - 200 * DAY, updated_at: NOW, status: null });
    const trulyFresh = row({ created_at: NOW, updated_at: NOW, status: null });
    expect(scorePrivateCandidate(oldButTouched, NOW)).toBeLessThan(scorePrivateCandidate(trulyFresh, NOW));
  });

  it('staleness_risk is zero for any non-open status, regardless of updated_at age', () => {
    const veryStaleButSettled = row({ status: 'settled', updated_at: NOW - 300 * DAY });
    const veryStaleButMoving = row({ status: 'moving', updated_at: NOW - 300 * DAY });
    const veryStaleButNull = row({ status: null, updated_at: NOW - 300 * DAY });
    const fresh = row({ status: 'settled', updated_at: NOW });
    // All should score identically to their fresh-updated_at counterpart,
    // since staleness_risk only applies to status='open'.
    expect(scorePrivateCandidate(veryStaleButSettled, NOW)).toBeCloseTo(scorePrivateCandidate(fresh, NOW), 5);
    expect(scorePrivateCandidate(veryStaleButMoving, NOW)).toBeCloseTo(scorePrivateCandidate(fresh, NOW), 5);
    expect(scorePrivateCandidate(veryStaleButNull, NOW)).toBeCloseTo(scorePrivateCandidate(fresh, NOW), 5);
  });

  it('staleness_risk grows with updated_at age for open-status rows, 0 at age zero, 0.5 at 90 days', () => {
    const freshOpen = row({ status: 'open', updated_at: NOW });
    const ninetyDayOpen = row({ status: 'open', updated_at: NOW - 90 * DAY });
    const freshScore = scorePrivateCandidate(freshOpen, NOW);
    const staleScore = scorePrivateCandidate(ninetyDayOpen, NOW);
    // staleness_risk term contribution is -0.5*staleness_risk; at 90 days
    // staleness_risk=0.5, so the score difference should be exactly 0.25
    // (0.5 coefficient * 0.5 risk).
    expect(freshScore - staleScore).toBeCloseTo(0.25, 5);
  });

  it('an open row that was just TOUCHed (updated_at reset to now) has near-zero staleness_risk even if created long ago', () => {
    const justTouched = row({ status: 'open', created_at: NOW - 200 * DAY, updated_at: NOW });
    // staleness_risk depends on updated_at only, not created_at -- this row
    // should have staleness_risk ~= 0 despite being old.
    const scoreWithFreshTouch = scorePrivateCandidate(justTouched, NOW);
    const scoreIfNeverTouched = scorePrivateCandidate(
      row({ status: 'open', created_at: NOW - 200 * DAY, updated_at: NOW - 200 * DAY }),
      NOW,
    );
    expect(scoreWithFreshTouch).toBeGreaterThan(scoreIfNeverTouched);
  });

  it('has no overuse/reference_count term at all -- reference_count does not affect score', () => {
    const neverReferenced = row({ reference_count: 0 });
    const heavilyReferenced = row({ reference_count: 500 });
    expect(scorePrivateCandidate(neverReferenced, NOW)).toBe(scorePrivateCandidate(heavilyReferenced, NOW));
  });
});
