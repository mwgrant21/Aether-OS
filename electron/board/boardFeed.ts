// Session listing and ordered feed assembly for the Traffic board. Pure fs +
// path + readline: no electron import, so a later API can call it. Everything
// is built per call from the transcript files and returned; nothing is cached
// at module level and nothing is written (render-not-store).
import { createReadStream, promises as fsp } from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { isSafeSegment } from '../transcriptReader';
import { parseBoardLine, type RawBoardEvent } from './boardParser';
import { capBody, maskSecrets } from '../../src/shared/board/text';
import {
  BODY_CAP,
  MAX_POSTS,
  type BoardFeedResult,
  type BoardParty,
  type BoardPost,
  type BoardProject,
  type BoardSessionRef,
  type BoardSessionSummary,
} from '../../src/shared/board/types';

export interface BoardFeedDeps {
  projectOf: (cwd: string | null) => BoardProject | null;
  now?: () => number; // default Date.now
  maxFileBytes?: number; // default 256 MB; larger files count as unreadable
}

const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
const SUBJECT_CAP = 200;
const STUB_RE = /delivered to you as a message from/i;
const TITLE_SCAN_BYTES = 4 * 1024 * 1024; // real first prompts sit behind ~130 KB request-blob lines
const TITLE_CAP = 60;
// Wrapper lines the harness injects as user turns; none is something the human typed.
const NON_PROMPT_RE = /^\s*(?:<command-|<local-command|<system-reminder|<task-notification|<agent-message|<user-prompt-submit-hook|Caveat:)/;
const HEX_ID_RE = /^[0-9a-f]{12,}$/i;
// Absolute paths in a title: drive-letter (C:\a\b, C:/a/b), UNC (\\host\share\x) and
// POSIX with at least two segments (/home/x/y). Each is shortened to its last segment.
const ABS_PATH_RE = /(?:\b[A-Za-z]:[\\/]|\\\\[^\s\\/]|(?<![\w.:/\\])\/[^\s/\\]+\/)[^\s"'<>|*?]*/g;

function shortenPaths(text: string): string {
  return text.replace(ABS_PATH_RE, (m) => {
    const tail = /[.,;:!)\]}]+$/.exec(m)?.[0] ?? '';
    const body = tail ? m.slice(0, -tail.length) : m;
    const last = body.split(/[\\/]/).filter(Boolean).pop();
    return (last ?? body) + tail;
  });
}

const MAIN: BoardParty = { kind: 'main', name: 'main', agentId: null };
const ALL: BoardParty = { kind: 'all', name: 'all', agentId: null };
const UNKNOWN: BoardParty = { kind: 'unknown', name: 'unknown', agentId: null };

/** First `"cwd":"..."` in the first 64 KB of a transcript, mapped through deps.projectOf. */
async function projectFromHead(file: string, deps: BoardFeedDeps): Promise<BoardProject | null> {
  let fh: fsp.FileHandle | null = null;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, bytesRead));
    let cwd: string | null = null;
    if (m) {
      try {
        cwd = JSON.parse('"' + m[1] + '"') as string;
      } catch {
        cwd = null;
      }
    }
    return deps.projectOf(cwd);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** First human-typed prompt in the head of a parent transcript, masked and shortened; null if none. */
async function titleFromHead(file: string): Promise<string | null> {
  const input = createReadStream(file, { encoding: 'utf8', start: 0, end: TITLE_SCAN_BYTES - 1 });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('"user"')) continue;
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        continue; // includes a line cut off by the byte bound
      }
      if (!j || j.type !== 'user' || (j.origin && j.origin.kind !== 'human') || j.isMeta || j.isSidechain || j.isCompactSummary || j.isVisibleInTranscriptOnly) continue;
      const c = j.message?.content;
      let text: string | null = null;
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c) && !c.some((i: any) => i?.type === 'tool_result')) {
        const t = c.find((i: any) => i?.type === 'text' && typeof i.text === 'string');
        text = t ? t.text : null;
      }
      if (text === null || NON_PROMPT_RE.test(text)) continue;
      const clean = shortenPaths(maskSecrets(text)).replace(/\s+/g, ' ').trim();
      if (!clean) continue;
      if (clean.length <= TITLE_CAP) return clean;
      return capBody(clean, TITLE_CAP - 1).body + '\u2026';
    }
    return null;
  } catch {
    return null;
  } finally {
    rl.close();
    input.destroy(); // rl.close() does not release the fd on an early return
  }
}

