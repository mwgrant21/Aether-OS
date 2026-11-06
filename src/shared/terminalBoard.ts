// Terminal board (S3): one small JSON file per terminal (Alpha/Beta) that records what the
// agent in that terminal is doing, so the two can avoid colliding. Pure logic only: no node
// imports, safe for the renderer. "Store the signal, not the payload": short strings, no
// control characters, no absolute paths.

export const TERMINAL_BOARD_SCHEMA_VERSION = 1;
/** The ONE place the staleness window lives. */
export const TERMINAL_BOARD_STALE_MS = 4 * 60 * 60 * 1000;
export const TERMINAL_BOARD_DIR_NAME = 'terminal-board';

export const BOARD_TERMINALS = ['alpha', 'beta'] as const;
export type BoardTerminal = (typeof BOARD_TERMINALS)[number];
export const BOARD_STATUSES = ['working', 'idle', 'blocked', 'waiting-on-user'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];
export const BOARD_CLAIM_KINDS = ['pr', 'branch', 'worktree', 'file'] as const;
export type BoardClaimKind = (typeof BOARD_CLAIM_KINDS)[number];
export const BOARD_LIMITS = { title: 120, project: 80, ref: 200, note: 200, claims: 50, blockedBy: 50 } as const;

export interface TerminalBoardClaim {
  kind: BoardClaimKind;
  ref: string;
  since: string;
  note?: string;
}
export interface TerminalBoardEntry {
  schemaVersion: 1;
  terminal: BoardTerminal;
  updatedAt: string;
  task: { title: string; project: string; status: BoardStatus } | null;
  claims: TerminalBoardClaim[];
  blockedBy: { ref: string; owner: BoardTerminal }[];
}

export function emptyBoardEntry(terminal: BoardTerminal, nowMs: number): TerminalBoardEntry {
  return {
    schemaVersion: 1,
    terminal,
    updatedAt: new Date(nowMs).toISOString(),
    task: null,
    claims: [],
    blockedBy: [],
  };
}

export type BoardParse = { ok: true; entry: TerminalBoardEntry } | { ok: false; reason: string };

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ABSOLUTE_REF = /^(?:[A-Za-z]:|[\\/]|~)/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isDateString(v: unknown): v is string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}
function isText(v: unknown, max: number, allowEmpty: boolean): v is string {
  if (typeof v !== 'string') return false;
  if (v.length > max || CONTROL_CHARS.test(v)) return false;
  return allowEmpty || v.trim().length > 0;
}
function isRef(v: unknown): v is string {
  return isText(v, BOARD_LIMITS.ref, false) && !ABSOLUTE_REF.test(v.trimStart());
}
function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

/** Validates untrusted board JSON. Never throws. Rejects rather than truncates; the result is
 *  a fresh object built from known keys only. */
export function parseBoardEntry(raw: unknown, expected: BoardTerminal): BoardParse {
  try {
    if (!isRecord(raw)) return { ok: false, reason: 'not-object' };
    if (raw.schemaVersion !== TERMINAL_BOARD_SCHEMA_VERSION) return { ok: false, reason: 'schema-version' };
    if (raw.terminal !== expected) return { ok: false, reason: 'terminal-mismatch' };
    if (!isDateString(raw.updatedAt)) return { ok: false, reason: 'updated-at' };

    let task: TerminalBoardEntry['task'] = null;
    if (raw.task !== null) {
      const t = raw.task;
      if (
        !isRecord(t) ||
        !isText(t.title, BOARD_LIMITS.title, false) ||
        !isText(t.project, BOARD_LIMITS.project, true) ||
        !oneOf(BOARD_STATUSES, t.status)
      ) {
        return { ok: false, reason: 'task' };
      }
      task = { title: t.title, project: t.project, status: t.status };
    }

    if (!Array.isArray(raw.claims)) return { ok: false, reason: 'claim' };
    if (raw.claims.length > BOARD_LIMITS.claims) return { ok: false, reason: 'too-many-claims' };
    const claims: TerminalBoardClaim[] = [];
    for (const c of raw.claims as unknown[]) {
      if (
        !isRecord(c) ||
        !oneOf(BOARD_CLAIM_KINDS, c.kind) ||
        !isRef(c.ref) ||
        !isDateString(c.since) ||
        CONTROL_CHARS.test(c.since) ||
        (c.note !== undefined && !isText(c.note, BOARD_LIMITS.note, true))
      ) {
        return { ok: false, reason: 'claim' };
      }
      const claim: TerminalBoardClaim = { kind: c.kind, ref: c.ref, since: c.since };
      if (c.note !== undefined) claim.note = c.note as string;
      claims.push(claim);
    }

    if (!Array.isArray(raw.blockedBy)) return { ok: false, reason: 'blocked-by' };
    if (raw.blockedBy.length > BOARD_LIMITS.blockedBy) return { ok: false, reason: 'blocked-by' };
    const blockedBy: TerminalBoardEntry['blockedBy'] = [];
    for (const b of raw.blockedBy as unknown[]) {
      if (!isRecord(b) || !isRef(b.ref) || !oneOf(BOARD_TERMINALS, b.owner)) {
        return { ok: false, reason: 'blocked-by' };
      }
      blockedBy.push({ ref: b.ref, owner: b.owner });
    }

    return {
      ok: true,
      entry: { schemaVersion: 1, terminal: expected, updatedAt: raw.updatedAt, task, claims, blockedBy },
    };
  } catch {
    return { ok: false, reason: 'not-object' };
  }
}

/** Age STRICTLY greater than the window is stale; a future updatedAt is not. */
export function isBoardEntryStale(entry: TerminalBoardEntry, nowMs: number): boolean {
  const t = Date.parse(entry.updatedAt);
  if (!Number.isFinite(t)) return false;
  return nowMs - t > TERMINAL_BOARD_STALE_MS;
}

export type BoardViewSource = 'file' | 'missing' | 'invalid';
export interface TerminalBoardView {
  terminal: BoardTerminal;
  source: BoardViewSource;
  entry: TerminalBoardEntry | null;
  stale: boolean;
  reason?: string;
}
export interface TerminalBoardSnapshot {
  at: string;
  terminals: Record<BoardTerminal, TerminalBoardView>;
}

export function classifyBoardText(terminal: BoardTerminal, text: string | null, nowMs: number): TerminalBoardView {
  if (text === null) return { terminal, source: 'missing', entry: null, stale: false };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { terminal, source: 'invalid', entry: null, stale: false, reason: 'bad-json' };
  }
  const parsed = parseBoardEntry(raw, terminal);
  if (!parsed.ok) return { terminal, source: 'invalid', entry: null, stale: false, reason: parsed.reason };
  return { terminal, source: 'file', entry: parsed.entry, stale: isBoardEntryStale(parsed.entry, nowMs) };
}

export function buildBoardSnapshot(
  texts: Record<BoardTerminal, string | null>,
  nowMs: number,
): TerminalBoardSnapshot {
  return {
    at: new Date(nowMs).toISOString(),
    terminals: {
      alpha: classifyBoardText('alpha', texts.alpha, nowMs),
      beta: classifyBoardText('beta', texts.beta, nowMs),
    },
  };
}
