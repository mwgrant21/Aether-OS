// Resolves a completed dispatch's evidence for cross-engine verification:
// what it claimed to have done, which project it ran in, and which files its
// own tool calls actually touched. See the Task 0 reconciliation note under
// docs/superpowers/specs/ (2026-08-07, cross-engine verification) for the
// design rationale -- in particular why this correlates via
// tool_calls.source_file_rel (schema v6) rather than an ingest-time
// dispatch_tool_use_id column, and why project-root resolution reads cwd off
// the dispatch's own transcript rather than a stored column.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { resolveSourcePath, readTranscript, listTranscriptSources } from '../transcriptReader';
import { parseTranscriptLine } from '../transcriptParser';
import { resolveProject, type GitProbe } from '../../src/shared/projectIdentity';

export interface DispatchEvidence {
  toolUseId: string;
  projectRoot: string;
  claim: string;
  touchedFiles: string[];
}

export type EvidenceResult = { ok: true; evidence: DispatchEvidence } | { ok: false; missing: string };

/** Finds the dispatch's own transcript source id by matching toolUseId
 *  against each subagent's meta.json -- the same lookup
 *  transcriptReader.listTranscriptSources already performs for the Comms
 *  Deck, reused here rather than re-implemented. */
async function findDispatchSourceId(sessionDir: string, pinnedSessionId: string, toolUseId: string): Promise<string | null> {
  const sources = await listTranscriptSources(sessionDir, pinnedSessionId);
  const match = sources.find((s) => s.kind === 'dispatch' && s.toolUseId === toolUseId);
  return match?.id ?? null;
}

/** Pages backward from the tail of the dispatch's transcript until it finds
 *  a non-empty assistant message -- readTranscript has no "last assistant
 *  message only" mode, so this is the smallest correct wrapper.
 *
 *  Field-name note: TranscriptReadResult (electron/transcriptReader.ts) has
 *  no `hasMore` field -- `nextBefore: string | null` doubles as that signal
 *  (null once the file start has been reached). DisplayMessage.role is
 *  `'human' | 'assistant' | 'system'` and `.text` is `string | null`,
 *  matching what's used below. */
async function extractFinalClaim(filePath: string): Promise<string | null> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await readTranscript(filePath, { limit: 50, before: cursor });
    for (let i = result.messages.length - 1; i >= 0; i -= 1) {
      const msg = result.messages[i];
      if (msg.role === 'assistant' && msg.text) return msg.text;
    }
    if (result.nextBefore === null) break;
    cursor = result.nextBefore;
  }
  return null;
}

/**
 * DisplayMessage (electron/transcriptReader.ts) carries no `cwd` field --
 * that module deliberately does not widen TranscriptEvent's contract for a
 * single caller (see its own header comment). TranscriptEvent
 * (electron/transcriptParser.ts), however, does carry `cwd` per parsed line,
 * the same field buildProjectsSnapshot (src/shared/projectsSnapshot.ts)
 * already reads off live parsed events. Rather than widening readTranscript's
 * return shape for this one field, this reads the dispatch transcript file
 * directly and parses lines with parseTranscriptLine until one carries a
 * non-null cwd -- a small, narrowly-scoped read path, not a change to
 * transcriptReader.ts's contract.
 */
async function readDispatchCwd(filePath: string): Promise<string | null> {
  let content: string;
  try {
    content = await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  for (const line of content.split('\n')) {
    const event = parseTranscriptLine(line);
    if (event?.cwd) return event.cwd;
  }
  return null;
}

export async function resolveDispatchEvidence(
  toolUseId: string,
  db: DatabaseSync,
  sessionDir: string,
  pinnedSessionId: string,
  gitProbe: GitProbe
): Promise<EvidenceResult> {
  const sourceId = await findDispatchSourceId(sessionDir, pinnedSessionId, toolUseId);
  if (!sourceId) return { ok: false, missing: 'dispatch transcript not found' };

  const filePath = resolveSourcePath(sessionDir, sourceId);
  const claim = await extractFinalClaim(filePath);
  if (!claim) return { ok: false, missing: 'no final assistant message found for this dispatch' };

  // The dispatch's own transcript file, addressed dispatch:<parentId>:<agentBase>,
  // must resolve to the SAME relative path transcriptScan.ts recorded as
  // source_file_rel: path.join(<projectDirName>, parentId, 'subagents',
  // '<agentBase>.jsonl'), relative to projectsRoot -- built with node:path's
  // join (not manual '/' concatenation) so the separator matches exactly on
  // Windows, where transcriptScan.ts's own join produces backslashes.
  // sessionDir is projectsRoot/<projectDirName>, so its basename recovers
  // <projectDirName>.
  const idParts = sourceId.split(':');
  if (idParts.length !== 3) return { ok: false, missing: 'dispatch transcript not found' };
  const [, parentId, agentBase] = idParts;
  const sourceFileRel = path.join(path.basename(sessionDir), parentId, 'subagents', `${agentBase}.jsonl`);
  const touchedRows = db
    .prepare('SELECT DISTINCT file_path_rel FROM tool_calls WHERE source_file_rel = ? AND file_path_rel IS NOT NULL')
    .all(sourceFileRel) as { file_path_rel: string }[];
  const touchedFiles = touchedRows.map((r) => r.file_path_rel);
  if (touchedFiles.length === 0) return { ok: false, missing: 'no exact file-touch correlation available for this dispatch' };

  const cwd = await readDispatchCwd(filePath);
  if (!cwd) return { ok: false, missing: 'dispatch project root could not be resolved' };
  const ref = resolveProject(cwd, gitProbe);
  if (!ref) return { ok: false, missing: 'dispatch project root could not be resolved' };

  return { ok: true, evidence: { toolUseId, projectRoot: ref.repoPath, claim, touchedFiles } };
}
