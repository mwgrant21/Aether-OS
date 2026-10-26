// Pure transcript-line -> thread-op parser (V3-A3 T3, spec section 4.2). One JSONL line in, ThreadOps out.
// Every string that reaches an op goes through threadRedact FIRST and the wire cap is applied AFTER, because a
// redaction marker can be longer than the text it replaces and the phone hard-rejects any over-cap field.
// Reads only message.content (+ stop_reason/usage/flags). It NEVER reads the top-level `toolUseResult`.
// No fs, no electron, no logging, no bypass parameter.
import { NON_PROMPT_RE, shortenPaths } from '../board/boardFeed';
import { parseTranscriptLine } from '../transcriptParser';
import {
  THREAD_DIFF_INLINE_LINES,
  THREAD_LABEL_CAP,
  THREAD_TEXT_CAP,
  type ThreadDetail,
  type ThreadDiffLine,
  type ThreadEntry,
  type ThreadThinkingEntry,
  type ThreadToolEntry,
} from '../../src/shared/remote/threadTypes';
import { isSensitivePath, redactText, redactToolInput, redactToolOutput } from './threadRedact';

const NAME_CAP = 40;
const DIFF_LINE_CAP = 200;
// Raw strings are trimmed before the regex passes. Every wire cap is far below this, so a secret that
// straddles the trim point lies beyond what any field can show.
const PRE_TRIM = 65536;
const MAX_OPEN_TOOLS = 500;
const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const;
const PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DIFF_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

export interface OpenTool {
  id: string;
  entry: ThreadToolEntry;
  path: string | null;
  sensitive: boolean;
  input: { text: string; more: number } | null;
}
/** Owned by the caller (the feed); one per transcript. */
export interface ThreadParseCtx {
  open: Map<string, OpenTool>;
}
export function createParseCtx(): ThreadParseCtx {
  return { open: new Map() };
}

export type ThreadOp =
  | { op: 'add'; e: ThreadEntry; detail?: ThreadDetail }
  | { op: 'upd'; e: ThreadEntry; detail?: ThreadDetail }
  | { op: 'usage'; ctxTok: number; outTok: number; ts: number; endTurn: boolean }
  | { op: 'prompt'; ts: number };

