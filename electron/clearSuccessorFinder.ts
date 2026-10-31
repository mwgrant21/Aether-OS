import { promises as fsp } from 'fs';
import path from 'path';

// After `/clear` Claude Code keeps the pty but starts a new session id and a
// new .jsonl in the same project dir. This finder locates that successor so
// the tracker can move its pin. It never uses recency as the decision (an
// unrelated concurrent session can be newer): a candidate must (1) carry the
// /clear command record and (2) carry the launch id of THIS app's claude
// process as a top-level snake_case "session_id" field.
//
// Evidence (Claude Code 2.1.312, ~40 real transcripts): the /clear record sits
// at ~72-77 KB; the first foreign "session_id" (always the chain root, i.e.
// the launch id, even after repeated /clears) appears at ~262-668 KB, only
// after the first prompt that follows /clear. The "session_id" field is an
// undocumented Claude Code artifact: if it disappears, this returns null and
// the pin simply never follows (today's behavior).
//
// Immediate follow: when the caller passes clearHintMs (the app saw the user
// submit a typed /clear at that time) a stage-1 candidate that has no
// session_id yet may be accepted PROVISIONALLY, but only if exactly ONE
// candidate's /clear record timestamp is within CLEAR_HINT_WINDOW_MS of the
// hint and it was born at/after the pinned file. Zero or several in-window
// candidates return null. Recency alone / "newest file with a /clear record"
// is never accepted. A provisional file is re-checked on every scan: a foreign
// session_id equal to the launch id confirms it, any other foreign id evicts
// it (the pre-provisional pin is returned so the tracker repins to it).
//
// Privacy: file bytes are only regex-matched for ids; nothing is logged,
// retained or returned except the matching file's path.

/** Window in which the /clear command record is expected. */
export const STAGE1_BYTES = 262144;
/** Window in which the first foreign "session_id" is expected. */
export const STAGE2_BYTES = 2097152;

export interface ClearSuccessorDeps {
  readHead?: (file: string, maxBytes: number) => Promise<string>;
}
/** Max distance between a /clear record timestamp and the typed-/clear hint. */
export const CLEAR_HINT_WINDOW_MS = 10_000;
export type FindClearSuccessor = (
  dir: string,
  launchSessionId: string,
  pinnedFile: string,
  clearHintMs?: number,
) => Promise<string | null>;

async function defaultReadHead(file: string, maxBytes: number): Promise<string> {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

const CLEAR_RECORD = /"commandRun":\{"command":"clear"/;
const CLEAR_TAG = '<command-name>/clear</command-name>';
const FOREIGN_ID = /"session_id":"([0-9a-f-]{36})"/g;
const TS_FIELD = /"timestamp":"([^"]+)"/;

