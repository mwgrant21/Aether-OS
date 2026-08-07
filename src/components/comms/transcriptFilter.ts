import type { DisplayMessage } from '../../../electron/transcriptReader';

export type { DisplayMessage };

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
 * - `/error`: filters to messages with a tool call that (a) has a correlated
 *   result (`resultLength !== null` -- see readTranscript's correlation pass
 *   in electron/transcriptReader.ts, which pairs a tool_use with its later
 *   tool_result by tool_use_id) and (b) has a failure-shaped label (contains
 *   "error" or "fail").
 *   **Limitation:** Result content is not available (only resultLength), so this
 *   cannot detect a command that failed silently with a successful response.
 *   A tool call whose result fell outside the read window (paged out) won't
 *   have a correlated resultLength and so won't match, even if its label
 *   looks failure-shaped.
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
      if (msg.toolCalls.some((tc) => tc.label.toLowerCase().includes(query))) {
        return true;
      }
      return false;
    });
  }

  if (filter.type === 'tool') {
    const name = filter.name.toLowerCase();
    return messages.filter((msg) => msg.toolCalls.some((tc) => tc.name.toLowerCase() === name));
  }

  if (filter.type === 'human') {
    return messages.filter((msg) => msg.role === 'human');
  }

  if (filter.type === 'error') {
    return messages.filter((msg) =>
      msg.toolCalls.some((tc) => {
        if (tc.resultLength === null) return false;
        const label = tc.label.toLowerCase();
        return label.includes('error') || label.includes('fail');
      })
    );
  }

  // TypeScript exhaustiveness check
  const _exhaustive: never = filter;
  return _exhaustive;
}
