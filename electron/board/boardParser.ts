// Pure per-line parser for the Traffic board. Turns ONE transcript line into
// zero or more raw agent-to-agent events (dispatch, SendMessage, peer
// message / hand-back, task-notification). No fs, no electron: a later API can
// call it. Reuses parseTranscriptLine plus ONE narrow second JSON.parse per
// peer line to read `origin` (same precedent as transcriptReader's
// toDisplayMessage); TranscriptEvent is deliberately not widened.
import { parseTranscriptLine } from '../transcriptParser';
import { parseDispatchOutcome } from '../severity/parseDispatchOutcome';
import type { HandbackStatus } from '../../src/shared/board/types';

interface Base {
  lineIndex: number;
  atMs: number | null; // null = line had no valid timestamp
}
export type RawBoardEvent =
  | (Base & { type: 'dispatch'; toolUseId: string; subagentType: string | null; description: string | null; prompt: string })
  | (Base & { type: 'send'; toolUseId: string; to: string; recipientKind: string | null; summary: string | null; message: string })
  | (Base & { type: 'peer'; fromAgentId: string | null; fromName: string | null; isHandback: boolean; originKind: 'peer' | 'other'; text: string })
  | (Base & { type: 'notification'; taskId: string | null; toolUseId: string | null; status: HandbackStatus; summary: string | null; result: string });

const MARKERS = ['SendMessage', '"Agent"', '"Task"', 'agent-message', 'task-notification', '"peer"'];
const AGENT_MSG_OPEN = /<agent-message\s+from="/;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function tag(text: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1] : null;
}

// Keep only the indented report lines of a "[Subagent hand-back] ... The report
// follows:" frame; the harness footer sits at column 0 and is dropped.
function extractReport(inner: string): string {
  const lines = inner.split('\n');
  const start = lines.findIndex((l) => l.trimEnd().endsWith('The report follows:'));
  if (start < 0) return inner.trim();
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === '') out.push('');
    else if (l.startsWith('  ')) out.push(l.slice(2));
    else break;
  }
  return out.join('\n').trim();
}

export function parseBoardLine(line: string, lineIndex: number): RawBoardEvent[] {
  if (!line || !MARKERS.some((m) => line.includes(m))) return [];
  const ev = parseTranscriptLine(line);
  if (!ev) return [];
  const t = ev.timestamp ? ev.timestamp.getTime() : NaN;
  const atMs = Number.isNaN(t) ? null : t;
  const out: RawBoardEvent[] = [];

  if (ev.kind === 'assistant') {
    for (const tu of ev.toolUses) {
      const input = (tu.input && typeof tu.input === 'object' ? tu.input : {}) as Record<string, unknown>;
      if (tu.name === 'Agent' || tu.name === 'Task') {
        out.push({
          type: 'dispatch', lineIndex, atMs, toolUseId: str(tu.id) ?? '',
          subagentType: str(input.subagent_type), description: str(input.description), prompt: str(input.prompt) ?? '',
        });
      } else if (tu.name === 'SendMessage') {
        const message = typeof input.message === 'string' ? input.message : str(input.content);
        if (message === null) continue;
        out.push({
          type: 'send', lineIndex, atMs, toolUseId: str(tu.id) ?? '', to: str(input.to) ?? '',
          recipientKind: str(input.recipient_kind), summary: str(input.summary), message,
        });
      }
    }
    return out;
  }

  if (ev.kind !== 'user') return [];
  const text = ev.humanText ?? '';

  if (ev.originKind === 'task-notification') {
    const result = /<result>([\s\S]*)<\/result>/.exec(text);
    out.push({
      type: 'notification', lineIndex, atMs, taskId: tag(text, 'task-id'), toolUseId: tag(text, 'tool-use-id'),
      status: parseDispatchOutcome(text).status, summary: tag(text, 'summary'), result: result ? result[1] : '',
    });
    return out;
  }

  if (ev.originKind === 'peer' || AGENT_MSG_OPEN.test(text)) {
    let origin: Record<string, unknown> = {};
    try {
      const o = JSON.parse(line)?.origin;
      if (o && typeof o === 'object') origin = o;
    } catch { /* prefiltered and already parsed once; keep going with no origin */ }
    const attr = /<agent-message\s+from="([^"]*)"/.exec(text);
    const isHandback = !!origin.handback || text.includes('[Subagent hand-back]');
    const report = str(origin.handbackReportText);
    let body: string;
    if (report && report.trim()) {
      body = report;
    } else {
      const m = /<agent-message[^>]*>([\s\S]*?)<\/agent-message>/.exec(text);
      let inner = (m ? m[1] : str(origin.body) ?? text).trim();
      if (inner.startsWith('[Subagent hand-back]')) inner = extractReport(inner);
      body = inner;
    }
    out.push({
      type: 'peer', lineIndex, atMs, fromAgentId: str(origin.from) ?? (attr ? attr[1] : null),
      fromName: str(origin.name), isHandback, originKind: ev.originKind === 'peer' ? 'peer' : 'other', text: body,
    });
  }
  return out;
}
