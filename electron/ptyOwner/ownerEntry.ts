// Entry of the detached pty-owner helper (bundled to out/main/pty-owner.js). The ONLY file in
// ptyOwner/ that imports node-pty; everything else stays testable with a fake pty.
// Launcher contract: stdio is ignored, so this writes nothing to the console. Config comes from
// env (no secrets): AETHER_PTY_OWNER_DISCOVERY (or argv[2]), AETHER_PTY_OWNER_GRACE_MS (default
// 15 min), AETHER_PTY_OWNER_IDLE_MS (optional). Exit 0 once the owner has closed; exit 1 if it
// never started listening (`closed` does not settle in that case).
import os from 'node:os';
import * as pty from 'node-pty';
import { createOwner } from './ownerCore';

const DEFAULT_GRACE_MS = 15 * 60_000;
const posInt = (v: string | undefined): number | undefined => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

const discoveryPath = process.env.AETHER_PTY_OWNER_DISCOVERY || process.argv[2];
if (!discoveryPath) process.exit(2);

const owner = createOwner({
  spawn: (spec) => {
    const p = pty.spawn(spec.file, spec.args, { name: 'xterm-color', cols: spec.cols, rows: spec.rows, cwd: spec.cwd, env: spec.env });
    for (const w of spec.writes) p.write(w);
    return p;
  },
  homedir: os.homedir(),
  discoveryPath,
  graceMs: posInt(process.env.AETHER_PTY_OWNER_GRACE_MS) ?? DEFAULT_GRACE_MS,
  idleMs: posInt(process.env.AETHER_PTY_OWNER_IDLE_MS),
});

owner.listening.then(
  () => { void owner.closed.then(() => process.exit(0)); },
  () => process.exit(1),
);
