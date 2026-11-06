import { promises as fsp } from 'fs';
import { join } from 'path';
import { writeFileAtomically } from './atomicWrite';
import type { SlotEvent } from './terminalHub';
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

// A start-reset and an exit-reset of one slot can overlap; chain them per file so the older
// write cannot land last. Each tail never rejects.
const resetTails = new Map<string, Promise<void>>();

/** Writes an empty entry for `terminal`. Never rejects; the failure result carries only an
 *  error code (no path, no message). Resets of the same file run one after another in call order. */
export function resetTerminalBoardEntry(
  dir: string,
  terminal: BoardTerminal,
  nowMs: number,
): Promise<BoardResetResult> {
  const file = terminalBoardFile(dir, terminal);
  const prev = resetTails.get(file) ?? Promise.resolve();
  const run = prev.then(() => doReset(dir, terminal, nowMs));
  const tail = run.then(() => undefined, () => undefined);
  resetTails.set(file, tail);
  void tail.then(() => {
    if (resetTails.get(file) === tail) resetTails.delete(file);
  });
  return run;
}

async function doReset(dir: string, terminal: BoardTerminal, nowMs: number): Promise<BoardResetResult> {
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

type ObservableSlot = { observe(listener: (event: SlotEvent) => void): () => void };

/** Resets a terminal's board entry whenever its slot's PTY starts or exits. The Codex slot is
 *  deliberately not mapped. A failing or rejecting `reset` is swallowed. Returns detach-all. */
export function attachTerminalBoardReset(
  slots: { claude: ObservableSlot; terminal2: ObservableSlot },
  reset: (terminal: BoardTerminal) => Promise<unknown> | unknown,
): () => void {
  const wire = (slot: ObservableSlot, terminal: BoardTerminal) =>
    slot.observe((event) => {
      if (event.kind !== 'start' && !(event.kind === 'state' && event.state === 'exited')) return;
      try {
        Promise.resolve(reset(terminal)).catch(() => {});
      } catch {
        /* a reset failure must never reach the pty path */
      }
    });
  const detachers = [wire(slots.claude, 'alpha'), wire(slots.terminal2, 'beta')];
  return () => {
    for (const detach of detachers) detach();
  };
}
