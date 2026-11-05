// Build recipe table (data for Phase 2; Phase 1 never runs these commands).
// Keys are "<project>/<artifact>". {SCRATCH} is filled by the runner.
// Requirements are probed by presence only, never read.
const AETHER_LOCAL = 'android/local.properties';

export const RECIPES = {
  'aether-os/installer': {
    cwd: '.',
    argv: ['npm', 'run', 'dist', '--', '-c.directories.output={SCRATCH}'],
    requires: [{ kind: 'scratchDir' }],
    evidence: 'CLAUDE.md Run/test/build (npm run dist); docs/packaging.md:15; memory aether-os-package-build-outside-dev-tree. Arg forwarding through npm run dist -- is UNVERIFIED on this install',
    verified: false,
  },
  'aether-os/apk': {
    cwd: 'android',
    argv: ['gradlew.bat', 'assembleDebug', '-PAETHER_TITAN_TAILNET_IP=100.84.175.105'],
    requires: [
      { kind: 'propPath', file: AETHER_LOCAL, key: 'AETHER_KEYSTORE_PATH' },
      { kind: 'propKeys', file: AETHER_LOCAL, keys: ['AETHER_KEYSTORE_PASSWORD', 'AETHER_KEY_ALIAS', 'AETHER_KEY_PASSWORD'] },
      { kind: 'propPath', file: AETHER_LOCAL, key: 'sdk.dir' },
    ],
    evidence: 'android/app/build.gradle:12-19 (signing keys), :25 (IP property), :120-130 (release-only IP guard), :143-151 (package/sign tasks need the signing keys); memory aether-android-titan-ip-build-prop. Debug vs release as the expected APK is UNVERIFIED (Matt\'s call)',
    verified: false,
  },
  'TarotApp/apk': {
    cwd: '.',
    argv: ['gradlew.bat', 'assembleDebug'],
    requires: [],
    evidence: 'TarotApp/README.md:102-109; phone is debug-signed (memory tarotapp-phone-debug-signed). Installing to the phone is never part of a night',
    verified: false,
  },
  'TokenMonitor/installer': {
    cwd: '.',
    argv: ['npm', 'run', 'dist'],
    requires: [{ kind: 'file', path: 'codesign/pfx-password.txt' }],
    evidence: 'TokenMonitor/CLAUDE.md:25-36. The PDQ deploy that dist mentions is outside the grant and not part of the recipe',
    verified: false,
  },
};

export function getRecipe(project, artifact) {
  const key = `${project}/${artifact}`;
  return Object.prototype.hasOwnProperty.call(RECIPES, key) ? RECIPES[key] : null;
}

export function detectArtifact(text) {
  const s = String(text);
  const apk = /\b(apk|aab)\b/i.test(s);
  const installer = /\b(exe|installer)\b/i.test(s);
  if (apk && installer) return 'both';
  if (apk) return 'apk';
  if (installer) return 'installer';
  return null;
}
