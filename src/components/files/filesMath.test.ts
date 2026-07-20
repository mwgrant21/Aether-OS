import { describe, expect, it } from 'vitest';
import type { Agent } from '../../state/types';
import { groupFilesByAgent } from './filesMath';

function makeTestAgent(overrides: Partial<Agent>): Agent {
  return {
    i: 'AB',
    name: 'Test Agent',
    task: 'testing',
    pct: 50,
    hue: '#7ef0ff',
    eta: '1m',
    share: 10,
    hist: [1, 2, 3],
    files: [],
    ...overrides,
  };
}

describe('groupFilesByAgent', () => {
  it('filters out both placeholder file names, keeping only real files', () => {
    const agents = [
      makeTestAgent({
        name: 'Code Builder',
        i: 'CB',
        files: [
          { s: '✓', n: 'routes/auth.js', c: '#3be0a0' },
          { s: '›', n: 'booting runtime…', c: '#4e7c8b' },
          { s: '·', n: 'awaiting mission', c: '#4e7c8b' },
        ],
      }),
    ];
    const result = groupFilesByAgent(agents);
    expect(result).toHaveLength(1);
    expect(result[0].i).toBe('CB');
    expect(result[0].files).toEqual([{ s: '✓', n: 'routes/auth.js', c: '#3be0a0' }]);
  });

  it('excludes an agent entirely when all its files are placeholders', () => {
    const agents = [
      makeTestAgent({
        name: 'Fresh Agent',
        files: [
          { s: '›', n: 'booting runtime…', c: '#4e7c8b' },
          { s: '·', n: 'awaiting mission', c: '#4e7c8b' },
        ],
      }),
    ];
    expect(groupFilesByAgent(agents)).toEqual([]);
  });

  it('preserves file order within an agent (no re-sorting)', () => {
    const agents = [
      makeTestAgent({
        name: 'Doc Writer',
        files: [
          { s: '✓', n: 'docs/api.md', c: '#3be0a0' },
          { s: '›', n: 'docs/setup.md', c: '#4e7c8b' },
        ],
      }),
    ];
    const result = groupFilesByAgent(agents);
    expect(result[0].files.map((f) => f.n)).toEqual(['docs/api.md', 'docs/setup.md']);
  });

  it('does not mutate the input agents array or its nested objects', () => {
    const original = [
      makeTestAgent({
        name: 'Test Runner',
        files: [
          { s: '✓', n: 'tests/auth.spec.ts', c: '#3be0a0' },
          { s: '·', n: 'awaiting mission', c: '#4e7c8b' },
        ],
      }),
    ];
    const snapshot = JSON.parse(JSON.stringify(original));
    groupFilesByAgent(original);
    expect(original).toEqual(snapshot);
  });

  it('includes multiple agents with real files, each carrying its own name, code, and hue', () => {
    const agents = [
      makeTestAgent({ name: 'Code Builder', i: 'CB', hue: '#7ef0ff', files: [{ s: '✓', n: 'routes/auth.js', c: '#3be0a0' }] }),
      makeTestAgent({ name: 'Database Agent', i: 'DB', hue: '#8ab6ff', files: [{ s: '›', n: 'migrations/0043.sql', c: '#4e7c8b' }] }),
    ];
    const result = groupFilesByAgent(agents);
    expect(result).toEqual([
      { name: 'Code Builder', i: 'CB', hue: '#7ef0ff', files: [{ s: '✓', n: 'routes/auth.js', c: '#3be0a0' }] },
      { name: 'Database Agent', i: 'DB', hue: '#8ab6ff', files: [{ s: '›', n: 'migrations/0043.sql', c: '#4e7c8b' }] },
    ]);
  });
});