// Timestamp (ms) of the line holding the /clear record, in memory only. The
// commandRun line wins over the <command-name> line; null when absent/invalid.
function clearRecordTs(head: string): number | null {
  let at = head.search(CLEAR_RECORD);
  if (at < 0) at = head.indexOf(CLEAR_TAG);
  if (at < 0) return null;
  const start = head.lastIndexOf('\n', at) + 1;
  const endIdx = head.indexOf('\n', at);
  const line = head.slice(start, endIdx < 0 ? head.length : endIdx);
  let raw: unknown;
  try {
    raw = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
  } catch {
    raw = TS_FIELD.exec(line)?.[1];
  }
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function firstForeignId(text: string, ownId: string): string | null {
  for (const m of text.matchAll(FOREIGN_ID)) if (m[1] !== ownId) return m[1];
  return null;
}

export function createClearSuccessorFinder(deps: ClearSuccessorDeps = {}): FindClearSuccessor {
  const readHead = deps.readHead ?? defaultReadHead;
  let lastLaunchId: string | null = null;
  const decided = new Set<string>();
  const lastSize = new Map<string, number>();
  const stage1Passed = new Set<string>();
  const matches = new Map<string, number>(); // name -> birthtimeMs
  const pending = new Map<string, { birth: number; ts: number | null }>(); // stage 1 passed, no foreign id yet
  let provisional: { name: string; from: string } | null = null;

  return async function find(dir, launchSessionId, pinnedFile, clearHintMs) {
    if (launchSessionId !== lastLaunchId) {
      lastLaunchId = launchSessionId;
      decided.clear();
      lastSize.clear();
      stage1Passed.clear();
      matches.clear();
      pending.clear();
      provisional = null;
    }
    let names: string[];
    let pinnedBirth: number;
    try {
      names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.jsonl'));
      const ps = await fsp.stat(pinnedFile);
      pinnedBirth = ps.birthtimeMs > 0 && Number.isFinite(ps.birthtimeMs) ? ps.birthtimeMs : ps.mtimeMs;
      if (!Number.isFinite(pinnedBirth)) return null;
    } catch {
      return null;
    }
    const pinnedName = path.basename(pinnedFile);
    const present = new Set(names);
    for (const m of [...matches.keys()]) if (!present.has(m)) matches.delete(m);
    for (const p of [...pending.keys()]) if (!present.has(p)) pending.delete(p);

    // The loop below skips the pinned name, so a provisional pin is re-checked here.
    if (provisional && pinnedName !== provisional.name) provisional = null;
    if (provisional) {
      const pv = provisional;
      try {
        const pfile = path.join(dir, pv.name);
        const st = await fsp.stat(pfile);
        if (lastSize.get(pv.name) !== st.size) {
          const foreign = firstForeignId(await readHead(pfile, Math.min(st.size, STAGE2_BYTES)), pv.name.slice(0, -'.jsonl'.length));
          if (foreign === launchSessionId) {
            matches.set(pv.name, st.birthtimeMs > 0 && Number.isFinite(st.birthtimeMs) ? st.birthtimeMs : st.mtimeMs);
            provisional = null;
          } else if (foreign !== null) {
            decided.add(pv.name);
            provisional = null;
            return pv.from;
          } else {
            lastSize.set(pv.name, st.size);
          }
        }
      } catch {
        // Keep provisional state; never throw.
      }
    }

    for (const name of names) {
      if (name === pinnedName || decided.has(name) || matches.has(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = await fsp.stat(file);
        const usable = st.birthtimeMs > 0 && Number.isFinite(st.birthtimeMs);
        const birth = usable ? st.birthtimeMs : st.mtimeMs;
        if (birth < pinnedBirth) {
          decided.add(name);
          continue;
        }
        if (lastSize.get(name) === st.size) continue;

        if (!stage1Passed.has(name)) {
          const head = await readHead(file, Math.min(st.size, STAGE1_BYTES));
          if (CLEAR_RECORD.test(head) || head.includes(CLEAR_TAG)) {
            stage1Passed.add(name);
            pending.set(name, { birth, ts: clearRecordTs(head) });
          } else {
            if (st.size >= STAGE1_BYTES) decided.add(name);
            else lastSize.set(name, st.size);
            continue;
          }
        }

        const ownId = name.slice(0, -'.jsonl'.length);
        const text = await readHead(file, Math.min(st.size, STAGE2_BYTES));
        const foreign = firstForeignId(text, ownId);
        if (foreign !== null) {
          pending.delete(name);
          if (foreign === launchSessionId) matches.set(name, birth);
          else decided.add(name);
        } else if (st.size >= STAGE2_BYTES) {
          decided.add(name);
          pending.delete(name);
        } else {
          lastSize.set(name, st.size);
        }
      } catch {
        // One unreadable entry never fails the sweep.
      }
    }

    let best: string | null = null;
    let bestBirth = -Infinity;
    for (const [name, birth] of matches) {
      if (birth > bestBirth) {
        bestBirth = birth;
        best = name;
      }
    }
    if (best) return path.join(dir, best);

    if (provisional === null && clearHintMs !== undefined) {
      const eligible: string[] = [];
      for (const [name, p] of pending) {
        if (p.ts !== null && Math.abs(p.ts - clearHintMs) <= CLEAR_HINT_WINDOW_MS && p.birth >= pinnedBirth) eligible.push(name);
      }
      if (eligible.length === 1) {
        provisional = { name: eligible[0], from: pinnedFile };
        pending.delete(eligible[0]);
        return path.join(dir, eligible[0]);
      }
    }
    return null;
  };
}
