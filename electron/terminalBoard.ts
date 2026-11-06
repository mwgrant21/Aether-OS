import { promises as fsp } from 'fs';
import { join } from 'path';
import { writeFileAtomically } from './atomicWrite';
import {
  BOARD_TERMINALS,
  buildBoardSnapshot,
  emptyBoardEntry,
  type BoardTerminal,
  type TerminalBoardSnapshot,
  type TerminalBoardView,
} from '../src/shared/terminalBoard';

// Terminal board files (privacy section 19): one JSON file per terminal under
// ~/.aether-os/terminal-board/. Main only ever writes an EMPTY entry here.

export function terminalBoardFile(dir: string, terminal: BoardTerminal): string {
  return join(dir, `${terminal}.json`);
}

type ReadOutcome = { text: string | null } | { unreadable: true };

async function readOne(dir: string, terminal: BoardTerminal): Promise<ReadOutcome> {
  try {
    return { text: await fsp.readFile(terminalBoardFile(dir, terminal), 'utf8') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { text: null };
    return { unreadable: true };
  }
}

/** Never rejects. */
export async function readTerminalBoardSnapshot(dir: string, nowMs: number): Promise<TerminalBoardSnapshot> {
  const outcomes = await Promise.all(BOARD_TERMINALS.map((t) => readOne(dir, t)));
  const texts = { alpha: null, beta: null } as Record<BoardTerminal, string | null>;
  const unreadable = new Set<BoardTerminal>();
  BOARD_TERMINALS.forEach((t, i) => {
    const o = outcomes[i];
    if ('unreadable' in o) unreadable.add(t);
    else texts[t] = o.text;
  });
  const snap = buildBoardSnapshot(texts, nowMs);
  for (const t of unreadable) {
    const view: TerminalBoardView = { terminal: t, source: 'invalid', entry: null, stale: false, reason: 'unreadable' };
    snap.terminals[t] = view;
  }
  return snap;
}

export type BoardResetResult = { ok: true } | { ok: false; code: string };

/** Writes an empty entry for `terminal`. Never rejects; the failure result carries only an
 *  error code (no path, no message). */
export async function resetTerminalBoardEntry(
  dir: string,
  terminal: BoardTerminal,
  nowMs: number,
): Promise<BoardResetResult> {
  try {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomically(
      terminalBoardFile(dir, terminal),
      JSON.stringify(emptyBoardEntry(terminal, nowMs), null, 2) + '\n',
    );
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return { ok: false, code: typeof code === 'string' ? code : 'EUNKNOWN' };
  }
}