/** Code-unit cap that never leaves half a surrogate pair at the end. */
function capChars(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

function pre(s: string): string {
  return s.length > PRE_TRIM ? s.slice(0, PRE_TRIM) : s;
}

function body(s: string): { x: string; tr: boolean } {
  const red = redactText(pre(s));
  const x = capChars(red, THREAD_TEXT_CAP);
  return { x, tr: s.length > PRE_TRIM || red.length > THREAD_TEXT_CAP };
}

function oneLine(s: string, cap: number): string {
  return capChars(shortenPaths(redactText(pre(s))).replace(/\s+/g, ' ').trim(), cap);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function pathOf(name: string, input: any): string | null {
  if (!PATH_TOOLS.has(name) || !input || typeof input !== 'object') return null;
  for (const k of PATH_KEYS) {
    const v = str(input[k]);
    if (v) return v;
  }
  return null;
}

function labelFor(name: string, input: any, path: string | null): string {
  const i = input && typeof input === 'object' ? input : {};
  let raw: string | null = null;
  if (name === 'Bash') raw = (str(i.command) ?? '').split(/\r?\n/, 1)[0] ?? '';
  else if (path) raw = basename(path);
  else if (name === 'Grep' || name === 'Glob') raw = str(i.pattern);
  else if (name === 'Agent' || name === 'Task') raw = str(i.subagent_type) || str(i.description);
  const l = raw ? oneLine(raw, THREAD_LABEL_CAP) : '';
  return l === '' ? oneLine(name, THREAD_LABEL_CAP) : l;
}

function scalarLine(k: string, v: unknown): string | null {
  if (typeof v === 'string') return `${k}: ${v}`;
  if (typeof v === 'number' || typeof v === 'boolean') return `${k}: ${String(v)}`;
  if (v && typeof v === 'object') {
    try {
      return `${k}: ${JSON.stringify(v)}`;
    } catch {
      return null;
    }
  }
  return null;
}

/** The raw (unredacted, uncapped) input text for the tap, per tool; null when the tool has no input. */
function rawInputText(name: string, input: any, path: string | null): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input;
  const parts: string[] = [];
  const edit = (o: any): void => {
    const oldS = str(o?.old_string);
    const newS = str(o?.new_string);
    if (oldS !== null) parts.push('- old:', oldS);
    if (newS !== null) parts.push('+ new:', newS);
  };
  if (name === 'Bash') return str(i.command);
  if (name === 'Edit') {
    if (path) parts.push(path);
    edit(i);
  } else if (name === 'MultiEdit') {
    if (path) parts.push(path);
    if (Array.isArray(i.edits)) for (const e of i.edits) edit(e);
  } else if (name === 'Write') {
    if (path) parts.push(path);
    const c = str(i.content);
    if (c !== null) parts.push(c);
  } else if (path) {
    parts.push(path);
  } else if (name === 'Grep' || name === 'Glob') {
    for (const k of ['pattern', 'path', 'glob']) {
      const l = scalarLine(k, i[k]);
      if (l && typeof i[k] === 'string') parts.push(l);
    }
  } else if (name === 'Agent' || name === 'Task') {
    for (const k of ['subagent_type', 'description', 'prompt']) {
      const l = scalarLine(k, i[k]);
      if (l && typeof i[k] === 'string') parts.push(l);
    }
  } else {
    for (const k of Object.keys(i)) {
      const l = scalarLine(k, i[k]);
      if (l) parts.push(l);
    }
  }
  const t = parts.join('\n');
  return t === '' ? null : t;
}

/** S7/S8: redacted, capped (2 KB / 30 lines) input. A sensitive path keeps only the path plus the deny sentence. */
function inputDetail(
  name: string,
  input: any,
  path: string | null,
  sensitive: boolean,
): { text: string; more: number } | null {
  if (sensitive && path) {
    const p = redactToolInput(capChars(path, 400), { sensitivePath: false }).text;
    const deny = redactToolInput('', { sensitivePath: true }).text;
    return { text: `${p}\n${deny}`, more: 0 };
  }
  const raw = rawInputText(name, input, path);
  if (raw === null) return null;
  return redactToolInput(pre(raw), { sensitivePath: false });
}

function diffFor(name: string, input: any): { df: ThreadDiffLine[]; dn: number } | null {
  if (!DIFF_TOOLS.has(name) || !input || typeof input !== 'object') return null;
  const all: ThreadDiffLine[] = [];
  const push = (op: '-' | '+', s: string | null): void => {
    if (s === null || s === '') return;
    const lines = redactText(pre(s)).split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    for (const l of lines) {
      all.push([op, capChars(l, DIFF_LINE_CAP)]);
      if (all.length > 100000) return;
    }
  };
  if (name === 'Write') push('+', str(input.content));
  else if (name === 'Edit') {
    push('-', str(input.old_string));
    push('+', str(input.new_string));
  } else if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      push('-', str(e?.old_string));
      push('+', str(e?.new_string));
    }
  }
  if (all.length === 0) return null;
  return { df: all.slice(0, THREAD_DIFF_INLINE_LINES), dn: Math.max(0, all.length - THREAD_DIFF_INLINE_LINES) };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((i) => i && i.type === 'text' && typeof i.text === 'string')
      .map((i) => i.text as string)
      .join('\n');
  }
  return '';
}

