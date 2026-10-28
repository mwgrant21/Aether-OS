// Pure: one transcript line -> ThreadEvents for the phone thread view, plus the turn mark the feed
// uses to derive "working". No fs, no electron, no timers, no module state. Text is NOT masked
// (single-user decision, spec D3) but IS size-capped. Tool results and thinking blocks are never
// read into an event.
import { parseTranscriptLine } from './transcriptParser';
import { NON_PROMPT_RE } from './board/boardFeed';
import { THREAD_TARGET_CAP, THREAD_TEXT_CAP, type ThreadEvent } from '../src/shared/remote/types';

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const INTERRUPT_RE = /^\s*\[Request interrupted by user/;

function cap(t: string, max: number): { text: string; truncated: boolean } {
  return t.length > max ? { text: t.slice(0, max), truncated: true } : { text: t, truncated: false };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function lineCount(s: unknown): number {
  return typeof s === 'string' && s !== '' ? s.split('\n').length : 0;
}

function capTarget(t: string | null): string | null {
  if (t === null) return null;
  const one = t.trim();
  return one === '' ? null : one.length > THREAD_TARGET_CAP ? one.slice(0, THREAD_TARGET_CAP) : one;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function toolTarget(name: string, input: any): string | null {
  const i = input && typeof input === 'object' ? input : {};
  if (FILE_TOOLS.has(name)) {
    const p = str(i.file_path) ?? str(i.notebook_path);
    return capTarget(p === null ? null : baseName(p));
  }
  if (name === 'Bash') {
    const c = str(i.command);
    return capTarget(c === null ? null : c.split('\n')[0]);
  }
  if (name === 'Grep' || name === 'Glob') return capTarget(str(i.pattern));
  if (name === 'WebFetch') return capTarget(str(i.url));
  if (name === 'Agent' || name === 'Task') return capTarget(str(i.description));
  return null;
}

function toolCounts(name: string, input: any): { add: number | null; del: number | null } {
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'Edit') return { add: lineCount(i.new_string), del: lineCount(i.old_string) };
  if (name === 'MultiEdit') {
    const edits: any[] = Array.isArray(i.edits) ? i.edits : [];
    let add = 0;
    let del = 0;
    for (const e of edits) {
      add += lineCount(e?.new_string);
      del += lineCount(e?.old_string);
    }
    return { add, del };
  }
  if (name === 'Write') return { add: lineCount(i.content), del: null };
  return { add: null, del: null };
}

function parseRaw(line: string): any | null {
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
}

function atOf(ts: Date | null): number {
  return ts && !Number.isNaN(ts.getTime()) ? ts.getTime() : 0;
}

function isHumanPromptLine(ev: NonNullable<ReturnType<typeof parseTranscriptLine>>, raw: any): boolean {
  return (
    (ev.originKind === null || ev.originKind === 'human') &&
    ev.isHumanPrompt &&
    !raw.isMeta && !raw.isSidechain && !raw.isCompactSummary && !raw.isVisibleInTranscriptOnly &&
    typeof ev.humanText === 'string' &&
    ev.humanText.trim() !== ''
  );
}

export function parseThreadLine(line: string, offsetKey: number): ThreadEvent[] {
  const ev = parseTranscriptLine(line);
  if (!ev || (ev.kind !== 'assistant' && ev.kind !== 'user')) return [];
  const raw = parseRaw(line);
  if (!raw || raw.isSidechain) return [];
  const at = atOf(ev.timestamp);
  const out: ThreadEvent[] = [];
  let n = 0;
  const nextId = (): string => `${offsetKey}:${n++}`;

  if (ev.kind === 'assistant') {
    const content: any[] = Array.isArray(raw.message?.content) ? raw.message.content : [];
    const text = content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n');
    if (text.trim() !== '') {
      const c = cap(text, THREAD_TEXT_CAP);
      out.push({ k: 'claude', id: nextId(), at, text: c.text, truncated: c.truncated });
    }
    for (const t of ev.toolUses) {
      if (typeof t.name !== 'string' || t.name === '') continue;
      const { add, del } = toolCounts(t.name, t.input);
      out.push({ k: 'tool', id: nextId(), at, name: t.name, target: toolTarget(t.name, t.input), add, del });
    }
  } else if (
    isHumanPromptLine(ev, raw) &&
    !NON_PROMPT_RE.test(ev.humanText as string) &&
    !INTERRUPT_RE.test(ev.humanText as string)
  ) {
    const c = cap(ev.humanText as string, THREAD_TEXT_CAP);
    out.push({ k: 'user', id: nextId(), at, text: c.text, truncated: c.truncated });
  }
  return out;
}

export interface TurnMark {
  /** busy: a turn is in progress after this line. idle: the turn ended. */
  mark: 'busy' | 'idle';
  at: number;
}

/**
 * What this line says about the turn, or null when it says nothing (tool_result lines, sidechains,
 * bookkeeping lines, thinking-only lines mid-turn). Real transcripts write one content block per
 * line and stamp `message.stop_reason`: `tool_use` marks mid-turn text as still busy, `end_turn`
 * (or any other terminal reason) ends the turn. Lines without a stop_reason fall back to the
 * event kind: user/tool busy, assistant text idle.
 */
export function turnMark(line: string): TurnMark | null {
  const ev = parseTranscriptLine(line);
  if (!ev || (ev.kind !== 'assistant' && ev.kind !== 'user')) return null;
  const raw = parseRaw(line);
  if (!raw || raw.isSidechain) return null;
  const at = atOf(ev.timestamp);
  if (ev.kind === 'user') {
    if (!isHumanPromptLine(ev, raw) || NON_PROMPT_RE.test(ev.humanText as string)) return null;
    return { mark: INTERRUPT_RE.test(ev.humanText as string) ? 'idle' : 'busy', at };
  }
  const content: any[] = Array.isArray(raw.message?.content) ? raw.message.content : [];
  const stop = raw.message?.stop_reason;
  if (ev.toolUses.length > 0 || stop === 'tool_use') return { mark: 'busy', at };
  if (typeof stop === 'string' && stop !== '') return { mark: 'idle', at };
  const hasText = content.some((c) => c && c.type === 'text' && typeof c.text === 'string' && c.text.trim() !== '');
  return hasText ? { mark: 'idle', at } : null;
}
