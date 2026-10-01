import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema.js';
import { scanTranscriptsOnce } from './transcriptScan.js';
import { createMemoryExtractQueue } from './memoryExtractQueue.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-scan-db-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

function assistantLine(inputTokens: number): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    timestamp: '2026-07-08T09:00:00Z',
    message: { model: 'claude-sonnet-4-6', usage: { input_tokens: inputTokens, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [] },
  });
}

describe('scanTranscriptsOnce', () => {
  it('discovers project dirs, ingests assistant+usage lines, and records the file offset', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    writeFileSync(join(projDir, 'session.jsonl'), `${assistantLine(100)}\n${assistantLine(200)}\n`, 'utf8');

    const db = freshDb();
    const result = scanTranscriptsOnce(db, projectsRoot, 1000, new Map());
    expect(result).toEqual({ filesScanned: 1, eventsIngested: 2, toolCallsIngested: 0, anomaliesIngested: 0 });

    const count: any = db.prepare('SELECT COUNT(*) as c FROM usage_events').get();
    expect(count.c).toBe(2);
    const fileRow: any = db.prepare('SELECT * FROM transcript_files').get();
    expect(fileRow.last_scanned_ms).toBe(1000);
    expect(fileRow.last_offset).toBeGreaterThan(0);
    // docs/privacy-and-data.md SS5: stored path must be relative to
    // projectsRoot, not an absolute path containing the home dir/username.
    expect(fileRow.file_path).toBe(join('my-project', 'session.jsonl'));
    expect(fileRow.file_path).not.toContain(projectsRoot);
    db.close();
  });

  it('on a second call, only ingests newly-appended lines, not the whole file again', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    const filePath = join(projDir, 'session.jsonl');
    writeFileSync(filePath, `${assistantLine(100)}\n`, 'utf8');

    const db = freshDb();
    const historyByFile = new Map();
    scanTranscriptsOnce(db, projectsRoot, 1000, historyByFile);
    require('fs').appendFileSync(filePath, `${assistantLine(200)}\n`, 'utf8');
    const second = scanTranscriptsOnce(db, projectsRoot, 2000, historyByFile);
    expect(second.eventsIngested).toBe(1);

    const count: any = db.prepare('SELECT COUNT(*) as c FROM usage_events').get();
    expect(count.c).toBe(2);
    db.close();
  });

  it('ignores non-.jsonl files and non-directory entries under projectsRoot', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    writeFileSync(join(projectsRoot, 'not-a-dir.txt'), 'irrelevant', 'utf8');
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    writeFileSync(join(projDir, 'notes.txt'), 'irrelevant', 'utf8');

    const db = freshDb();
    const result = scanTranscriptsOnce(db, projectsRoot, 1000, new Map());
    expect(result).toEqual({ filesScanned: 0, eventsIngested: 0, toolCallsIngested: 0, anomaliesIngested: 0 });
    db.close();
  });

  it('returns zero counts and does not throw when projectsRoot does not exist', () => {
    const db = freshDb();
    const missingRoot = join(tmpdir(), 'aether-collector-does-not-exist-' + Date.now());
    expect(() => scanTranscriptsOnce(db, missingRoot, 1000, new Map())).not.toThrow();
    expect(scanTranscriptsOnce(db, missingRoot, 1000, new Map())).toEqual({
      filesScanned: 0,
      eventsIngested: 0,
      toolCallsIngested: 0,
      anomaliesIngested: 0,
    });
    db.close();
  });

  it('skips non-assistant or usage-less lines within an otherwise-ingested file', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    const userLine = JSON.stringify({ type: 'user', sessionId: 's1', message: { content: 'hi' } });
    writeFileSync(join(projDir, 'session.jsonl'), `${userLine}\n${assistantLine(100)}\n`, 'utf8');

    const db = freshDb();
    const result = scanTranscriptsOnce(db, projectsRoot, 1000, new Map());
    expect(result.eventsIngested).toBe(1);
    db.close();
  });

  it('ingests tool_calls and flags a reReadLoop anomaly when a fixture transcript reads the same path 3+ times', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);

    // A genuinely absolute path in a DIFFERENT tree from the transcript
    // storage dir -- exactly the production shape.
    const workTree = mkdtempSync(join(tmpdir(), 'aether-worktree-'));
    const absFilePath = join(workTree, 'src', 'foo.ts');

    const lines: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ts = new Date(Date.UTC(2026, 6, 8, 9, 0, i)).toISOString();
      lines.push(
        JSON.stringify({
          type: 'assistant',
          sessionId: 's1',
          timestamp: ts,
          // Real transcript lines carry the session's working directory; it,
          // not the transcript storage directory, is the root that an
          // absolute tool file_path is relative to.
          cwd: workTree,
          message: {
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            content: [{ type: 'tool_use', id: `tu_${i}`, name: 'Read', input: { file_path: absFilePath } }],
          },
        })
      );
      lines.push(
        JSON.stringify({
          type: 'user',
          sessionId: 's1',
          timestamp: ts,
          message: { content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: 'ok' }] },
        })
      );
    }
    writeFileSync(join(projDir, 'session.jsonl'), lines.join('\n') + '\n', 'utf8');

    const db = freshDb();
    const result = scanTranscriptsOnce(db, projectsRoot, Date.UTC(2026, 6, 8, 9, 0, 30), new Map());
    expect(result.toolCallsIngested).toBe(3);
    expect(result.anomaliesIngested).toBe(1);

    // docs/privacy-and-data.md SS5: neither the persisted path nor the
    // anomaly detail may contain the absolute root (home dir/username).
    const toolRows = db.prepare('SELECT file_path_rel FROM tool_calls').all() as { file_path_rel: string | null }[];
    for (const r of toolRows) {
      expect(r.file_path_rel).toBe(join('src', 'foo.ts'));
      expect(r.file_path_rel).not.toContain(workTree);
    }
    const anomalyRows = db.prepare('SELECT detail FROM anomalies').all() as { detail: string }[];
    expect(anomalyRows).toHaveLength(1);
    expect(anomalyRows[0].detail).not.toContain(workTree);
    expect(anomalyRows[0].detail).toContain(join('src', 'foo.ts'));

    db.close();
  });

  // Real two-event shape: an 'Agent' tool_use opens the dispatch, and a
  // 'user'-kind task-notification carrying the XML tags closes it.
  it('records a dispatches row when an Agent tool_use is followed by its task-notification completion', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);

    const agentLine = JSON.stringify({
      type: 'assistant',
      sessionId: 's1',
      timestamp: '2026-07-08T09:00:00Z',
      message: {
        model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', id: 'tu_agent_1', name: 'Agent', input: { subagent_type: 'general-purpose' } }],
      },
    });
    const completionLine = JSON.stringify({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-07-08T09:00:12Z',
      origin: { kind: 'task-notification' },
      message: {
        content: [{
          type: 'text',
          text:
            'Agent finished. <tool-use-id>tu_agent_1</tool-use-id>' +
            '<subagent_tokens>5000</subagent_tokens><tool_uses>3</tool_uses><duration_ms>12000</duration_ms>',
        }],
      },
    });
    writeFileSync(join(projDir, 'session.jsonl'), `${agentLine}\n${completionLine}\n`, 'utf8');

    const db = freshDb();
    scanTranscriptsOnce(db, projectsRoot, Date.UTC(2026, 6, 8, 9, 0, 30), new Map());

    const rows: any[] = db.prepare('SELECT * FROM dispatches').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].tool_use_id).toBe('tu_agent_1');
    expect(rows[0].tokens).toBe(5000);
    expect(rows[0].tool_uses).toBe(3);
    expect(rows[0].duration_ms).toBe(12000);
    expect(rows[0].started_at_ms).toBe(Date.parse('2026-07-08T09:00:00Z'));
    expect(rows[0].ended_at_ms).toBe(Date.parse('2026-07-08T09:00:12Z'));
    db.close();
  });

  it('writes only the completed dispatch as ok, and the never-completed dispatch is later swept as fatal', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);

    const agentLine = (id: string) => JSON.stringify({
      type: 'assistant',
      sessionId: 's1',
      timestamp: '2026-07-08T09:00:00Z',
      message: { model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id, name: 'Agent', input: {} }] },
    });
    const completionLine = JSON.stringify({
      type: 'user',
      sessionId: 's1',
      timestamp: '2026-07-08T09:00:12Z',
      origin: { kind: 'task-notification' },
      message: {
        content: [{ type: 'text', text: '<tool-use-id>tu_a</tool-use-id><subagent_tokens>90</subagent_tokens>' }],
      },
    });
    writeFileSync(
      join(projDir, 'session.jsonl'),
      `${agentLine('tu_a')}\n${agentLine('tu_b')}\n${completionLine}\n`,
      'utf8'
    );

    const db = freshDb();
    scanTranscriptsOnce(db, projectsRoot, Date.UTC(2026, 6, 8, 9, 0, 30), new Map());

    // tu_a completed genuinely (ok) via its task-notification; tu_b never
    // completed and, at this tick's nowMs (30s after it opened, with 's1'
    // never seen in fleet_sessions), is past the staleDispatchSweep grace
    // period with no live session -- so it is swept as fatal in the same tick.
    const rows: any[] = db.prepare('SELECT * FROM dispatches ORDER BY tool_use_id').all() as any[];
    expect(rows.length).toBe(2);
    expect(rows[0].tool_use_id).toBe('tu_a');
    expect(rows[0].exit_state).toBe('ok');
    expect(rows[1].tool_use_id).toBe('tu_b');
    expect(rows[1].exit_state).toBe('fatal');
    db.close();
  });

  it('also scans a session subagents/*.jsonl file, ingesting tool calls with source_file_rel set to the subagent path', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);

    // Top-level session file: one closed Read tool call.
    const sessionLines = [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-1',
        timestamp: '2026-07-08T09:00:00Z',
        message: { model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'tu_top', name: 'Read', input: { file_path: 'src/top.ts' } }] },
      }),
      JSON.stringify({
        type: 'user',
        sessionId: 'sess-1',
        timestamp: '2026-07-08T09:00:01Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_top', content: 'ok' }] },
      }),
    ];
    writeFileSync(join(projDir, 'sess-1.jsonl'), sessionLines.join('\n') + '\n', 'utf8');

    // Subagent dispatch transcript nested under sess-1/subagents/.
    const subagentsDir = join(projDir, 'sess-1', 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    const subLines = [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-1',
        timestamp: '2026-07-08T09:00:02Z',
        message: { model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'tu_sub', name: 'Edit', input: { file_path: 'src/sub.ts' } }] },
      }),
      JSON.stringify({
        type: 'user',
        sessionId: 'sess-1',
        timestamp: '2026-07-08T09:00:03Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_sub', content: 'ok' }] },
      }),
    ];
    writeFileSync(join(subagentsDir, 'agent-x.jsonl'), subLines.join('\n') + '\n', 'utf8');

    const db = freshDb();
    const result = scanTranscriptsOnce(db, projectsRoot, 1000, new Map());

    // Both the top-level session tool call and the subagent's own tool call
    // are ingested.
    expect(result.toolCallsIngested).toBe(2);

    const subRows = db
      .prepare('SELECT tool_use_id, file_path_rel FROM tool_calls WHERE source_file_rel = ?')
      .all(join('my-project', 'sess-1', 'subagents', 'agent-x.jsonl')) as { tool_use_id: string; file_path_rel: string }[];
    expect(subRows).toHaveLength(1);
    expect(subRows[0].tool_use_id).toBe('tu_sub');

    const topRows = db
      .prepare('SELECT tool_use_id FROM tool_calls WHERE source_file_rel = ?')
      .all(join('my-project', 'sess-1.jsonl')) as { tool_use_id: string }[];
    expect(topRows).toHaveLength(1);
    expect(topRows[0].tool_use_id).toBe('tu_top');

    db.close();
  });

  it('ingests a nested subagent transcript\'s own token usage into usage_events', () => {
    // The nested loop already ingested tool calls and anomalies but never
    // called ingestUsageEvent, so every dispatch's own token spend was
    // missing from the store -- exactly the workload Cost Forensics exists
    // to measure. The pre-existing nested test asserted tool calls only,
    // which is why this went unnoticed. See issue #25.
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-subusage-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);

    const usageLine = (ts: string, input: number, output: number) =>
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-1',
        timestamp: ts,
        message: {
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });

    writeFileSync(join(projDir, 'sess-1.jsonl'), usageLine('2026-07-08T09:00:00Z', 100, 10) + '\n', 'utf8');

    const subagentsDir = join(projDir, 'sess-1', 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(join(subagentsDir, 'agent-x.jsonl'), usageLine('2026-07-08T09:00:02Z', 7000, 900) + '\n', 'utf8');

    const db = freshDb();
    const result = scanTranscriptsOnce(db, projectsRoot, 1000, new Map());

    // Both the parent turn and the subagent's turn are usage events.
    expect(result.eventsIngested).toBe(2);

    const totals = db
      .prepare('SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM usage_events')
      .get() as { input: number; output: number };
    expect(totals.input).toBe(7100);
    expect(totals.output).toBe(910);
  });

  // Liveness heartbeat for the diagnostics reader (electron/collectorStore.ts's
  // readDiagnostics), mirroring the fleet poll's fleet_last_poll_ms.
  it('stamps the transcript-scan heartbeat even when the projects root is unreadable', () => {
    const db = freshDb();
    scanTranscriptsOnce(db, join(tmpdir(), 'aether-does-not-exist-' + Date.now()), 12345, new Map());
    const row: any = db.prepare("SELECT value FROM schema_meta WHERE key = 'transcript_last_scan_ms'").get();
    expect(row?.value).toBe('12345');
    db.close();
  });
});

