// Bundles the terminal page into app/src/main/assets/terminal/ so the Gradle build
// needs no Node and nothing is fetched at runtime. The output is committed.
//
//   node android/web/build.mjs           rebuild
//   node android/web/build.mjs --verify  rebuild in memory and diff against the committed files
//
// Run from anywhere inside the aether-os checkout: esbuild, @xterm/xterm and
// @xterm/addon-fit resolve from the repo's node_modules (no separate install).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'app', 'src', 'main', 'assets', 'terminal');
const require = createRequire(import.meta.url);
const version = (pkg) => JSON.parse(readFileSync(require.resolve(`${pkg}/package.json`), 'utf8')).version;
const xtermVersion = version('@xterm/xterm');
const fitVersion = version('@xterm/addon-fit');

const result = await build({
  entryPoints: [join(here, 'src', 'main.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'chrome110',
  write: false,
  legalComments: 'none',
  banner: { js: `/* aether-mobile terminal: @xterm/xterm ${xtermVersion}, @xterm/addon-fit ${fitVersion} */` },
});

const outputs = new Map([
  ['terminal.js', result.outputFiles[0].text],
  ['xterm.css', readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8')],
]);

if (process.argv.includes('--verify')) {
  let bad = 0;
  for (const [name, text] of outputs) {
    const file = join(outDir, name);
    const same = existsSync(file) && readFileSync(file, 'utf8') === text;
    console.log(`${same ? 'ok     ' : 'DIFFERS'} ${name}`);
    if (!same) bad++;
  }
  process.exit(bad ? 1 : 0);
}

mkdirSync(outDir, { recursive: true });
for (const [name, text] of outputs) writeFileSync(join(outDir, name), text);
console.log(`built terminal.js (${outputs.get('terminal.js').length} bytes) with xterm ${xtermVersion}, addon-fit ${fitVersion}`);
