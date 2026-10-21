// Shared contract for the Traffic (agent message board) feature. Types and two
// constants only: no logic, no node imports. Board text is render-only: it
// lives in a mounted view's own state, never in AetherState or persistence.

export const BODY_CAP = 8000;
export const MAX_POSTS = 1000;

export type PartyKind = 'main' | 'agent' | 'peer' | 'all' | 'unknown';
export interface BoardParty {
  kind: PartyKind;
  name: string;
  agentId: string | null;
}

export type PostKind = 'dispatch' | 'message' | 'handback';
export type HandbackStatus = 'completed' | 'failed' | 'killed' | 'unknown';

export interface BoardPost {
  id: string; // `${fileKey}:${lineIndex}:${n}`, unique within a feed
  atMs: number;
  kind: PostKind;
  from: BoardParty;
  to: BoardParty;
  startedBy: string | null;
  subject: string | null; // dispatch description / SendMessage summary / notification summary
  body: string; // masked, capped at BODY_CAP
  bodyLength: number; // length after masking, before the cap
  truncated: boolean;
  status: HandbackStatus | null; // set only for kind 'handback' from a task-notification
}

export interface BoardProject {
  key: string;
  name: string;
  worktree: string | null;
}
export interface BoardSessionRef {
  projectDir: string;
  sessionId: string;
}
export interface BoardSessionSummary extends BoardSessionRef {
  project: BoardProject | null;
  lastActiveMs: number;
  sizeBytes: number;
  subagentCount: number;
}
export interface BoardFeed {
  ref: BoardSessionRef;
  project: BoardProject | null;
  posts: BoardPost[];
  capped: boolean;
  unreadableFiles: number;
}
export type BoardFeedResult = { ok: true; feed: BoardFeed } | { ok: false; error: string };