// A closed, substantive Agent dispatch: an assistant tool_use named 'Agent'
// followed by its task-notification completion. Shaped after a REAL captured
// task-notification event: message.content is a plain string with every tag
// inline, including <result> -- not a content-block array, and no separate
// tool_result item at all.
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

function taskNotificationLine(
  toolUseId: string,
  timestamp: string,
  parts: { tokens?: number; toolUses?: number; durationMs?: number; resultBody?: string } = {},
): string {
  const {
    tokens = 100,
    toolUses = 6,
    durationMs = 65_000,
    resultBody = 'Implemented the feature, all tests passing.',
  } = parts;
  const content =
    '<task-notification>\n' +
    `<tool-use-id>${toolUseId}</tool-use-id>\n` +
    `<result>${resultBody}</result>\n` +
    `<subagent_tokens>${tokens}</subagent_tokens>\n` +
    `<tool_uses>${toolUses}</tool_uses>\n` +
    `<duration_ms>${durationMs}</duration_ms>\n` +
    '</task-notification>';
  return JSON.stringify({
    type: 'user',
    sessionId: 's1',
    timestamp,
    origin: { kind: 'task-notification' },
    message: { content },
  });
}

describe('scanTranscriptsOnce -- memory extraction queueing', () => {
  it('does not queue an ok dispatch that has no usage block (NULL usage)', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-mem-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    const content =
      '<task-notification>\n<tool-use-id>tu_n</tool-use-id>\n<status>completed</status>\n' +
      '<result>Did a lot of work.</result>\n</task-notification>';
    const notification = JSON.stringify({ type: 'user', sessionId: 's1', timestamp: '2026-07-08T09:01:30Z', origin: { kind: 'task-notification' }, message: { content } });
    writeFileSync(join(projDir, 'session.jsonl'), `${agentToolUseLine('tu_n', '2026-07-08T09:00:00Z')}\n${notification}\n`, 'utf8');
    const db = freshDb();
    const queue = createMemoryExtractQueue();
    scanTranscriptsOnce(db, projectsRoot, 2000, new Map(), queue);
    const row: any = db.prepare('SELECT exit_state, duration_ms FROM dispatches WHERE tool_use_id = ?').get('tu_n');
    expect(row).toEqual({ exit_state: 'ok', duration_ms: null });
    expect(queue.size()).toBe(0);
    db.close();
  });

  it('does not queue failed or killed dispatches, even substantive ones with usage', () => {
    for (const status of ['failed', 'killed']) {
      const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-mem-projects-'));
      const projDir = join(projectsRoot, 'my-project');
      mkdirSync(projDir);
      const content =
        '<task-notification>\n<tool-use-id>tu_x</tool-use-id>\n' +
        `<status>${status}</status>\n<result>Did a lot of work.</result>\n` +
        '<subagent_tokens>100</subagent_tokens>\n<tool_uses>9</tool_uses>\n<duration_ms>90000</duration_ms>\n</task-notification>';
      const notification = JSON.stringify({ type: 'user', sessionId: 's1', timestamp: '2026-07-08T09:01:30Z', origin: { kind: 'task-notification' }, message: { content } });
      writeFileSync(join(projDir, 'session.jsonl'), `${agentToolUseLine('tu_x', '2026-07-08T09:00:00Z')}\n${notification}\n`, 'utf8');
      const db = freshDb();
      const queue = createMemoryExtractQueue();
      scanTranscriptsOnce(db, projectsRoot, 2000, new Map(), queue);
      expect(queue.size()).toBe(0);
      db.close();
    }
  });

  it('queues a closed, substantive Agent dispatch for extraction when a queue is provided', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-mem-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    const lines = [
      agentToolUseLine('tu_1', '2026-07-08T09:00:00Z'),
      taskNotificationLine('tu_1', '2026-07-08T09:01:05Z', { durationMs: 65_000, toolUses: 6 }),
    ].join('\n');
    writeFileSync(join(projDir, 'session.jsonl'), `${lines}\n`, 'utf8');

    const db = freshDb();
    const queue = createMemoryExtractQueue();
    scanTranscriptsOnce(db, projectsRoot, 2000, new Map(), queue);

    expect(queue.size()).toBe(1);
    const drained = queue.drain();
    expect(drained[0]).toMatchObject({
      agentId: 'CINDER',
      toolUseId: 'tu_1',
      runSummary: 'Implemented the feature, all tests passing.',
    });
    db.close();
  });

  it('does not queue a dispatch that falls below the extraction bar (short duration, few tool uses)', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-mem-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    const lines = [
      agentToolUseLine('tu_1', '2026-07-08T09:00:00Z'),
      taskNotificationLine('tu_1', '2026-07-08T09:00:05Z', { durationMs: 3_000, toolUses: 1 }),
    ].join('\n');
    writeFileSync(join(projDir, 'session.jsonl'), `${lines}\n`, 'utf8');

    const db = freshDb();
    const queue = createMemoryExtractQueue();
    scanTranscriptsOnce(db, projectsRoot, 2000, new Map(), queue);

    expect(queue.size()).toBe(0);
    db.close();
  });

  it('does not queue a dispatch whose task-notification carries no <result> tag', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-mem-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    const lines = [
      agentToolUseLine('tu_1', '2026-07-08T09:00:00Z'),
      taskNotificationLine('tu_1', '2026-07-08T09:01:05Z', { durationMs: 65_000, toolUses: 6, resultBody: '' }),
    ].join('\n');
    writeFileSync(join(projDir, 'session.jsonl'), `${lines}\n`, 'utf8');

    const db = freshDb();
    const queue = createMemoryExtractQueue();
    scanTranscriptsOnce(db, projectsRoot, 2000, new Map(), queue);

    expect(queue.size()).toBe(0);
    db.close();
  });

  it('does not queue anything, and does not throw, when no queue is provided (existing callers unaffected)', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-mem-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    const lines = [
      agentToolUseLine('tu_1', '2026-07-08T09:00:00Z'),
      taskNotificationLine('tu_1', '2026-07-08T09:01:05Z', { durationMs: 65_000, toolUses: 6 }),
    ].join('\n');
    writeFileSync(join(projDir, 'session.jsonl'), `${lines}\n`, 'utf8');

    const db = freshDb();
    expect(() => scanTranscriptsOnce(db, projectsRoot, 2000, new Map())).not.toThrow();
    db.close();
  });

});