export function parseThreadLine(line: string, offsetKey: number, ctx: ThreadParseCtx): ThreadOp[] {
  const ev = parseTranscriptLine(line);
  if (!ev || (ev.kind !== 'assistant' && ev.kind !== 'user')) return [];
  let raw: any;
  try {
    raw = JSON.parse(line.trim());
  } catch {
    return [];
  }
  if (!raw || raw.isSidechain) return [];
  const ts = ev.timestamp && !Number.isNaN(ev.timestamp.getTime()) ? ev.timestamp.getTime() : 0;
  const out: ThreadOp[] = [];
  let n = 0;
  const nextId = (): string => `${offsetKey}:${n++}`;
  const content: any[] = Array.isArray(raw.message?.content) ? raw.message.content : [];

  if (ev.kind === 'assistant') {
    let textDone = false;
    const joined = content
      .filter((i) => i && i.type === 'text' && typeof i.text === 'string')
      .map((i) => i.text as string)
      .join('\n');
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'text') {
        if (textDone) continue;
        textDone = true;
        if (joined.trim() === '') continue;
        const b = body(joined);
        out.push({ op: 'add', e: { id: nextId(), ts, k: 'a', x: b.x, tr: b.tr } });
      } else if (item.type === 'thinking') {
        const text = typeof item.thinking === 'string' ? item.thinking : '';
        const ms = typeof raw.thinkingDurationMs === 'number' && Number.isFinite(raw.thinkingDurationMs)
          ? Math.max(0, Math.round(raw.thinkingDurationMs))
          : null;
        const e: ThreadThinkingEntry = { id: nextId(), ts, k: 'th', ms, d: text.trim() !== '' };
        if (e.d) {
          const r = redactToolOutput(pre(text), { sensitivePath: false });
          out.push({ op: 'add', e, detail: { input: null, inMore: 0, x: r.text, more: r.more } });
        } else {
          out.push({ op: 'add', e });
        }
      } else if (item.type === 'tool_use') {
        const rawName = typeof item.name === 'string' && item.name !== '' ? item.name : 'tool';
        const name = oneLine(rawName, NAME_CAP) || 'tool';
        const input = item.input;
        const path = pathOf(rawName, input);
        const sensitive = path !== null && isSensitivePath(path);
        const inp = inputDetail(rawName, input, path, sensitive);
        const e: ThreadToolEntry = {
          id: nextId(), ts, k: 't', n: name, l: labelFor(rawName, input, path),
          st: 'run', sz: null, d: inp !== null,
        };
        const diff = sensitive ? null : diffFor(rawName, input);
        if (diff) {
          e.df = diff.df;
          e.dn = diff.dn;
        }
        if (typeof item.id === 'string' && item.id !== '') {
          if (ctx.open.size >= MAX_OPEN_TOOLS) {
            const oldest = ctx.open.keys().next().value;
            if (oldest !== undefined) ctx.open.delete(oldest);
          }
          ctx.open.set(item.id, { id: e.id, entry: e, path, sensitive, input: inp });
        }
        out.push({ op: 'add', e, ...(inp ? { detail: { input: inp.text, inMore: inp.more, x: null, more: 0 } } : {}) });
      }
    }
    const u = raw.message?.usage;
    if (u && typeof u === 'object') {
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      out.push({
        op: 'usage',
        ctxTok: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
        outTok: num(u.output_tokens),
        ts,
        endTurn: raw.message?.stop_reason === 'end_turn',
      });
    }
    return out;
  }

  // user line: tool results, or a human prompt. toolUseResult is deliberately never touched.
  let sawResult = false;
  for (const item of content) {
    if (!item || typeof item !== 'object' || item.type !== 'tool_result') continue;
    sawResult = true;
    const open = typeof item.tool_use_id === 'string' ? ctx.open.get(item.tool_use_id) : undefined;
    if (!open) continue;
    ctx.open.delete(item.tool_use_id);
    const text = resultText(item.content);
    const r = text === '' ? null : redactToolOutput(pre(text), { sensitivePath: open.sensitive });
    const e: ThreadToolEntry = { ...open.entry, st: item.is_error === true ? 'err' : 'ok', sz: text.length, d: open.input !== null || r !== null };
    out.push({
      op: 'upd',
      e,
      detail: { input: open.input?.text ?? null, inMore: open.input?.more ?? 0, x: r ? r.text : null, more: r ? r.more : 0 },
    });
  }
  if (sawResult) return out;

  if (
    (ev.originKind === null || ev.originKind === 'human') &&
    ev.isHumanPrompt &&
    !raw.isMeta && !raw.isCompactSummary && !raw.isVisibleInTranscriptOnly &&
    typeof ev.humanText === 'string' &&
    !NON_PROMPT_RE.test(ev.humanText) &&
    ev.humanText.trim() !== ''
  ) {
    const b = body(ev.humanText);
    out.push({ op: 'add', e: { id: nextId(), ts, k: 'u', x: b.x, tr: b.tr } });
    out.push({ op: 'prompt', ts });
  }
  return out;
}
