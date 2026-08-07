// DisplayMessage is defined in electron/transcriptReader.ts (Task 1) and has this exact shape.
// We reproduce it here for type checking since the filter logic is pure and lives in src/,
// which is compiled separately from electron/. Consumers will pass the same type.
export interface DisplayMessage {
  id: string;
  role: 'human' | 'assistant' | 'system';
  atMs: number;
  text: string | null;
  toolCalls: { name: string; label: string }[];
  toolResults: { resultLength: number }[];
}

export type Filter =
  | { type: 'empty' }
  | { type: 'text'; query: string }
  | { type: 'tool'; name: string }
  | { type: 'human' }
  | { type: 'error' };

/**
 * Parses a raw filter expression string into a Filter object.
 *
 * Syntax:
 * - Empty or whitespace-only: returns empty filter
 * - Bare text: case-insensitive substring search across message text and tool labels
 * - `/tool <name>`: filters to messages containing a tool call with the given name
 * - `/human`: filters to messages from the 'human' role
 * - `/error`: filters to messages with tool results that have failure-shaped labels
 *   (contains "error" or "fail"), combined with tool-result presence.
 *   **Limitation:** Result content is not available (only resultLength), so this
 *   cannot detect a command that failed silently with a successful response.
 * - Unrecognized `/verb`: falls through to bare text search (same philosophy as
 *   localResponder's catch-all) — a filter box that rejects input is worse than
 *   one that over-matches.
 */
export function parseFilter(raw: string): Filter {
  const trimmed = raw.trim();

  if (!trimmed) {
    return { type: 'empty' };
  }

  // Check for /verb patterns
  if (trimmed.startsWith('/')) {
    const parts = trimmed.split(/\s+/);
    const verb = parts[0].toLowerCase().slice(1); // Remove the leading /

    if (verb === 'tool' && parts.length > 1) {
      // /tool <name>
      const name = parts.slice(1).join(' ');
      return { type: 'tool', name };
    }

    if (verb === 'human' && parts.length === 1) {
      return { type: 'human' };
    }

    if (verb === 'error' && parts.length === 1) {
      return { type: 'error' };
    }

    // Unrecognized /verb or incomplete /tool: fall through to bare text
  }

  // Bare text search
  return { type: 'text', query: trimmed };
}

/**
 * Applies a filter to an array of messages, returning only matching messages.
 *
 * An empty filter returns the input array unchanged by identity (so the thread
 * does not re-render on every keystroke that clears the box).
 */
export function applyFilter(messages: DisplayMessage[], filter: Filter): DisplayMessage[] {
  if (filter.type === 'empty') {
    return messages;
  }

  if (filter.type === 'text') {
    const query = filter.query.toLowerCase();
    return messages.filter((msg) => {
      // Search in message text
      if (msg.text && msg.text.toLowerCase().includes(query)) {
        return true;
      }
      // Search in tool call labels
      if (msg.toolCalls.some((tc: { name: string; label: string }) => tc.label.toLowerCase().includes(query))) {
        return true;
      }
      return false;
    });
  }

  if (filter.type === 'tool') {
    const name = filter.name.toLowerCase();
    return messages.filter((msg) => msg.toolCalls.some((tc: { name: string; label: string }) => tc.name.toLowerCase() === name));
  }

  if (filter.type === 'human') {
    return messages.filter((msg) => msg.role === 'human');
  }

  if (filter.type === 'error') {
    return messages.filter((msg) => {
      // Match messages that have tool results AND a failure-shaped tool label.
      // "Failure-shaped" means the label contains "error" or "fail" (case-insensitive).
      if (msg.toolResults.length === 0) {
        return false;
      }
      return msg.toolCalls.some((tc: { name: string; label: string }) => {
        const label = tc.label.toLowerCase();
        return label.includes('error') || label.includes('fail');
      });
    });
  }

  // TypeScript exhaustiveness check
  const _exhaustive: never = filter;
  return _exhaustive;
}