describe('scanTranscriptsOnce -- tool-error floor and subagent progress (spike GO)', () => {
  const errLine = () =>
    JSON.stringify({
      type: 'user',
      sessionId: 'S1',
      timestamp: '2026-07-08T09:00:05Z',
      isSidechain: true,
      message: { content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'SECRET-ERROR-TEXT' }] },
    });
  const parentLines = (id: string) => [
    agentToolUseLine(id, '2026-07-08T09:00:00Z'),
    taskNotificationLine(id, '2026-07-08T09:00:12Z', { durationMs: 12000 }),
  ];
  function withStatus(line: string): string {
    return line.replace('</tool-use-id>', '</tool-use-id><status>completed</status>');
  }
  function sub(root: string, proj: string, session: string, meta: string | null, lines: string[]) {
    const d = join(root, proj, session, 'subagents');
    mkdirSync(d, { recursive: true });
    if (meta !== null) writeFileSync(join(d, 'agent-a.meta.json'), meta);
    writeFileSync(join(d, 'agent-a.jsonl'), lines.join('\n') + '\n', 'utf8');
  }
  const run = (root: string) => {
    const db = freshDb();
    scanTranscriptsOnce(db, root, Date.UTC(2026, 6, 8, 9, 0, 30), new Map());
    return db;
  };
  const severityOf = (db: ReturnType<typeof freshDb>, id: string) =>
    (db.prepare('SELECT severity, exit_state FROM dispatches WHERE tool_use_id = ?').get(id) as any);

  it('meta.json link plus 3 tool errors in the subagent file stores severity 3 (F3)', () => {
    const root = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    mkdirSync(join(root, 'projA'));
    const [a, n] = parentLines('toolu_E');
    writeFileSync(join(root, 'projA', 'S1.jsonl'), [a, withStatus(n)].join('\n') + '\n', 'utf8');
    sub(root, 'projA', 'S1', '{"toolUseId":"toolu_E"}', [errLine(), errLine(), errLine()]);
    const db = run(root);
    expect(severityOf(db, 'toolu_E')).toMatchObject({ severity: 3, exit_state: 'ok' });
    const dump = JSON.stringify(db.prepare('SELECT * FROM dispatches').all());
    expect(dump).not.toContain('SECRET-ERROR-TEXT');
    db.close();
  });

  it('2 tool errors, or no meta.json, or malformed meta.json -> severity from status alone (1)', () => {
    for (const [meta, n] of [['{"toolUseId":"toolu_E"}', 2], [null, 3], ['{oops', 3], ['{"toolUseId":7}', 3]] as const) {
      const root = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
      mkdirSync(join(root, 'projA'));
      const [a, nt] = parentLines('toolu_E');
      writeFileSync(join(root, 'projA', 'S1.jsonl'), [a, withStatus(nt)].join('\n') + '\n', 'utf8');
      sub(root, 'projA', 'S1', meta, Array.from({ length: n }, errLine));
      const db = run(root);
      expect(severityOf(db, 'toolu_E').severity).toBe(1);
      db.close();
    }
  });

  it('links across project dirs: subagent dir in projA, parent transcript in projB', () => {
    const root = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    mkdirSync(join(root, 'projB'));
    const [a, n] = parentLines('toolu_X');
    writeFileSync(join(root, 'projB', 'S1.jsonl'), [a, withStatus(n)].join('\n') + '\n', 'utf8');
    sub(root, 'projA', 'S1', '{"toolUseId":"toolu_X"}', [errLine(), errLine(), errLine()]);
    const db = run(root);
    expect(severityOf(db, 'toolu_X').severity).toBe(3);
    db.close();
  });

  it('F12: the subagent transcript itself is still ingested under its own path after sessionBase moved', () => {
    const root = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    mkdirSync(join(root, 'projA'));
    writeFileSync(join(root, 'projA', 'S1.jsonl'), agentToolUseLine('toolu_F', '2026-07-08T09:00:00Z') + '\n', 'utf8');
    const readUse = JSON.stringify({
      type: 'assistant', sessionId: 'S1', timestamp: '2026-07-08T09:00:02Z',
      message: { model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'tu_s', name: 'Read', input: { file_path: 'a.ts' } }] },
    });
    const readDone = JSON.stringify({
      type: 'user', sessionId: 'S1', timestamp: '2026-07-08T09:00:03Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_s', content: 'ok' }] },
    });
    sub(root, 'projA', 'S1', '{"toolUseId":"toolu_F"}', [readUse, readDone]);
    const db = run(root);
    const rows = db.prepare('SELECT tool_use_id FROM tool_calls WHERE source_file_rel = ?').all(join('projA', 'S1', 'subagents', 'agent-a.jsonl'));
    expect(rows).toHaveLength(1);
    db.close();
  });

  it('a never-completed dispatch with recent subagent-file writes is not swept as fatal (F15)', () => {
    const root = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    mkdirSync(join(root, 'projA'));
    writeFileSync(join(root, 'projA', 'S1.jsonl'), agentToolUseLine('toolu_P', '2026-07-08T08:00:00Z') + '\n', 'utf8');
    sub(root, 'projA', 'S1', '{"toolUseId":"toolu_P"}', [errLine()]);
    const nowMs = Date.UTC(2026, 6, 8, 9, 0, 30);
    const f = join(root, 'projA', 'S1', 'subagents', 'agent-a.jsonl');
    utimesSync(f, (nowMs - 60_000) / 1000, (nowMs - 60_000) / 1000);
    const db = freshDb();
    db.prepare(
      `INSERT INTO fleet_sessions (session_id, pid, project_name, kind, status, name, started_at_ms, last_seen_ms)
       VALUES ('s1', NULL, 'proj', 'agent', 'running', 'agent', 0, ?)`,
    ).run(nowMs - 1000);
    scanTranscriptsOnce(db, root, nowMs, new Map());
    expect(db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('toolu_P')).toBeUndefined();
    db.close();
  });

  function nestedLayout(root: string, parentNotifies: boolean, nestedLines: string[]) {
    mkdirSync(join(root, 'projA'));
    const [a, n] = parentLines('toolu_P');
    writeFileSync(join(root, 'projA', 'S1.jsonl'), [a, withStatus(n)].join('\n') + '\n', 'utf8');
    const d = join(root, 'projA', 'S1', 'subagents');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'agent-p.meta.json'), '{"toolUseId":"toolu_P"}');
    writeFileSync(join(d, 'agent-p.jsonl'), nestedLines.join('\n') + '\n', 'utf8');
    writeFileSync(join(d, 'agent-n.meta.json'), '{"toolUseId":"toolu_N"}');
    writeFileSync(join(d, 'agent-n.jsonl'), [errLine(), errLine(), errLine()].join('\n') + '\n', 'utf8');
    return parentNotifies;
  }

  it('nested (depth-2) dispatch: tool_use and task-notification in a sibling subagent file get a row, severity 3 from its own errors', () => {
    const root = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    nestedLayout(root, true, [
      agentToolUseLine('toolu_N', '2026-07-08T09:00:01Z'),
      withStatus(taskNotificationLine('toolu_N', '2026-07-08T09:00:10Z')),
    ]);
    const db = run(root);
    expect(severityOf(db, 'toolu_P')).toMatchObject({ severity: 1, exit_state: 'ok' });
    expect(severityOf(db, 'toolu_N')).toMatchObject({ severity: 3, exit_state: 'ok' });
    db.close();
  });

  it('nested dispatch that closes by tool_result only is never stored as fatal, even 30+ min later', () => {
    const root = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    const toolResult = JSON.stringify({
      type: 'user', sessionId: 'S1', timestamp: '2026-07-08T09:00:10Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_N', content: 'done' }] },
    });
    nestedLayout(root, true, [agentToolUseLine('toolu_N', '2026-07-08T09:00:01Z'), toolResult]);
    const db = freshDb();
    scanTranscriptsOnce(db, root, Date.UTC(2026, 6, 8, 10, 30, 0), new Map());
    expect(db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('toolu_N')).toBeUndefined();
    db.close();
  });
});

