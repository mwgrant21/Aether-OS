import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDatabase, migrate } from './schema.js';
import { scanTranscriptsOnce } from './transcriptScan.js';
import { computeSeverity } from './personalitySpine.js';

// Acceptance gate for Tasks 1-5: proves the two real severity outcomes that
// fall out of the actual pipeline (schema v5 columns -> personalitySpine's
// computeSeverity -> toolCallHistory's dispatch-open capture -> usageIngest's
// real-completion write / staleDispatchSweep's fatal-via-staleness write),
// driven end to end through scanTranscriptsOnce -- the same orchestrator
// harness pattern already used in transcriptScan.test.ts (mkdtemp projects
// root + raw .jsonl fixture lines + scanTranscriptsOnce), rather than a new
// harness. No hand-asserted severity constants: every expected severity is
// computed via the real computeSeverity with the same inputs the pipeline
// used, and merely cross-checked against the spec's known outputs (1 and 4).

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-collector-narration-spine-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

describe('narration spine end-to-end (Stage 11 acceptance gate)', () => {
  it('sev=1: an Agent dispatch that opens and completes normally gets a real ok/sev=1 row', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-narration-spine-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);

    const agentLine = JSON.stringify({
      type: 'assistant',
      sessionId: 's-ok',
      timestamp: '2026-07-08T09:00:00Z',
      message: {
        model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', id: 'tu_ok', name: 'Agent', input: { subagent_type: 'code-reviewer' } }],
      },
    });
    const completionLine = JSON.stringify({
      type: 'user',
      sessionId: 's-ok',
      timestamp: '2026-07-08T09:00:12Z',
      origin: { kind: 'task-notification' },
      message: {
        content: [{
          type: 'text',
          text:
            '<tool-use-id>tu_ok</tool-use-id>' +
            '<subagent_tokens>5000</subagent_tokens><tool_uses>3</tool_uses><duration_ms>12000</duration_ms>',
        }],
      },
    });
    writeFileSync(join(projDir, 'session.jsonl'), `${agentLine}\n${completionLine}\n`, 'utf8');

    const db = freshDb();
    // nowMs a few seconds after the completion: nowhere near the sweep's
    // grace period or fatal timeout, so the sweep must NOT touch this row.
    scanTranscriptsOnce(db, projectsRoot, Date.UTC(2026, 6, 8, 9, 0, 15), new Map());

    const rows: any[] = db.prepare('SELECT * FROM dispatches').all() as any[];
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.tool_use_id).toBe('tu_ok');
    expect(row.exit_state).toBe('ok');
    expect(row.task_kind).toBe('code-reviewer');
    expect(row.agent_id).toBe('code-reviewer');
    expect(row.session_id).toBe('s-ok');

    // Real severity: recompute via the same function the pipeline actually
    // called (duration_ms=12000, retries=0, medianMsAtEval=null), and confirm
    // it lands on the spec's documented "ok" outcome, sev=1.
    const expectedSeverity = computeSeverity({
      exit: 'ok',
      retries: 0,
      elapsedMs: row.duration_ms,
      medianMsAtEval: null,
    });
    expect(expectedSeverity).toBe(1);
    expect(row.severity).toBe(expectedSeverity);

    db.close();
  });

  it('sev=4: an Agent dispatch that opens and never completes gets a real fatal/sev=4 row via the staleness sweep', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-narration-spine-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);

    const agentLine = JSON.stringify({
      type: 'assistant',
      sessionId: 's-fatal',
      timestamp: '2026-07-08T09:00:00Z',
      message: {
        model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', id: 'tu_fatal', name: 'Agent', input: { subagent_type: 'test-runner' } }],
      },
    });
    writeFileSync(join(projDir, 'session.jsonl'), `${agentLine}\n`, 'utf8');

    const db = freshDb();
    // No fleet_sessions row is ever inserted for 's-fatal' -- its session is
    // absent, not merely aged out. nowMs is pushed 40 minutes past the open
    // event, past BOTH the 15s session-liveness grace period and the fixed
    // 30-minute FATAL_TIMEOUT_MS, so this is fatal on either condition alone
    // and not sensitive to which branch staleDispatchSweep takes.
    const openedAtMs = Date.parse('2026-07-08T09:00:00Z');
    const nowMs = openedAtMs + 40 * 60 * 1000;
    scanTranscriptsOnce(db, projectsRoot, nowMs, new Map());

    const rows: any[] = db.prepare('SELECT * FROM dispatches').all() as any[];
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.tool_use_id).toBe('tu_fatal');
    expect(row.exit_state).toBe('fatal');
    expect(row.task_kind).toBe('test-runner');
    expect(row.agent_id).toBe('test-runner');
    expect(row.session_id).toBe('s-fatal');

    const expectedSeverity = computeSeverity({
      exit: 'fatal',
      retries: 0,
      elapsedMs: row.duration_ms,
      medianMsAtEval: null,
    });
    expect(expectedSeverity).toBe(4);
    expect(row.severity).toBe(expectedSeverity);

    db.close();
  });

  it('the ok-completion write path (Task 4) and the fatal-staleness write path (Task 5) populate agent_id/task_kind with the SAME value-shape convention', () => {
    const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-collector-narration-spine-projects-'));
    const projDir = join(projectsRoot, 'my-project');
    mkdirSync(projDir);

    const okLine = JSON.stringify({
      type: 'assistant',
      sessionId: 's-a',
      timestamp: '2026-07-08T09:00:00Z',
      message: {
        model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', id: 'tu_shape_ok', name: 'Agent', input: { subagent_type: 'shared-kind' } }],
      },
    });
    const okCompletionLine = JSON.stringify({
      type: 'user',
      sessionId: 's-a',
      timestamp: '2026-07-08T09:00:05Z',
      origin: { kind: 'task-notification' },
      message: {
        content: [{ type: 'text', text: '<tool-use-id>tu_shape_ok</tool-use-id><duration_ms>1000</duration_ms>' }],
      },
    });
    const fatalLine = JSON.stringify({
      type: 'assistant',
      sessionId: 's-b',
      timestamp: '2026-07-08T09:00:00Z',
      message: {
        model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', id: 'tu_shape_fatal', name: 'Agent', input: { subagent_type: 'shared-kind' } }],
      },
    });
    writeFileSync(
      join(projDir, 'session.jsonl'),
      `${okLine}\n${okCompletionLine}\n${fatalLine}\n`,
      'utf8'
    );

    const db = freshDb();
    const openedAtMs = Date.parse('2026-07-08T09:00:00Z');
    const nowMs = openedAtMs + 40 * 60 * 1000;
    scanTranscriptsOnce(db, projectsRoot, nowMs, new Map());

    const okRow: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu_shape_ok');
    const fatalRow: any = db.prepare('SELECT * FROM dispatches WHERE tool_use_id = ?').get('tu_shape_fatal');
    expect(okRow.exit_state).toBe('ok');
    expect(fatalRow.exit_state).toBe('fatal');

    // Both write paths must derive agent_id/task_kind from the SAME source
    // (the open dispatch's captured subagentType) using the SAME convention
    // (agent_id === task_kind, both equal to the subagent_type string) --
    // not two subtly different shapes for the same underlying concept.
    expect(okRow.task_kind).toBe('shared-kind');
    expect(okRow.agent_id).toBe('shared-kind');
    expect(fatalRow.task_kind).toBe('shared-kind');
    expect(fatalRow.agent_id).toBe('shared-kind');
    expect(okRow.agent_id).toBe(okRow.task_kind);
    expect(fatalRow.agent_id).toBe(fatalRow.task_kind);
    expect(okRow.task_kind).toBe(fatalRow.task_kind);

    db.close();
  });
});
