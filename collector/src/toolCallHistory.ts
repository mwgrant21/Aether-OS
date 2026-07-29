import { TranscriptEvent } from './transcriptParser.js';

export interface ClosedToolCall {
  toolUseId: string;
  toolName: string;
  filePath: string | null;
  startedAt: number;
  closedAt: number;
}

export interface ToolCallHistory {
  events: ClosedToolCall[];
  openByToolUseId: Record<string, { toolName: string; filePath: string | null; startedAt: number }>;
}

export const HISTORY_MAX_EVENTS = 500;

export function createEmptyHistory(): ToolCallHistory {
  return { events: [], openByToolUseId: {} };
}

export function updateHistory(
  history: ToolCallHistory,
  events: TranscriptEvent[],
  nowMs: number,
): ToolCallHistory {
  const newOpen = { ...history.openByToolUseId };
  let newEvents = [...history.events];

  for (const event of events) {
    for (const toolUse of event.toolUses) {
      const filePath = extractFilePath(toolUse.input);
      const startedAt = event.timestamp?.getTime() ?? nowMs;
      newOpen[toolUse.id] = { toolName: toolUse.name, filePath, startedAt };
    }

    for (const toolResult of event.toolResults) {
      const open = newOpen[toolResult.toolUseId];
      if (open) {
        const closedAt = event.timestamp?.getTime() ?? nowMs;
        newEvents.push({
          toolUseId: toolResult.toolUseId,
          toolName: open.toolName,
          filePath: open.filePath,
          startedAt: open.startedAt,
          closedAt,
        });
        delete newOpen[toolResult.toolUseId];
      }
    }
  }

  if (newEvents.length > HISTORY_MAX_EVENTS) {
    newEvents = newEvents.slice(newEvents.length - HISTORY_MAX_EVENTS);
  }

  return { events: newEvents, openByToolUseId: newOpen };
}

function extractFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const filePath = obj.file_path;
  if (typeof filePath === 'string') return filePath;
  return null;
}
