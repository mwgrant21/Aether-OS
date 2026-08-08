import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';
import { resolveDispatchEvidence } from './dispatchEvidence';
import type { GitProbe } from '../../src/shared/projectIdentity';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aether-dispatch-evidence-db-'));
  const db = new DatabaseSync(join(dir, 'test.db'));
  db.exec(
    `CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, file_path_rel TEXT, started_at_ms INTEGER NOT NULL, closed_at_ms INTEGER NOT NULL, source_file_rel TEXT);`
  );
  return db;
}

// Mirrors transcriptScan.ts's own relative-path construction: path.join(
// <projectDirName>, <sessionId>, 'subagents', '<agentBase>.jsonl'), where
// <projectDirName> is sessionDir's own basename.
function sourceFileRelFor(sessionDir: string, sessionId: string, agentBase: string): string {
  return join(basename(sessionDir), sessionId, 'subagents', `${agentBase}.jsonl`);
}

interface Fixture {
  sessionDir: string;
  sessionId: string;
  agentBase: string;
  toolUseId: string;
  projectRoot: string;
}

/** Builds a sessionDir with a session file, one subagents/<agentBase>.jsonl +
 *  <agentBase>.meta.json (toolUseId matching), following transcriptReader's
 *  own on-disk layout and transcriptReader.test.ts's fixture style. */
function buildFixture(opts: {
  assistantText?: string | null;
  cwd?: string | null;
}): Fixture {
  const projectsRoot = mkdtempSync(join(tmpdir(), 'aether-dispatch-evidence-projects-'));
  const sessionDir = join(projectsRoot, 'my-project');
  mkdirSync(sessionDir, { recursive: true });

  const sessionId = 'sess-1';
  const agentBase = 'agent-x';
  const toolUseId = 'tool-99';
  const projectRoot = mkdtempSync(join(tmpdir(), 'aether-dispatch-evidence-repo-'));

  writeFileSync(join(sessionDir, `${sessionId}.jsonl`), '', 'utf8');

  const subagentsDir = join(sessionDir, sessionId, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });

  writeFileSync(
    join(subagentsDir, `${agentBase}.meta.json`),
    JSON.stringify({ agentType: 'general-purpose', description: 'Fix widget bug', toolUseId }),
    'utf8'
  );

  const cwd = opts.cwd === undefined ? projectRoot : opts.cwd;
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      uuid: 'a1',
      isSidechain: true,
      type: 'user',
      sessionId,
      timestamp: '2026-08-05T12:00:00.000Z',
      cwd,
      message: { role: 'user', content: 'do the thing' },
    })
  );
  if (opts.assistantText !== null) {
    lines.push(
      JSON.stringify({
        uuid: 'a2',
        isSidechain: true,
        type: 'assistant',
        sessionId,
        timestamp: '2026-08-05T12:00:05.000Z',
        cwd,
        message: {
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: opts.assistantText ?? 'Task complete: added feature X.' }],
        },
      })
    );
  }
  writeFileSync(join(subagentsDir, `${agentBase}.jsonl`), lines.join('\n') + '\n', 'utf8');

  return { sessionDir, sessionId, agentBase, toolUseId, projectRoot };
}

const alwaysTrueProbe: GitProbe = () => true;
const alwaysFalseProbe: GitProbe = () => false;

describe('resolveDispatchEvidence', () => {
  it('resolves claim, project root, and touched files for a known dispatch', async () => {
    const fx = buildFixture({});
    const db = freshDb();
    const sourceFileRel = sourceFileRelFor(fx.sessionDir, fx.sessionId, fx.agentBase);
    db.prepare(
      'INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms, source_file_rel) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('tu_edit_1', 'Edit', 'src/widget.ts', 1000, 2000, sourceFileRel);

    const result = await resolveDispatchEvidence(fx.toolUseId, db, fx.sessionDir, fx.sessionId, alwaysTrueProbe);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.toolUseId).toBe(fx.toolUseId);
    expect(result.evidence.claim).toBe('Task complete: added feature X.');
    expect(result.evidence.touchedFiles).toEqual(['src/widget.ts']);
    expect(result.evidence.projectRoot).toBeTruthy();
  });

  it('returns missing when the dispatch transcript cannot be found', async () => {
    const fx = buildFixture({});
    const db = freshDb();

    const result = await resolveDispatchEvidence('tool-does-not-exist', db, fx.sessionDir, fx.sessionId, alwaysTrueProbe);

    expect(result).toEqual({ ok: false, missing: 'dispatch transcript not found' });
  });

  it('returns missing when no final assistant message exists', async () => {
    const fx = buildFixture({ assistantText: null });
    const db = freshDb();

    const result = await resolveDispatchEvidence(fx.toolUseId, db, fx.sessionDir, fx.sessionId, alwaysTrueProbe);

    expect(result).toEqual({ ok: false, missing: 'no final assistant message found for this dispatch' });
  });

  it('returns missing when no exact file-touch correlation exists for this dispatch', async () => {
    const fx = buildFixture({});
    const db = freshDb();
    // No tool_calls rows at all, so nothing correlates to this dispatch's
    // source_file_rel.

    const result = await resolveDispatchEvidence(fx.toolUseId, db, fx.sessionDir, fx.sessionId, alwaysTrueProbe);

    expect(result).toEqual({ ok: false, missing: 'no exact file-touch correlation available for this dispatch' });
  });

  it('returns missing when project root cannot be resolved', async () => {
    const fx = buildFixture({});
    const db = freshDb();
    const sourceFileRel = sourceFileRelFor(fx.sessionDir, fx.sessionId, fx.agentBase);
    db.prepare(
      'INSERT INTO tool_calls (tool_use_id, tool_name, file_path_rel, started_at_ms, closed_at_ms, source_file_rel) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('tu_edit_1', 'Edit', 'src/widget.ts', 1000, 2000, sourceFileRel);

    // alwaysFalseProbe means resolveProject's ancestor-walk never finds a
    // .git entry, so the cwd is genuinely unattributable to any repo.
    const result = await resolveDispatchEvidence(fx.toolUseId, db, fx.sessionDir, fx.sessionId, alwaysFalseProbe);

    expect(result).toEqual({ ok: false, missing: 'dispatch project root could not be resolved' });
  });
});