describe('scanTranscriptsOnce -- backfill severity is scan-order independent (#106)', () => {
  const agentUse = (id: string, at: string) => JSON.stringify({
    type: 'assistant', sessionId: 's1', timestamp: at,
    message: { model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: 'explorer' } }] },
  });
  const done = (id: string, at: string, durationMs: number) => JSON.stringify({
    type: 'user', sessionId: 's1', timestamp: at, origin: { kind: 'task-notification' },
    message: { content: [{ type: 'text', text:
      `<tool-use-id>${id}</tool-use-id><status>completed</status>` +
      `<subagent_tokens>100</subagent_tokens><tool_uses>2</tool_uses><duration_ms>${durationMs}</duration_ms>` }] },
  });
  // Five 10s baseline runs, then one 40s run an hour later (> 3x median).
  const earlyLines = [1, 2, 3, 4, 5].flatMap((n) => [
    agentUse(`tu_base_${n}`, `2026-07-08T09:0${n}:00Z`),
    done(`tu_base_${n}`, `2026-07-08T09:0${n}:10Z`, 10_000),
  ]);
  const lateLines = [agentUse('tu_late', '2026-07-08T10:00:00Z'), done('tu_late', '2026-07-08T10:00:40Z', 40_000)];

  // Same content under both file names, so one of the two runs always reads
  // the late file before the baseline whatever order readdirSync returns.
  for (const [lateName, earlyName] of [['a.jsonl', 'b.jsonl'], ['b.jsonl', 'a.jsonl']]) {
    it(`scores the late run against its earlier baseline when it is in ${lateName}`, () => {
      const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
      const projDir = join(projectsRoot, 'my-project');
      mkdirSync(projDir);
      writeFileSync(join(projDir, lateName), `${lateLines.join('\n')}\n`, 'utf8');
      writeFileSync(join(projDir, earlyName), `${earlyLines.join('\n')}\n`, 'utf8');

      const db = freshDb();
      scanTranscriptsOnce(db, projectsRoot, Date.UTC(2026, 6, 8, 10, 1, 0), new Map());

      const late = db.prepare('SELECT severity, median_ms_at_eval, exit_state FROM dispatches WHERE tool_use_id = ?').get('tu_late');
      expect(late).toMatchObject({ severity: 2, median_ms_at_eval: 10_000, exit_state: 'ok' });
      db.close();
    });
  }
});

