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
