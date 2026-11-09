// Spawn router for the pty-owner helper: decides synchronously whether a spawn goes to the
// helper or stays in-process, and makes the spawn frame safe. A frame the helper rejects
// destroys the connection and with it every slot's I/O, so anything the protocol validator
// would refuse falls back to in-process. Pure and injected: no ptyLifecycle / ptyManager /
// codexPtyManager / node-pty imports (rule 6), types come from protocol.
import { encodeFrame, parseClientFrame, type LaunchSpec, type Meta } from './protocol';
import type { TerminalSlotId } from '../../src/shared/remote/types';

/** Structural shape of the launch specs built by ptyManager / codexPtyManager. */
export interface SpecLike {
  file: string; args: string[]; cwd: string; env: Record<string, string | undefined>;
  cols: number; rows: number; writes: string[];
}

export interface SpawnRouterDeps<R> {
  client: { readonly ready: boolean; spawn(slot: TerminalSlotId, spec: LaunchSpec, meta: Meta): R } | null;
  homedir: string;
  /** Fixed-string diag lines only. */
  log: (line: string) => void;
}

/** Drops undefined values and entries the protocol would reject; never mutates the input. */
function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string' || k.length === 0 || k.includes('=') || k.includes('\0') || v.includes('\0')) continue;
    out[k] = v;
  }
  return out;
}

export function createSpawnRouter<R>(deps: SpawnRouterDeps<R>) {
  return function route<P>(slot: TerminalSlotId, buildSpec: () => SpecLike, meta: Meta, inProcess: () => P): P | R {
    const client = deps.client;
    if (!client || !client.ready) return inProcess();
    const raw = buildSpec(); // a throw propagates, as spawnPty throwing does today
    const spec: LaunchSpec = {
      file: raw.file, args: [...raw.args], cwd: raw.cwd, env: sanitizeEnv(raw.env),
      cols: raw.cols, rows: raw.rows, writes: [...raw.writes],
    };
    try {
      const frame = { t: 'spawn', slot, spec, meta };
      if (!parseClientFrame(JSON.parse(JSON.stringify(frame)), deps.homedir)) throw new Error('rejected');
      encodeFrame(frame);
    } catch {
      deps.log('pty-owner: spawn frame not acceptable, running in-process');
      return inProcess();
    }
    return client.spawn(slot, spec, meta);
  };
}