describe('scanTranscriptsOnce -- a failed pass checkpoints nothing', () => {
  it('rolls back usage rows and offsets, and keeps prior histories, when the deferred dispatch flush throws', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-scan-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);
    const completion = JSON.stringify({
      type: 'user', sessionId: 's1', timestamp: '2026-07-08T09:00:12Z', origin: { kind: 'task-notification' },
      message: { content: [{ type: 'text', text: '<tool-use-id>tu_x</tool-use-id><status>completed</status>' }] },
    });
    const agentUse = JSON.stringify({
      type: 'assistant', sessionId: 's1', timestamp: '2026-07-08T09:00:00Z',
      message: { model: 'claude-sonnet-4-6', content: [{ type: 'tool_use', id: 'tu_x', name: 'Agent', input: {} }] },
    });
    writeFileSync(join(projDir, 'session.jsonl'), `${assistantLine(100)}\n${agentUse}\n${completion}\n`, 'utf8');

    const db = freshDb();
    db.exec('DROP TABLE dispatches'); // the flush's INSERT now fails
    const histories = new Map();
    expect(() => scanTranscriptsOnce(db, projectsRoot, Date.UTC(2026, 6, 8, 9, 0, 30), histories)).toThrow(/dispatches/);

    expect((db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as any).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM transcript_files').get() as any).n).toBe(0);
    expect(histories.size).toBe(0);
    db.close();
  });
});
