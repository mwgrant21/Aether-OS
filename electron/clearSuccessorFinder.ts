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
// Privacy: file bytes are only regex-matched for ids; nothing is logged,
// retained or returned except the matching file's path.

/** Window in which the /clear command record is expected. */
export const STAGE1_BYTES = 262144;
/** Window in which the first foreign "session_id" is expected. */
export const STAGE2_BYTES = 2097152;

export interface ClearSuccessorDeps {
  readHead?: (file: string, maxBytes: number) => Promise<string>;
}
export type FindClearSuccessor = (dir: string, launchSessionId: string, pinnedFile: string) => Promise<string | null>;

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

export function createClearSuccessorFinder(deps: ClearSuccessorDeps = {}): FindClearSuccessor {
  const readHead = deps.readHead ?? defaultReadHead;
  let lastLaunchId: string | null = null;
  const decided = new Set<string>();
  const lastSize = new Map<string, number>();
  const stage1Passed = new Set<string>();
  const matches = new Map<string, number>(); // name -> birthtimeMs

  return async function find(dir, launchSessionId, pinnedFile) {
    if (launchSessionId !== lastLaunchId) {
      lastLaunchId = launchSessionId;
      decided.clear();
      lastSize.clear();
      stage1Passed.clear();
      matches.clear();
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
          } else {
            if (st.size >= STAGE1_BYTES) decided.add(name);
            else lastSize.set(name, st.size);
            continue;
          }
        }

        const ownId = name.slice(0, -'.jsonl'.length);
        const text = await readHead(file, Math.min(st.size, STAGE2_BYTES));
        let foreign: string | null = null;
        for (const m of text.matchAll(FOREIGN_ID)) {
          if (m[1] !== ownId) {
            foreign = m[1];
            break;
          }
        }
        if (foreign !== null) {
          if (foreign === launchSessionId) matches.set(name, birth);
          else decided.add(name);
        } else if (st.size >= STAGE2_BYTES) {
          decided.add(name);
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
    return best ? path.join(dir, best) : null;
  };
}
