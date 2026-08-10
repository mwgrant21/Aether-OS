import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from 'fs';
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

describe('subagent usage backfill (upgrade path)', () => {
  it('backfills usage for nested files already scanned at EOF, without duplicating their tool calls', () => {
    // A database written by a pre-#25 collector already recorded each nested
    // file's offset at EOF and its tool calls, but never its usage. Without a
    // backfill, ingestUsageEvent sees no new bytes and the historical
    // subagent spend stays missing forever. Codex review of PR #28.
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-backfill-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(join(projDir, 'sess-1', 'subagents'), { recursive: true });

    const line = (ts: string, input: number, output: number) =>
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-1',
        timestamp: ts,
        message: {
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'x' }],
          usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });

    writeFileSync(join(projDir, 'sess-1.jsonl'), line('2026-07-08T09:00:00Z', 100, 10) + '\n', 'utf8');
    const subPath = join(projDir, 'sess-1', 'subagents', 'agent-x.jsonl');
    writeFileSync(subPath, line('2026-07-08T09:00:02Z', 7000, 900) + '\n', 'utf8');

    const db = freshDb();

    // Simulate the pre-fix state: both files fully scanned (offsets at EOF),
    // but no usage row was ever written for the nested one.
    const subRel = join('my-project', 'sess-1', 'subagents', 'agent-x.jsonl');
    const topRel = join('my-project', 'sess-1.jsonl');
    const size = (p: string) => statSync(p).size;
    for (const [rel, abs] of [[topRel, join(projDir, 'sess-1.jsonl')], [subRel, subPath]] as const) {
      db.prepare('INSERT INTO transcript_files (file_path, last_offset, last_scanned_ms) VALUES (?, ?, ?)').run(rel, size(abs), 1);
    }
    // Only the top-level file's usage was ingested by the old collector.
    db.prepare(
      'INSERT INTO usage_events (occurred_at_ms, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(Date.parse('2026-07-08T09:00:00Z'), 'claude-sonnet-4-6', 100, 10, 0, 0);
    // Its nested tool call, however, WAS ingested -- this is what a naive
    // offset reset would duplicate.
    db.prepare(
      'INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms, source_file_rel) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('tu_sub', 'Edit', 'src/sub.ts', 1, 2, subRel);

    // Roll the recorded version back to before the backfill migration, then
    // re-migrate as an upgrading process would.
    db.prepare("UPDATE schema_meta SET value = '6' WHERE key = 'version'").run();
    migrate(db);

    scanTranscriptsOnce(db, projectsRoot, 2000, new Map());

    const usage = db.prepare('SELECT COUNT(*) AS n, SUM(input_tokens) AS input FROM usage_events').get() as { n: number; input: number };
    expect(usage.n).toBe(2);
    expect(usage.input).toBe(7100);

    // The nested tool call must NOT be duplicated by the backfill.
    const toolCalls = db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get() as { n: number };
    expect(toolCalls.n).toBe(1);

    // Offsets are left alone -- the backfill reads content, it does not rewind.
    const off = db.prepare('SELECT last_offset FROM transcript_files WHERE file_path = ?').get(subRel) as { last_offset: number };
    expect(off.last_offset).toBe(size(subPath));
  });

  it('does not backfill twice across consecutive scans', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-backfill-once-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(join(projDir, 'sess-1', 'subagents'), { recursive: true });
    const subPath = join(projDir, 'sess-1', 'subagents', 'agent-x.jsonl');
    writeFileSync(
      subPath,
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-1',
        timestamp: '2026-07-08T09:00:02Z',
        message: { model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 500, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      }) + '\n',
      'utf8',
    );

    const db = freshDb();
    const subRel = join('my-project', 'sess-1', 'subagents', 'agent-x.jsonl');
    db.prepare('INSERT INTO transcript_files (file_path, last_offset, last_scanned_ms) VALUES (?, ?, ?)').run(subRel, statSync(subPath).size, 1);
    db.prepare("UPDATE schema_meta SET value = '6' WHERE key = 'version'").run();
    migrate(db);

    scanTranscriptsOnce(db, projectsRoot, 2000, new Map());
    scanTranscriptsOnce(db, projectsRoot, 3000, new Map());

    const usage = db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number };
    expect(usage.n).toBe(1);
  });
});
