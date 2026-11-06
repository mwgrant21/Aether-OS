// Shared setup for draft.test.ts, approveFlow.test.ts and resolvePlan.test.ts. Not a *.test.ts file, so neither vitest
// config collects it. Logic modules take nowMs, so every test pins the same evening.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceDraft } from './draft.mjs';
export const NOW = new Date(2026, 10, 4, 23, 0).getTime();   // 23:00, the evening before the window
export const WIN = new Date(2026, 10, 5, 1, 0).getTime();    // the 01:00 window that follows
export const DAY = 864e5;
export const A = 'a'.repeat(12), B = 'b'.repeat(12), C = 'c'.repeat(12), D = 'd'.repeat(12);
export const tmp = (tag = 'afk-draft') => mkdtempSync(join(tmpdir(), `${tag}-`));
export const mkItem = (id: string, title: string, verdict = 'ready', extra: Record<string, unknown> = {}) => ({
  id, project: 'aether-os', kind: 'work', artifact: null, title, source: { kind: 'handoff', file: 'h.md' }, verdict,
  reasons: verdict === 'ready' ? [] : [verdict === 'barred' ? 'barred:delete' : 'question:marker'], confirmed: false, ...extra,
});
export const mkCompiled = (items: unknown[], over: Record<string, unknown> = {}) =>
  ({ v: 1, createdAtMs: NOW, targetWindowStartMs: WIN, projects: ['aether-os'], warnings: [], items, ...over });
export const draftWith = (d: string, items: unknown[], nowMs = NOW, over: Record<string, unknown> = {}) =>
  replaceDraft(d, mkCompiled(items, over) as any, nowMs);
export const okProbes = {
  repoRoot: () => 'C:/r', fileExists: () => true,
  propKeysPresent: (_f: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, true])), propPathExists: () => true,
};
export const ctxFor = (home: string, probes: unknown = okProbes) => ({ homeDir: home, probes });
// A plan item whose plan and spec exist under a temp home; `specStatus` is the spec's Status text ('approved' or 'DRAFT').
export function putPlan(home: string, specStatus: string) {
  const root = join(home, 'projects', 'aether-os', 'docs', 'superpowers');
  mkdirSync(join(root, 'plans'), { recursive: true }); mkdirSync(join(root, 'specs'), { recursive: true });
  writeFileSync(join(root, 'plans', 'p.md'), '# P\n**Spec:** `docs/superpowers/specs/s.md`\n');
  writeFileSync(join(root, 'specs', 's.md'), `# S\nStatus: ${specStatus}\n`);
  return mkItem(D, 'Execute plan p.md', 'ready', { kind: 'plan', planRef: { file: 'p.md', specApproved: true } });
}
