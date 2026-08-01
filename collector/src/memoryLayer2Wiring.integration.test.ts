import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate } from './schema.js';
import { scanTranscriptsOnce } from './transcriptScan.js';
import { createMemoryStore } from './memoryStore.js';
import { createMemoryExtractQueue, drainMemoryExtractQueue } from './memoryExtractQueue.js';

// Mirrors the fixture helpers introduced in Task 3's transcriptScan.test.ts
// additions, kept local to this file since an integration test should not
// depend on another test file's unexported helpers.
function agentToolUseLine(toolUseId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    timestamp,
    message: {
      model: 'claude-sonnet-4-6',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { subagent_type: 'CINDER' } }],
    },
  });
}

function taskNotificationLine(toolUseId: string, timestamp: string): string {
  // Shaped after a REAL captured task-notification event: message.content is
  // a plain string with every tag inline, including <result> -- not a
  // content-block array, and no separate tool_result item at all.
  const content =
    '<task-notification>\n' +
    `<tool-use-id>${toolUseId}</tool-use-id>\n` +
    '<result>User overruled a suggestion to add a retry loop, accepting unbounded retry instead.</result>\n' +
    '<subagent_tokens>500</subagent_tokens>\n' +
    '<tool_uses>8</tool_uses>\n' +
    '<duration_ms>90000</duration_ms>\n' +
    '</task-notification>';
  return JSON.stringify({
    type: 'user',
    sessionId: 's1',
    timestamp,
    origin: { kind: 'task-notification' },
    message: { content },
  });
}

describe('Memory Layer 2 wiring -- end to end', () => {
  it('scans a transcript with a substantive closed dispatch, queues it, drains it through a fake model, and lands a row in memory.db', async () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-e2e-mem-projects-'));
    const dbDir = mkdtempSync(join(tmpdir(), 'aether-e2e-mem-db-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    const lines = [
      agentToolUseLine('tu_1', '2026-07-08T09:00:00Z'),
      taskNotificationLine('tu_1', '2026-07-08T09:01:30Z'),
    ].join('\n');
    writeFileSync(join(projDir, 'session.jsonl'), `${lines}\n`, 'utf8');

    const db = openDatabase(join(dbDir, 'collector.db'));
    migrate(db);
    const memoryStore = createMemoryStore(join(dbDir, 'memory.db'));
    const extractQueue = createMemoryExtractQueue();

    try {
      scanTranscriptsOnce(db, projectsRoot, Date.now(), new Map(), extractQueue);
      expect(extractQueue.size()).toBe(1);

      await drainMemoryExtractQueue(memoryStore, extractQueue, async () => ({
        stdout:
          '[{"op":"ADD","kind":"overrule","content":"Matt overruled adding a retry loop, accepting unbounded retry instead."}]',
      }));

      const rows = memoryStore.getPrivateCandidates('CINDER');
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toContain('unbounded retry');
      expect(rows[0].kind).toBe('overrule');
    } finally {
      memoryStore.close();
      db.close();
      rmSync(projectsRoot, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
