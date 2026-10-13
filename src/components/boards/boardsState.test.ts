import { describe, expect, it } from 'vitest';
import { mergeRefresh } from './boardsState';
import type { PanelResult } from '../../shared/dashboards/types';

const ok = (id: string, n: number): PanelResult => ({ panelId: id, columns: ['n'], rows: [{ n }], truncated: false, unpricedRows: 0, error: null, errorKind: null, refreshedAt: n, definition: 'd1' });
const busy = (id: string): PanelResult => ({ panelId: id, columns: [], rows: [], truncated: false, unpricedRows: 0, error: 'database is locked', errorKind: 'busy', refreshedAt: 9, definition: 'd1' });

describe('mergeRefresh', () => {
  it('a busy panel keeps its last good data, flagged stale (Review Focus 5)', () => {
    const first = mergeRefresh({}, [ok('a', 1), ok('b', 1)]);
    const second = mergeRefresh(first, [busy('a'), ok('b', 2)]);
    expect(second.a).toMatchObject({ rows: [{ n: 1 }], staleBusy: true });
    expect(second.b).toMatchObject({ rows: [{ n: 2 }], staleBusy: false });
  });
  it('busy does not reuse a result computed from a different panel definition', () => {
    const first = mergeRefresh({}, [ok('a', 1)]);
    expect(mergeRefresh(first, [{ ...busy('a'), definition: 'd2' }]).a).toMatchObject({ errorKind: 'busy', rows: [], staleBusy: false });
  });
  it('busy with no prior good data shows the error', () => {
    expect(mergeRefresh({}, [busy('a')]).a).toMatchObject({ errorKind: 'busy', staleBusy: false });
  });
});