async function countSubagents(sessionDir: string): Promise<number> {
  try {
    const names = await fsp.readdir(path.join(sessionDir, 'subagents'));
    return names.filter((n) => n.endsWith('.jsonl')).length;
  } catch {
    return 0;
  }
}

export async function listBoardSessions(
  projectsRoot: string,
  deps: BoardFeedDeps,
  opts: { limit?: number; maxAgeMs?: number } = {},
): Promise<BoardSessionSummary[]> {
  const limit = opts.limit ?? 40;
  const maxAgeMs = opts.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
  const now = (deps.now ?? Date.now)();
  const found: { projectDir: string; sessionId: string; file: string; mtimeMs: number; size: number }[] = [];

  let dirs: string[] = [];
  try {
    dirs = (await fsp.readdir(projectsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && isSafeSegment(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
  for (const projectDir of dirs) {
    let names: string[];
    try {
      names = await fsp.readdir(path.join(projectsRoot, projectDir));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      try {
        const file = path.join(projectsRoot, projectDir, n);
        const st = await fsp.stat(file);
        if (!st.isFile() || st.size <= 0 || now - st.mtimeMs > maxAgeMs) continue;
        found.push({ projectDir, sessionId: n.slice(0, -'.jsonl'.length), file, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* skip a failing entry */
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const out: BoardSessionSummary[] = [];
  for (const f of found.slice(0, limit)) {
    try {
      out.push({
        projectDir: f.projectDir,
        sessionId: f.sessionId,
        project: await projectFromHead(f.file, deps),
        title: await titleFromHead(f.file),
        lastActiveMs: f.mtimeMs,
        sizeBytes: f.size,
        subagentCount: await countSubagents(path.join(projectsRoot, f.projectDir, f.sessionId)),
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

interface FileData {
  key: string; // 'main' or 'agent-<id>'
  agentId: string | null;
  order: number;
  events: RawBoardEvent[];
}
interface Meta {
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
}
type DispatchEvent = Extract<RawBoardEvent, { type: 'dispatch' }>;

async function readEvents(file: string): Promise<RawBoardEvent[]> {
  const events: RawBoardEvent[] = [];
  let lastAt = 0;
  const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let i = 0;
  try {
    for await (const line of rl) {
      const idx = i++;
      for (const e of parseBoardLine(line, idx)) {
        // A missing timestamp inherits the previous dated event in this file, else 0.
        if (e.atMs === null) e.atMs = lastAt;
        else lastAt = e.atMs;
        events.push(e);
      }
    }
  } finally {
    rl.close();
  }
  return events;
}

async function readMeta(file: string): Promise<Meta | null> {
  try {
    const j = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
    const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
    return { agentType: s(j.agentType), description: s(j.description), toolUseId: s(j.toolUseId) };
  } catch {
    return null;
  }
}

interface Draft {
  kind: BoardPost['kind'];
  from: BoardParty;
  to: BoardParty;
  startedBy: string | null;
  subject: string | null;
  raw: string;
  status: BoardPost['status'];
}

export async function buildBoardFeed(
  projectsRoot: string,
  ref: BoardSessionRef,
  deps: BoardFeedDeps,
): Promise<BoardFeedResult> {
  if (
    !ref ||
    typeof ref.projectDir !== 'string' ||
    typeof ref.sessionId !== 'string' ||
    !isSafeSegment(ref.projectDir) ||
    !isSafeSegment(ref.sessionId)
  ) {
    return { ok: false, error: 'Invalid session.' };
  }
  try {
    const root = path.resolve(projectsRoot);
    const dir = path.resolve(root, ref.projectDir);
    const rel = path.relative(root, dir);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return { ok: false, error: 'Invalid session.' };
    const mainFile = path.join(dir, `${ref.sessionId}.jsonl`);
    try {
      await fsp.stat(mainFile);
    } catch {
      return { ok: false, error: 'Session not found.' };
    }
    const maxBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    let unreadable = 0;

    const files: { key: string; agentId: string | null; file: string }[] = [{ key: 'main', agentId: null, file: mainFile }];
    const subDir = path.join(dir, ref.sessionId, 'subagents');
    let subNames: string[] = [];
    try {
      subNames = (await fsp.readdir(subDir)).filter((n) => /^agent-.+\.jsonl$/.test(n)).sort();
    } catch {
      subNames = [];
    }
    for (const n of subNames) {
      const base = n.slice(0, -'.jsonl'.length);
      files.push({ key: base, agentId: base.slice('agent-'.length), file: path.join(subDir, n) });
    }

    const data: FileData[] = [];
    const metaById = new Map<string, Meta>();
    for (const [order, f] of files.entries()) {
      try {
        if ((await fsp.stat(f.file)).size > maxBytes) {
          unreadable++;
          continue;
        }
        data.push({ key: f.key, agentId: f.agentId, order, events: await readEvents(f.file) });
      } catch {
        unreadable++;
        continue;
      }
      if (f.agentId) {
        const meta = await readMeta(path.join(subDir, `agent-${f.agentId}.meta.json`));
        if (meta) metaById.set(f.agentId, meta);
      }
    }

    // ---- identity maps ----
    const fileAgentIds = new Set(files.filter((f) => f.agentId).map((f) => f.agentId as string));
    const dispatchById = new Map<string, { ev: DispatchEvent; author: string }>();
    const peerNames = new Map<string, string>();
    const agentIdByToolUseId = new Map<string, string>();
    const toolUseIdByAgentId = new Map<string, string>();
    // The parser emits '' for an absent id. '' is never stored in dispatchById, so no notification can link it.
    const link = (agentId: string | null, toolUseId: string | null): void => {
      if (!agentId || toolUseId === null) return;
      if (!agentIdByToolUseId.has(toolUseId)) agentIdByToolUseId.set(toolUseId, agentId);
      if (!toolUseIdByAgentId.has(agentId)) toolUseIdByAgentId.set(agentId, toolUseId);
    };
    for (const d of data) {
      for (const e of d.events) {
        if (e.type === 'dispatch' && e.toolUseId && !dispatchById.has(e.toolUseId)) {
          dispatchById.set(e.toolUseId, { ev: e, author: d.key });
        }
        if (e.type === 'peer' && e.fromAgentId && e.fromName && !peerNames.has(e.fromAgentId)) {
          peerNames.set(e.fromAgentId, e.fromName);
        }
      }
    }
    for (const [id, m] of metaById) link(id, m.toolUseId);
    for (const d of data) {
      for (const e of d.events) {
        if (e.type === 'notification' && dispatchById.has(e.toolUseId ?? '')) link(e.taskId, e.toolUseId);
      }
    }
    const knownAgent = (id: string | null): id is string =>
      !!id && (fileAgentIds.has(id) || toolUseIdByAgentId.has(id) || metaById.has(id));

    const agentName = (id: string): string => {
      const tuid = toolUseIdByAgentId.get(id);
      const st = tuid ? dispatchById.get(tuid)?.ev.subagentType : null;
      return st || metaById.get(id)?.agentType || peerNames.get(id) || 'agent';
    };
    const agentParty = (id: string | null, fallbackName?: string | null): BoardParty => {
      if (knownAgent(id)) return { kind: 'agent', name: agentName(id), agentId: id };
      if (fallbackName) return { kind: 'agent', name: fallbackName, agentId: null };
      return UNKNOWN;
    };
    const partyByKey = new Map<string, BoardParty>(
      data.map((d) => [d.key, d.agentId ? agentParty(d.agentId) : MAIN] as [string, BoardParty]),
    );
    const descriptionOf = (id: string | null): string | null => {
      if (!id) return null;
      const tuid = toolUseIdByAgentId.get(id);
      return metaById.get(id)?.description || (tuid ? dispatchById.get(tuid)?.ev.description : null) || null;
    };
    const startedByOf = (p: BoardParty): string | null => {
      if (p.kind !== 'agent' || !p.agentId) return null;
      const tuid = toolUseIdByAgentId.get(p.agentId);
      const author = tuid ? dispatchById.get(tuid)?.author : null;
      return (author && partyByKey.get(author)?.name) || null;
    };
    const recipient = (to: string, kind: string | null): BoardParty => {
      if (!to) return UNKNOWN;
      if (to === '*') return ALL;
      if (to === 'main' || kind === 'main') return MAIN;
      if (fileAgentIds.has(to) || toolUseIdByAgentId.has(to) || metaById.has(to)) return agentParty(to);
      if (to.startsWith('uds:')) return { kind: 'peer', name: 'peer session', agentId: null };
      if (kind === 'agent' || HEX_ID_RE.test(to)) return UNKNOWN;
      return { kind: 'peer', name: to, agentId: null };
    };

    // ---- events -> posts ----
    const drafts: { post: BoardPost; sort: [number, number, number, number] }[] = [];
    const seen = new Set<string>();
    for (const d of data) {
      const self = partyByKey.get(d.key) as BoardParty;
      const counts = new Map<number, number>();
      for (const e of d.events) {
        const n = counts.get(e.lineIndex) ?? 0;
        counts.set(e.lineIndex, n + 1);
        if ((e.type === 'dispatch' || e.type === 'send') && e.toolUseId) {
          const k = `${e.type}:${e.toolUseId}`;
          if (seen.has(k)) continue;
          seen.add(k);
        }
        let x: Draft;
        if (e.type === 'dispatch') {
          const linked = agentIdByToolUseId.get(e.toolUseId) ?? null;
          const to: BoardParty = linked
            ? agentParty(linked)
            : { kind: 'agent', name: e.subagentType ?? 'agent', agentId: null };
          x = { kind: 'dispatch', from: self, to, startedBy: startedByOf(self), subject: e.description, raw: e.prompt, status: null };
        } else if (e.type === 'send') {
          x = {
            kind: 'message', from: self, to: recipient(e.to, e.recipientKind), startedBy: startedByOf(self),
            subject: e.summary, raw: e.message, status: null,
          };
        } else if (e.type === 'peer') {
          let from: BoardParty;
          if (knownAgent(e.fromAgentId)) from = agentParty(e.fromAgentId, e.fromName);
          else if (e.originKind === 'peer' && !e.isHandback) from = { kind: 'peer', name: e.fromName ?? 'peer session', agentId: null }; // real cross-session message
          else continue; // unknown hand-back, or a memory-observer wrapper quoting an agent-message
          x = {
            kind: e.isHandback ? 'handback' : 'message', from, to: self, startedBy: startedByOf(from),
            subject: e.isHandback ? descriptionOf(e.fromAgentId) : null, raw: e.text, status: null,
          };
        } else {
          // Task notifications also report shell commands, workflows and monitors: keep only this session's agents.
          const viaDispatch = dispatchById.has(e.toolUseId ?? '');
          if (!viaDispatch && !knownAgent(e.taskId)) continue;
          if (STUB_RE.test(e.result)) continue;
          const id = knownAgent(e.taskId) ? e.taskId : agentIdByToolUseId.get(e.toolUseId ?? '') ?? null;
          const from = agentParty(id);
          if (from.kind === 'unknown') continue; // matched only by tool-use-id, sender unresolvable
          x = {
            kind: 'handback', from, to: self, startedBy: startedByOf(from), subject: e.summary,
            raw: e.result || e.summary || '', status: e.status,
          };
        }
        const atMs = e.atMs ?? 0;
        drafts.push({
          post: {
            id: `${d.key}:${e.lineIndex}:${n}`,
            atMs,
            kind: x.kind,
            from: x.from,
            to: x.to,
            startedBy: x.startedBy,
            subject: x.subject && capBody(maskSecrets(x.subject), SUBJECT_CAP).body,
            ...capBody(maskSecrets(x.raw), BODY_CAP),
            status: x.status,
          },
          sort: [atMs, d.order, e.lineIndex, n],
        });
      }
    }
    drafts.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2] - b.sort[2] || a.sort[3] - b.sort[3]);
    const capped = drafts.length > MAX_POSTS;
    const posts = (capped ? drafts.slice(drafts.length - MAX_POSTS) : drafts).map((x) => x.post);
    return { ok: true, feed: { ref, project: await projectFromHead(mainFile, deps), posts, capped, unreadableFiles: unreadable } };
  } catch {
    return { ok: false, error: 'Could not read this session.' };
  }
}
