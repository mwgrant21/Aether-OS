// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(here, '..', 'skills', 'aether-terminal-board');
const text = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
const cliPath = join(here, 'aether-board.mjs');

function cliVerbs(): string[] {
  const r = spawnSync('node', [cliPath, 'help'], { encoding: 'utf8' });
  return [...r.stdout.matchAll(/^ {2}(\w+)/gm)].map((m) => m[1]);
}

describe('aether-terminal-board skill', () => {
  it('has matching frontmatter name and a description that names AETHER_TERMINAL', () => {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    expect(fm).not.toBeNull();
    const name = /^name:\s*(\S+)/m.exec(fm![1])?.[1];
    expect(name).toBe('aether-terminal-board');
    expect(name).toBe(skillDir.split(/[\\/]/).pop());
    expect(/^description:.*AETHER_TERMINAL/m.test(fm![1])).toBe(true);
  });

  it('keeps the description valid YAML: quoted, or a plain scalar with no ": " or " #"', () => {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)![1];
    const value = /^description:[ \t]*(.*)$/m.exec(fm)![1];
    const quoted = /^["'>|]/.test(value);
    expect(quoted || !/: | #|:$/.test(value)).toBe(true);
    if (/^"/.test(value)) {
      expect(value.endsWith('"')).toBe(true);
      expect(value.slice(1, -1)).not.toMatch(/(^|[^\\])"/);
    }
  });

  it('only tells the agent to run real CLI verbs, and covers every verb', () => {
    const real = cliVerbs();
    expect(real).toEqual(expect.arrayContaining(['whoami', 'status', 'task', 'claim', 'release', 'blocked', 'clear']));
    const used = new Set([...text.matchAll(/node "BOARD" ([a-z]+)/g)].map((m) => m[1]));
    for (const v of used) expect(real).toContain(v);
    for (const v of ['whoami', 'status', 'task', 'claim', 'release', 'blocked', 'clear']) expect(used).toContain(v);
  });

  it('carries the required behavioral phrases', () => {
    const lower = text.toLowerCase();
    for (const p of ['do not wait', 'blocked', 'release', 'aether_terminal']) expect(lower).toContain(p);
    expect(/never[^.\n]*absolute/i.test(text)).toBe(true);
  });

  it('has no machine-specific path and only the one LOCALAPPDATA path', () => {
    expect(/[A-Za-z]:[\\/]/.test(text)).toBe(false);
    expect(/\/Users\//.test(text)).toBe(false);
    expect(/\/Matt\//.test(text)).toBe(false);
    const la = [...text.matchAll(/\$LOCALAPPDATA[^"]*/g)].map((m) => m[0]);
    expect(la.length).toBeGreaterThan(0);
    for (const p of la) expect(p).toBe('$LOCALAPPDATA/Programs/Aether OS/resources/scripts/aether-board.mjs');
  });
});
