export interface RealAgentDispatch {
  toolUseId: string;
  subagentType: string;
  description: string;
  startedAt: string;
}

export function applyLinesToOpenDispatches(currentOpen: RealAgentDispatch[], rawLines: string[]): RealAgentDispatch[] {
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
          });
        }
      }
      continue;
    }

    if (json.type === 'user' && json.origin && json.origin.kind === 'task-notification') {
      const content = typeof json.message?.content === 'string' ? json.message.content : '';
      const match = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
      if (match) open.delete(match[1]);
    }
  }

  return Array.from(open.values());
}
