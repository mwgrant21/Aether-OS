import type { TranscriptEvent } from '../../electron/transcriptParser';
import { parseDispatchOutcome, unrecognisedStatusTag, type DispatchOutcome } from '../../electron/severity/parseDispatchOutcome';

export interface RealAgentDispatch {
  toolUseId: string;
  subagentType: string;
  description: string;
  startedAt: string;
  prompt: string;
  model: string | null;
}

// The three usage numbers are all present or all absent. Absent means the
// notification carried no (trustworthy) usage block: spec
// 2026-09-30-real-severity-design.md section 2, "usage: undefined, never
// zeros". Consumers render a dash or skip; they never read absent as 0.
export interface CompletedDispatchUsage extends RealAgentDispatch {
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export type CompletedDispatchWithUsage = CompletedDispatchUsage & { tokens: number; toolUses: number; durationMs: number };

export interface TrackedOutcome {
  outcome: DispatchOutcome;
  /** Set only when outcome.status is 'unknown': a sanitised tag for the one-per-value [diag] line. */
  unknownStatusTag: string | null;
}

function isoOrEpoch(timestamp: Date | null): string {
  return timestamp && !Number.isNaN(timestamp.getTime())
    ? timestamp.toISOString()
    : new Date(0).toISOString();
}

export function applyLinesToOpenDispatches(
  currentOpen: RealAgentDispatch[],
  events: TranscriptEvent[],
  completedOut?: CompletedDispatchUsage[],
  outcomesOut?: Map<string, TrackedOutcome>,
): RealAgentDispatch[] {
  const open = new Map(currentOpen.map((d) => [d.toolUseId, d]));

  for (const event of events) {
    if (event.kind === 'assistant') {
      for (const toolUse of event.toolUses) {
        if (toolUse.name === 'Agent') {
          const input = (toolUse.input as any) || {};
          open.set(toolUse.id, {
            toolUseId: toolUse.id,
            subagentType: input.subagent_type || 'agent',
            description: input.description || '',
            startedAt: isoOrEpoch(event.timestamp),
            prompt: input.prompt || '',
            model: input.model || null,
          });
        }
      }
      continue;
    }

    if (event.kind === 'user' && event.originKind === 'task-notification') {
      const content = event.humanText || '';
      const match = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
      if (match) {
        const dispatch = open.get(match[1]);
        if (dispatch) {
          const outcome = parseDispatchOutcome(content);
          // usage is all-or-nothing from the parser; absent stays absent.
          completedOut?.push(outcome.usage ? { ...dispatch, ...outcome.usage } : { ...dispatch });
          outcomesOut?.set(dispatch.toolUseId, {
            outcome,
            unknownStatusTag: outcome.status === 'unknown' ? unrecognisedStatusTag(content) : null,
          });
        }
        open.delete(match[1]);
      }
    }
  }

  return Array.from(open.values());
}

export function detectCompletedDispatches(oldAgents: RealAgentDispatch[], newAgents: RealAgentDispatch[]): RealAgentDispatch[] {
  const stillOpen = new Set(newAgents.map((a) => a.toolUseId));
  return oldAgents.filter((a) => !stillOpen.has(a.toolUseId));
}

export function detectStartedDispatches(oldAgents: RealAgentDispatch[], newAgents: RealAgentDispatch[]): RealAgentDispatch[] {
  const wasOpen = new Set(oldAgents.map((a) => a.toolUseId));
  return newAgents.filter((a) => !wasOpen.has(a.toolUseId));
}

export interface RealActiveWork {
  toolUseId: string;
  kind: 'agent' | 'tool';
  label: string;
  description: string;
  startedAt: string;
}

// Lane label for the Grid's "what is running right now" view: the most
// identifying scrap of the tool's input, so "Bash" reads as "npm test"
// rather than just "Bash". Ported from TokenMonitor's labelForToolUse.
export function labelForToolUse(name: string, input: any): string {
  const i = input || {};
  if (name === 'Agent') return i.subagent_type || i.description || 'agent';
  if (i.command) return i.command;
  if (i.file_path) return String(i.file_path).split(/[\\/]/).pop() as string;
  if (i.pattern) return i.pattern;
  return name;
}

// Broader sibling of applyLinesToOpenDispatches: opens a lane for EVERY
// tool_use (not just Agent), so the Grid can show any in-flight work, not
// only real subagent dispatches. Kept separate rather than folded into
// applyLinesToOpenDispatches so that function's existing, shipped contract
// (Memory/Chat/Analytics/dispatchUsage all key off it) is never at risk.
//
// Closing differs by kind: agent lanes close only on the same
// task-notification signal applyLinesToOpenDispatches uses (a normal
// tool_result for an Agent call isn't a reliable completion signal here).
// Tool lanes close on a normal tool_result, which agent dispatches don't
// reliably produce promptly, so it's ignored for kind 'agent'.
export function applyLinesToOpenWork(currentOpen: RealActiveWork[], events: TranscriptEvent[]): RealActiveWork[] {
  const open = new Map(currentOpen.map((w) => [w.toolUseId, w]));

  for (const event of events) {
    if (event.kind === 'assistant') {
      for (const toolUse of event.toolUses) {
        const kind: 'agent' | 'tool' = toolUse.name === 'Agent' ? 'agent' : 'tool';
        const input = (toolUse.input as any) || {};
        open.set(toolUse.id, {
          toolUseId: toolUse.id,
          kind,
          label: labelForToolUse(toolUse.name, toolUse.input),
          description: kind === 'agent' ? input.description || '' : '',
          startedAt: isoOrEpoch(event.timestamp),
        });
      }
      continue;
    }

    if (event.kind === 'user' && event.originKind === 'task-notification') {
      const content = event.humanText || '';
      const match = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
      if (match) open.delete(match[1]);
      continue;
    }

    if (event.kind === 'user') {
      for (const toolResult of event.toolResults) {
        const existing = open.get(toolResult.toolUseId);
        if (existing && existing.kind === 'tool') open.delete(toolResult.toolUseId);
      }
    }
  }

  return Array.from(open.values());
}
