import { describe, expect, it } from 'vitest';
import { parseFilter, applyFilter, type DisplayMessage } from './transcriptFilter';

// Test fixtures
const messages: DisplayMessage[] = [
  {
    id: '1',
    role: 'human',
    atMs: 1000,
    text: 'What is the API rate limit?',
    toolCalls: [],
    toolResults: [],
  },
  {
    id: '2',
    role: 'assistant',
    atMs: 2000,
    text: 'The API rate limit is 100 requests per minute.',
    toolCalls: [{ name: 'fetch_docs', label: 'Fetch API documentation' }],
    toolResults: [],
  },
  {
    id: '3',
    role: 'assistant',
    atMs: 3000,
    text: null,
    toolCalls: [{ name: 'run_test', label: 'Run unit tests' }],
    toolResults: [{ resultLength: 250 }],
  },
  {
    id: '4',
    role: 'assistant',
    atMs: 4000,
    text: null,
    toolCalls: [{ name: 'run_test', label: 'Run failed test suite' }],
    toolResults: [{ resultLength: 512 }],
  },
  {
    id: '5',
    role: 'human',
    atMs: 5000,
    text: 'Can you check the error logs?',
    toolCalls: [],
    toolResults: [],
  },
  {
    id: '6',
    role: 'assistant',
    atMs: 6000,
    text: 'Checking logs...',
    toolCalls: [{ name: 'read_logs', label: 'Error log reader' }],
    toolResults: [{ resultLength: 1024 }],
  },
  {
    id: '7',
    role: 'system',
    atMs: 7000,
    text: 'System restart complete',
    toolCalls: [],
    toolResults: [],
  },
  {
    id: '8',
    role: 'assistant',
    atMs: 8000,
    text: 'Deployment failed.',
    toolCalls: [{ name: 'deploy', label: 'Deploy failure handler' }],
    toolResults: [{ resultLength: 100 }],
  },
];

describe('parseFilter', () => {
  describe('empty filter', () => {
    it('treats empty string as empty filter', () => {
      const filter = parseFilter('');
      expect(filter).toEqual({ type: 'empty' });
    });

    it('treats whitespace-only string as empty filter', () => {
      const filter = parseFilter('   \t\n  ');
      expect(filter).toEqual({ type: 'empty' });
    });
  });

  describe('bare text filter', () => {
    it('parses simple text queries', () => {
      const filter = parseFilter('api');
      expect(filter).toEqual({ type: 'text', query: 'api' });
    });

    it('preserves case in the query (will be lowercased during matching)', () => {
      const filter = parseFilter('API');
      expect(filter).toEqual({ type: 'text', query: 'API' });
    });

    it('preserves multi-word text queries', () => {
      const filter = parseFilter('rate limit');
      expect(filter).toEqual({ type: 'text', query: 'rate limit' });
    });

    it('treats unrecognized /verbs as bare text', () => {
      const filter = parseFilter('/unknown query');
      expect(filter).toEqual({ type: 'text', query: '/unknown query' });
    });
  });

  describe('/tool filter', () => {
    it('parses /tool with a single word name', () => {
      const filter = parseFilter('/tool fetch_docs');
      expect(filter).toEqual({ type: 'tool', name: 'fetch_docs' });
    });

    it('parses /tool with multi-word names', () => {
      const filter = parseFilter('/tool run test');
      expect(filter).toEqual({ type: 'tool', name: 'run test' });
    });

    it('treats /tool with no name as bare text (incomplete)', () => {
      const filter = parseFilter('/tool');
      expect(filter).toEqual({ type: 'text', query: '/tool' });
    });

    it('treats /tool with only whitespace after it as bare text', () => {
      const filter = parseFilter('/tool   ');
      expect(filter).toEqual({ type: 'text', query: '/tool' });
    });
  });

  describe('/human filter', () => {
    it('parses /human', () => {
      const filter = parseFilter('/human');
      expect(filter).toEqual({ type: 'human' });
    });

    it('treats /human with extra args as bare text (incomplete)', () => {
      const filter = parseFilter('/human extra');
      expect(filter).toEqual({ type: 'text', query: '/human extra' });
    });
  });

  describe('/error filter', () => {
    it('parses /error', () => {
      const filter = parseFilter('/error');
      expect(filter).toEqual({ type: 'error' });
    });

    it('treats /error with extra args as bare text (incomplete)', () => {
      const filter = parseFilter('/error something');
      expect(filter).toEqual({ type: 'text', query: '/error something' });
    });
  });

  describe('case insensitivity for verbs', () => {
    it('parses /TOOL in uppercase', () => {
      const filter = parseFilter('/TOOL something');
      expect(filter).toEqual({ type: 'tool', name: 'something' });
    });

    it('parses /Human in mixed case', () => {
      const filter = parseFilter('/Human');
      expect(filter).toEqual({ type: 'human' });
    });

    it('parses /ERROR in uppercase', () => {
      const filter = parseFilter('/ERROR');
      expect(filter).toEqual({ type: 'error' });
    });
  });
});

