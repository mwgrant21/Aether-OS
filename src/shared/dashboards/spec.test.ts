import { describe, expect, it } from 'vitest';
import { sinceForRange, validateSpec } from './spec';

const panel = (over: Record<string, unknown> = {}) => ({
  id: 'p1', title: 'Spend by day', type: 'line', sql: 'SELECT 1', x: 'day', y: ['usd'],
  cost: { basis: 'exact', groupBy: 'day' }, ...over,
});
const board = (over: Record<string, unknown> = {}) => ({ version: 1, id: 'b1', title: 'Board', panels: [panel()], ...over });

describe('validateSpec', () => {
  it('accepts a valid board and defaults range to 30d', () => {
    const r = validateSpec(board());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.panels[0].range).toBe('30d');
  });

  it.each([
    ['non-object', 'x', 'JSON object'],
    ['wrong version', board({ version: 2 }), 'version'],
    ['bad id', board({ id: 'Bad Id' }), 'id must match'],
    ['empty title', board({ title: '' }), 'title'],
    ['no panels', board({ panels: [] }), 'panels'],
    ['13 panels', board({ panels: Array.from({ length: 13 }, (_, i) => panel({ id: `p${i}` })) }), 'panels'],
    ['duplicate panel ids', board({ panels: [panel(), panel()] }), 'duplicated'],
    ['bad type', board({ panels: [panel({ type: 'pie' })] }), 'type must be one of'],
    ['bad range', board({ panels: [panel({ range: '1y' })] }), 'range'],
    ['line without x', board({ panels: [panel({ x: undefined })] }), 'needs x'],
    ['stat with x', board({ panels: [panel({ type: 'stat' })] }), 'stat panel has no x'],
    ['stat with two y', board({ panels: [panel({ type: 'stat', x: undefined, y: ['usd', 'n'] })] }), 'exactly one y'],
    ['usd and usdApprox together', board({ panels: [panel({ y: ['usd', 'usdApprox'] })] }), 'cannot share'],
    ['usd without exact cost', board({ panels: [panel({ cost: undefined })] }), 'needs cost.basis "exact"'],
    ['usdApprox with exact cost', board({ panels: [panel({ y: ['usdApprox'] })] }), 'needs cost.basis "estimated"'],
    ['malformed cost', board({ panels: [panel({ cost: { basis: 'guess', groupBy: 'day' } })] }), 'cost must be'],
  ])('rejects %s', (_n, input, part) => {
    const r = validateSpec(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' | ')).toContain(part);
  });

  it('a table panel needs neither x nor y', () => {
    expect(validateSpec(board({ panels: [{ id: 't', title: 'T', type: 'table', sql: 'SELECT 1' }] })).ok).toBe(true);
  });
});

describe('sinceForRange', () => {
  it('maps ranges to epoch ms and all to 0', () => {
    const now = 10 * 86_400_000;
    expect(sinceForRange('24h', now)).toBe(now - 86_400_000);
    expect(sinceForRange('7d', now)).toBe(now - 7 * 86_400_000);
    expect(sinceForRange('all', now)).toBe(0);
  });
});
