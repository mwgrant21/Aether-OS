import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema.js';
import { scanTranscriptsOnce } from './transcriptScan.js';

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

  it('does not write a dispatches row for a dispatch that has no completion notification', () => {
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

    const rows: any[] = db.prepare('SELECT * FROM dispatches').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].tool_use_id).toBe('tu_a');
    db.close();
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
