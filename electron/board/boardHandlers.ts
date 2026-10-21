// Pull-only board handlers. No state is kept between calls: every call re-reads
// from disk and returns, so transcript text is never retained in main
// (docs/privacy-and-data.md "Rendering is not storing"). Imports nothing from
// `electron` so main.ts only supplies the deps.
import { isSafeSegment } from '../transcriptReader';
import { buildBoardFeed, listBoardSessions, type BoardFeedDeps } from './boardFeed';
import type { BoardFeedResult, BoardSessionSummary } from '../../src/shared/board/types';

export interface BoardHandlerDeps {
  projectsRoot: string;
  projectOf: BoardFeedDeps['projectOf'];
  beforeList?: () => void;
}

export function createBoardHandlers(deps: BoardHandlerDeps): {
  sessions(): Promise<BoardSessionSummary[]>;
  feed(ref: unknown): Promise<BoardFeedResult>;
} {
  const feedDeps: BoardFeedDeps = { projectOf: deps.projectOf };
  return {
    async sessions() {
      try {
        deps.beforeList?.();
        return await listBoardSessions(deps.projectsRoot, feedDeps);
      } catch {
        return [];
      }
    },
    async feed(ref: unknown) {
      const r = ref as { projectDir?: unknown; sessionId?: unknown } | null;
      if (
        !r ||
        typeof r !== 'object' ||
        typeof r.projectDir !== 'string' ||
        typeof r.sessionId !== 'string' ||
        !isSafeSegment(r.projectDir) ||
        !isSafeSegment(r.sessionId)
      ) {
        return { ok: false, error: 'Invalid session.' };
      }
      try {
        return await buildBoardFeed(deps.projectsRoot, { projectDir: r.projectDir, sessionId: r.sessionId }, feedDeps);
      } catch {
        return { ok: false, error: 'Could not read this session.' };
      }
    },
  };
}
