export interface RealAgentDispatch {
  toolUseId: string;
  subagentType: string;
  description: string;
  startedAt: string;
  prompt: string;
  model: string | null;
}

export interface CompletedDispatchUsage extends RealAgentDispatch {
  tokens: number;
  toolUses: number;
  durationMs: number;
}

export function applyLinesToOpenDispatches(
  currentOpen: RealAgentDispatch[],
  rawLines: string[],
  completedOut?: CompletedDispatchUsage[],
): RealAgentDispatch[] {
  const open = new Map(currentOpen.map((d) => [d.toolUseId, d]));

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let json: any;
    try {
      json = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (json.type === 'assistant' && json.message) {
      const content = Array.isArray(json.message.content) ? json.message.content : [];
      for (const item of content) {
        if (item && item.type === 'tool_use' && item.name === 'Agent') {
          open.set(item.id, {
            toolUseId: item.id,
            subagentType: (item.input && item.input.subagent_type) || 'agent',
            description: (item.input && item.input.description) || '',
            startedAt: json.timestamp || new Date(0).toISOString(),
            prompt: (item.input && item.input.prompt) || '',
            model: (item.input && item.input.model) || null,
          });
        }
      }
      continue;
    }

    if (json.type === 'user' && json.origin && json.origin.kind === 'task-notification') {
      const content = typeof json.message?.content === 'string' ? json.message.content : '';
      const match = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
      if (match) {
        const dispatch = open.get(match[1]);
        if (dispatch && completedOut) {
          const tokensMatch = content.match(/<subagent_tokens>(\d+)<\/subagent_tokens>/);
          const toolUsesMatch = content.match(/<tool_uses>(\d+)<\/tool_uses>/);
          const durationMatch = content.match(/<duration_ms>(\d+)<\/duration_ms>/);
          completedOut.push({
            ...dispatch,
            tokens: tokensMatch ? Number(tokensMatch[1]) : 0,
            toolUses: toolUsesMatch ? Number(toolUsesMatch[1]) : 0,
            durationMs: durationMatch ? Number(durationMatch[1]) : 0,
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
export function applyLinesToOpenWork(currentOpen: RealActiveWork[], rawLines: string[]): RealActiveWork[] {
  const open = new Map(currentOpen.map((w) => [w.toolUseId, w]));

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let json: any;
    try {
      json = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (json.type === 'assistant' && json.message) {
      const content = Array.isArray(json.message.content) ? json.message.content : [];
      for (const item of content) {
        if (item && item.type === 'tool_use') {
          const kind: 'agent' | 'tool' = item.name === 'Agent' ? 'agent' : 'tool';
          open.set(item.id, {
            toolUseId: item.id,
            kind,
            label: labelForToolUse(item.name, item.input),
            description: kind === 'agent' ? (item.input && item.input.description) || '' : '',
            startedAt: json.timestamp || new Date(0).toISOString(),
          });
        }
      }
      continue;
    }

    if (json.type === 'user' && json.origin && json.origin.kind === 'task-notification') {
      const content = typeof json.message?.content === 'string' ? json.message.content : '';
      const match = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
      if (match) open.delete(match[1]);
      continue;
    }

    if (json.type === 'user' && json.message) {
      const content = Array.isArray(json.message.content) ? json.message.content : [];
      for (const item of content) {
        if (item && item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
          const existing = open.get(item.tool_use_id);
          if (existing && existing.kind === 'tool') open.delete(item.tool_use_id);
        }
      }
    }
  }

  return Array.from(open.values());
}
