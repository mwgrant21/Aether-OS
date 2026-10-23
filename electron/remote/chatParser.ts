// Pure: one transcript line -> masked, path-free ChatEvents for the phone chat view.
// No fs, no electron, no timers, no module state. Every ChatEvent in the remote feature is
// constructed here, after maskSecrets, so nothing downstream ever holds unmasked text.
// Tool inputs, tool results and thinking blocks are never read into an event.
import { parseTranscriptLine } from '../transcriptParser';
import { parseBoardLine, type RawBoardEvent } from '../board/boardParser';
import { maskSecrets, capBody } from '../../src/shared/board/text';
import { shortenPaths, NON_PROMPT_RE, STUB_RE, HEX_ID_RE } from '../board/boardFeed';
import { REMOTE_BODY_CAP, REMOTE_LABEL_CAP } from '../../src/shared/remote/types';
import type { ChatEvent } from './types';

export interface ChatParseContext {
  /** tool_use ids of Agent/Task dispatches seen so far; the caller owns it. */
  dispatchIds: Set<string>;
}

const TRAFFIC_TOOLS = new Set(['Agent', 'Task', 'SendMessage']);

// Mask THEN cap, so a secret straddling the cap cannot leave a prefix behind.
function body(t: string): { text: string; truncated: boolean } {
  const r = capBody(maskSecrets(t), REMOTE_BODY_CAP);
  return { text: r.body, truncated: r.truncated };
}

// Labels (from/to/subject/title) are path-free as well as masked.
function label(t: string): string {
  return capBody(shortenPaths(maskSecrets(t)).replace(/\s+/g, ' ').trim(), REMOTE_LABEL_CAP).body;
}

function labelOrNull(t: string | null): string | null {
  if (t === null) return null;
  const l = label(t);
  return l === '' ? null : l;
}

type Traffic = Extract<ChatEvent, { k: 'traffic' }>;

function toTraffic(raw: RawBoardEvent, ctx: ChatParseContext): Omit<Traffic, 'id'> | null {
  const atMs = raw.atMs ?? 0;
  switch (raw.type) {
    case 'dispatch': {
      if (raw.toolUseId) ctx.dispatchIds.add(raw.toolUseId);
      const b = body(raw.prompt);
      return {
        k: 'traffic', atMs, kind: 'dispatch', from: 'Claude', to: label(raw.subagentType ?? 'agent'),
        subject: labelOrNull(raw.description), text: b.text, truncated: b.truncated, status: null,
      };
    }
    case 'send': {
      const b = body(raw.message);
      const to = raw.to === '*' ? 'everyone' : HEX_ID_RE.test(raw.to) ? 'agent' : label(raw.to);
      return {
        k: 'traffic', atMs, kind: 'message', from: 'Claude', to,
        subject: labelOrNull(raw.summary), text: b.text, truncated: b.truncated, status: null,
      };
    }
    case 'peer': {
      const b = body(raw.text);
      return {
        k: 'traffic', atMs, kind: raw.isHandback ? 'handback' : 'message', from: label(raw.fromName ?? 'peer'),
        to: 'Claude', subject: null, text: b.text, truncated: b.truncated, status: null,
      };
    }
    case 'notification': {
      if (!raw.toolUseId || !ctx.dispatchIds.has(raw.toolUseId)) return null;
      if (STUB_RE.test(raw.result)) return null;
      const b = body(raw.result || raw.summary || '');
      return {
        k: 'traffic', atMs, kind: 'handback', from: 'agent', to: 'Claude',
        subject: labelOrNull(raw.summary), text: b.text, truncated: b.truncated, status: raw.status,
      };
    }
  }
}

export function parseChatLine(line: string, offsetKey: number, ctx: ChatParseContext): ChatEvent[] {
  const ev = parseTranscriptLine(line);
  if (!ev || (ev.kind !== 'assistant' && ev.kind !== 'user')) return [];

  // parseTranscriptLine already proved the line is valid JSON; this second narrow parse is the
  // transcriptReader.toDisplayMessage precedent (it reads assistant text and the flags).
  let raw: any = {};
  try {
    raw = JSON.parse(line.trim());
  } catch {
    return [];
  }
  const atMs = ev.timestamp && !Number.isNaN(ev.timestamp.getTime()) ? ev.timestamp.getTime() : 0;
  const out: ChatEvent[] = [];
  let n = 0;
  const nextId = (): string => `${offsetKey}:${n++}`;

  if (ev.kind === 'assistant') {
    if (raw.isSidechain) return [];
    const content: any[] = Array.isArray(raw.message?.content) ? raw.message.content : [];
    const text = content
      .filter((i) => i && i.type === 'text' && typeof i.text === 'string')
      .map((i) => i.text as string)
      .join('\n');
    const tools = [...new Set(ev.toolUses.map((t) => t.name).filter((nm): nm is string => typeof nm === 'string' && !TRAFFIC_TOOLS.has(nm)))];
    if (text.trim() !== '' || tools.length > 0) {
      const b = body(text);
      out.push({ k: 'msg', id: nextId(), atMs, role: 'claude', text: b.text, truncated: b.truncated, tools });
    }
  } else if (
    (ev.originKind === null || ev.originKind === 'human') &&
    ev.isHumanPrompt &&
    !raw.isMeta && !raw.isSidechain && !raw.isCompactSummary && !raw.isVisibleInTranscriptOnly &&
    typeof ev.humanText === 'string' &&
    !NON_PROMPT_RE.test(ev.humanText) &&
    ev.humanText.trim() !== ''
  ) {
    const b = body(ev.humanText);
    out.push({ k: 'msg', id: nextId(), atMs, role: 'you', text: b.text, truncated: b.truncated, tools: [] });
  }

  for (const rawEv of parseBoardLine(line, 0)) {
    const t = toTraffic(rawEv, ctx);
    if (t) out.push({ ...t, id: nextId() });
  }
  return out;
}