describe('applyFilter', () => {
  describe('empty filter', () => {
    it('returns the input array unchanged by identity', () => {
      const filter = parseFilter('');
      const result = applyFilter(messages, filter);
      expect(result).toBe(messages);
    });
  });

  describe('bare text filter', () => {
    it('filters messages by text content (case-insensitive)', () => {
      const filter = parseFilter('api');
      const result = applyFilter(messages, filter);
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['1', '2']);
    });

    it('filters messages by tool labels (case-insensitive)', () => {
      const filter = parseFilter('fetch');
      const result = applyFilter(messages, filter);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('2');
    });

    it('matches both text and tool labels in the same search', () => {
      const filter = parseFilter('test');
      const result = applyFilter(messages, filter);
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['3', '4']);
    });

    it('handles multi-word queries as substrings', () => {
      const filter = parseFilter('rate limit');
      const result = applyFilter(messages, filter);
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['1', '2']);
    });

    it('returns empty array when no messages match', () => {
      const filter = parseFilter('nonexistent');
      const result = applyFilter(messages, filter);
      expect(result).toEqual([]);
    });

    it('is case-insensitive', () => {
      const filterLower = parseFilter('api');
      const filterUpper = parseFilter('API');
      const resultLower = applyFilter(messages, filterLower);
      const resultUpper = applyFilter(messages, filterUpper);
      expect(resultLower).toEqual(resultUpper);
    });

    it('matches partial words', () => {
      const filter = parseFilter('log');
      const result = applyFilter(messages, filter);
      expect(result.length).toBeGreaterThan(0);
      expect(result.some((m) => m.id === '5')).toBe(true);
    });
  });

  describe('/tool filter', () => {
    it('filters to messages with a specific tool call', () => {
      const filter = parseFilter('/tool fetch_docs');
      const result = applyFilter(messages, filter);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('2');
    });

    it('filters multiple messages with the same tool', () => {
      const filter = parseFilter('/tool run_test');
      const result = applyFilter(messages, filter);
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['3', '4']);
    });

    it('returns empty array when tool is not found', () => {
      const filter = parseFilter('/tool nonexistent');
      const result = applyFilter(messages, filter);
      expect(result).toEqual([]);
    });

    it('is case-insensitive for tool names', () => {
      const filterLower = parseFilter('/tool fetch_docs');
      const filterUpper = parseFilter('/tool FETCH_DOCS');
      const resultLower = applyFilter(messages, filterLower);
      const resultUpper = applyFilter(messages, filterUpper);
      expect(resultLower).toEqual(resultUpper);
    });
  });

  describe('/human filter', () => {
    it('filters to messages from the human role only', () => {
      const filter = parseFilter('/human');
      const result = applyFilter(messages, filter);
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['1', '5']);
      expect(result.every((m) => m.role === 'human')).toBe(true);
    });

    it('excludes assistant and system messages', () => {
      const filter = parseFilter('/human');
      const result = applyFilter(messages, filter);
      expect(result.some((m) => m.role === 'assistant')).toBe(false);
      expect(result.some((m) => m.role === 'system')).toBe(false);
    });
  });

  describe('/error filter', () => {
    it('filters to messages with tool results and failure-shaped labels', () => {
      const filter = parseFilter('/error');
      const result = applyFilter(messages, filter);
      // Messages 4, 6, and 8 have toolResults and failure-shaped labels
      // Message 4: "Run failed test suite" (contains "failed")
      // Message 6: "Error log reader" (contains "Error")
      // Message 8: "Deploy failure handler" (contains "failure")
      expect(result.map((m) => m.id)).toEqual(['4', '6', '8']);
    });

    it('requires both toolResults AND failure-shaped label', () => {
      const filter = parseFilter('/error');
      const result = applyFilter(messages, filter);
      // Message 3 has a toolResult but label "Run unit tests" does not indicate failure
      expect(result.some((m) => m.id === '3')).toBe(false);
    });

    it('matches "error" (lowercase)', () => {
      const filter = parseFilter('/error');
      const result = applyFilter(messages, filter);
      expect(result.some((m) => m.id === '6')).toBe(true);
    });

    it('matches "fail" or "failed" or "failure"', () => {
      const filter = parseFilter('/error');
      const result = applyFilter(messages, filter);
      expect(result.some((m) => m.id === '4')).toBe(true); // "failed"
      expect(result.some((m) => m.id === '8')).toBe(true); // "failure"
    });

    it('returns empty array when no errors are found', () => {
      // Create a message set with no failures
      const noErrors: DisplayMessage[] = [
        {
          id: '1',
          role: 'assistant',
          atMs: 1000,
          text: 'All good',
          toolCalls: [{ name: 'tool', label: 'Normal label' }],
          toolResults: [{ resultLength: 100 }],
        },
      ];
      const filter = parseFilter('/error');
      const result = applyFilter(noErrors, filter);
      expect(result).toEqual([]);
    });

    it('ignores messages with no tool results', () => {
      const filter = parseFilter('/error');
      const result = applyFilter(messages, filter);
      // Message 1 and 5 are human messages with no toolResults
      expect(result.some((m) => m.id === '1')).toBe(false);
      expect(result.some((m) => m.id === '5')).toBe(false);
    });

    it('is case-insensitive when matching error labels', () => {
      const testMessages: DisplayMessage[] = [
        {
          id: '1',
          role: 'assistant',
          atMs: 1000,
          text: null,
          toolCalls: [{ name: 'tool', label: 'ERROR Handler' }],
          toolResults: [{ resultLength: 100 }],
        },
        {
          id: '2',
          role: 'assistant',
          atMs: 2000,
          text: null,
          toolCalls: [{ name: 'tool', label: 'FAILED operation' }],
          toolResults: [{ resultLength: 100 }],
        },
      ];
      const filter = parseFilter('/error');
      const result = applyFilter(testMessages, filter);
      expect(result).toHaveLength(2);
    });
  });

  describe('fallthrough behavior (unrecognized /verbs as text)', () => {
    it('treats /unknown as bare text search', () => {
      const filter = parseFilter('/unknown hello');
      expect(filter.type).toBe('text');
      const result = applyFilter(messages, filter);
      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('edge cases', () => {
    it('handles messages with null text', () => {
      const filter = parseFilter('logs');
      const result = applyFilter(messages, filter);
      // Should not crash and should return matching messages
      expect(Array.isArray(result)).toBe(true);
    });

    it('handles messages with empty toolCalls array', () => {
      const filter = parseFilter('/tool something');
      const result = applyFilter(messages, filter);
      expect(Array.isArray(result)).toBe(true);
    });

    it('handles messages with empty toolResults array', () => {
      const filter = parseFilter('/error');
      const result = applyFilter(messages, filter);
      expect(Array.isArray(result)).toBe(true);
    });

    it('handles special characters in search text', () => {
      const testMsgs: DisplayMessage[] = [
        {
          id: '1',
          role: 'human',
          atMs: 1000,
          text: 'Check the (test) [result]',
          toolCalls: [],
          toolResults: [],
        },
      ];
      const filter = parseFilter('(test)');
      const result = applyFilter(testMsgs, filter);
      expect(result).toHaveLength(1);
    });

    it('handles very long queries', () => {
      const longQuery = 'a'.repeat(1000);
      const filter = parseFilter(longQuery);
      const result = applyFilter(messages, filter);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('preservation of message order', () => {
    it('preserves the original order of matching messages', () => {
      const filter = parseFilter('test');
      const result = applyFilter(messages, filter);
      // Messages 3 and 4 should appear in order
      expect(result.map((m) => m.id)).toEqual(['3', '4']);
    });
  });
});
