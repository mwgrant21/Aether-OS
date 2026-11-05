// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFeasibility, realProbes } from './feasibility.mjs';
const apk = { project: 'aether-os', kind: 'build', artifact: 'apk', title: 'Build the APK' };
const probes = (over: Record<string, unknown> = {}) => ({
  repoRoot: () => 'C:/r', fileExists: () => true,
  propKeysPresent: (_f: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, true])),
  propPathExists: () => true, ...over,
});
describe('checkFeasibility (fake probes)', () => {
  it('non-build items are trivially feasible', () => {
    expect(checkFeasibility({ ...apk, kind: 'work' }, probes())).toEqual({ ok: true, checks: [], warnings: [] });
  });
  it('a build item with no recipe is blocked', () => {
    const r = checkFeasibility({ ...apk, project: 'MobileCrawler' }, probes());
    expect(r.ok).toBe(false); expect(r.checks[0].detail).toContain('no build recipe');
  });
  it('all present: ok, with the unverified-recipe warning', () => {
    const r = checkFeasibility(apk, probes());
    expect(r.ok).toBe(true); expect(r.warnings.join(' ')).toContain('not yet verified');
  });
  it('a missing signing key blocks and names the KEY only', () => {
    const r = checkFeasibility(apk, probes({ propKeysPresent: (_f: string, keys: string[]) => Object.fromEntries(keys.map((k) => [k, k !== 'AETHER_KEY_ALIAS'])) }));
    expect(r.ok).toBe(false); expect(r.checks.find((c: any) => !c.ok)?.detail).toBe('AETHER_KEY_ALIAS missing');
  });
  it('a missing sdk.dir blocks the APK and names the key', () => {
    const r = checkFeasibility(apk, probes({ propPathExists: (_f: string, key: string) => key !== 'sdk.dir' }));
    expect(r.ok).toBe(false); expect(JSON.stringify(r)).toContain('sdk.dir');
  });
  it('a scratchDir requirement passes but warns that it was not probed', () => {
    const r = checkFeasibility({ ...apk, artifact: 'installer' }, probes());
    expect(r.ok).toBe(true); expect(r.warnings.join(' ')).toContain('scratch dir is not probed');
  });
});
describe('realProbes', () => {
  it('reports presence and never leaks a value', () => {
    const home = mkdtempSync(join(tmpdir(), 'afk-feas-'));
    const root = join(home, 'projects', 'aether-os'); mkdirSync(join(root, 'android'), { recursive: true });
    const ks = join(home, 'ks.jks'); writeFileSync(ks, 'x');
    writeFileSync(join(root, 'android', 'local.properties'),
      `# AETHER_KEY_ALIAS=commented\nAETHER_KEYSTORE_PASSWORD=S3CR3T-SENTINEL\nAETHER_KEY_ALIAS=\nAETHER_KEYSTORE_PATH=${ks.replace(/\\/g, '/')}\n`);
    const p = realProbes({ homeDir: home, env: {} });
    const file = join(root, 'android', 'local.properties');
    expect(p.repoRoot('aether-os')).toBe(root);
    expect(p.propKeysPresent(file, ['AETHER_KEYSTORE_PASSWORD', 'AETHER_KEY_ALIAS', 'AETHER_KEY_PASSWORD']))
      .toEqual({ AETHER_KEYSTORE_PASSWORD: true, AETHER_KEY_ALIAS: false, AETHER_KEY_PASSWORD: false });
    expect(p.propPathExists(file, 'AETHER_KEYSTORE_PATH')).toBe(true);
    const full = checkFeasibility(apk, p);
    // JSON doubles backslashes, so a bare Windows path never matches: check every spelling of each secret-ish string.
    const leaks = (obj: unknown, s: string) => [s, s.replace(/\\/g, '/'), JSON.stringify(s).slice(1, -1)].some((v) => JSON.stringify(obj).includes(v));
    expect(leaks({ k: ks }, ks)).toBe(true);   // control: the matcher does fire on a path inside JSON
    expect(leaks(full, 'S3CR3T-SENTINEL')).toBe(false);
    expect(leaks(full, ks)).toBe(false);
  });
  it('an env entry satisfies a key absent from the file', () => {
    const home = mkdtempSync(join(tmpdir(), 'afk-feas-'));
    const p = realProbes({ homeDir: home, env: { AETHER_KEY_PASSWORD: 'x' } });
    expect(p.propKeysPresent(join(home, 'missing.properties'), ['AETHER_KEY_PASSWORD'])).toEqual({ AETHER_KEY_PASSWORD: true });
  });
});
