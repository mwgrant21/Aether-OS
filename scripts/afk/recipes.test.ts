// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RECIPES, detectArtifact, getRecipe } from './recipes.mjs';
describe('recipes', () => {
  it('aethermobile APK bakes in the titan IP and runs in android/', () => {
    const r = getRecipe('aether-os', 'apk');
    expect(r?.cwd).toBe('android');
    expect(r?.argv).toContain('-PAETHER_TITAN_TAILNET_IP=100.84.175.105');
    const keys = r?.requires.flatMap((q) => (q.kind === 'propKeys' ? q.keys : []));
    expect(keys).toEqual(expect.arrayContaining(['AETHER_KEYSTORE_PASSWORD', 'AETHER_KEY_ALIAS', 'AETHER_KEY_PASSWORD']));
    expect(r?.requires.some((q) => q.kind === 'propPath' && q.key === 'AETHER_KEYSTORE_PATH')).toBe(true);
    expect(r?.requires.some((q) => q.kind === 'propPath' && q.key === 'sdk.dir')).toBe(true);
    expect(r?.argv.slice(0, 2)).toEqual(['gradlew.bat', 'assembleDebug']);
  });
  it('Aether packaging builds outside the dev tree', () => {
    const r = getRecipe('aether-os', 'installer');
    expect(r?.argv.join(' ')).toContain('-c.directories.output={SCRATCH}');
    expect(r?.requires).toContainEqual({ kind: 'scratchDir' });
  });
  it('TokenMonitor needs the pfx password file present', () => {
    expect(getRecipe('TokenMonitor', 'installer')?.requires).toContainEqual({ kind: 'file', path: 'codesign/pfx-password.txt' });
  });
  it.each(['MobileCrawler', 'nmmtools', 'unknown-project'])('%s has no recipe', (p) => {
    expect(getRecipe(p, 'apk')).toBeNull(); expect(getRecipe(p, 'installer')).toBeNull();
  });
  it('every recipe cites evidence and is unverified', () => {
    for (const [k, r] of Object.entries(RECIPES)) {
      expect(r.evidence.length, k).toBeGreaterThan(10); expect(r.verified, k).toBe(false);
    }
  });
  it.each([
    ['Build the APK for aethermobile', 'apk'], ['cut a new installer', 'installer'],
    ['produce the exe', 'installer'], ['ship apk and installer', 'both'], ['fix the tests', null], ['setup fixtures for the tests', null],
  ])('detectArtifact %j -> %s', (t, want) => { expect(detectArtifact(t)).toBe(want); });
});
