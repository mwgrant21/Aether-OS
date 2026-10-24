import type { HandbackStatus } from '../../src/shared/board/types';
export type ChatEvent =
  | { k: 'msg'; id: string; atMs: number; role: 'you' | 'claude'; text: string; truncated: boolean; tools: string[] } // tools = names only
  | {
      k: 'traffic';
      id: string;
      atMs: number;
      kind: 'dispatch' | 'message' | 'handback';
      from: string;
      to: string;
      subject: string | null;
      text: string;
      truncated: boolean;
      status: HandbackStatus | null;
    };
// id = `${byteOffsetOfLine}:${n}`, unique within one session file.
export type ServerMessage = // server -> phone JSON text frames; there is NO phone -> server type
  | { t: 'session'; attached: boolean; title: string | null } // header only; never clears the list
  | { t: 'history'; events: ChatEvent[] } // REPLACES the phone's list
  | { t: 'event'; event: ChatEvent }
  | { t: 'bye'; reason: 'revoked' | 'disabled' | 'slow-consumer' | 'policy' };
export interface ChatFeed {
  /** SYNCHRONOUS. Delivers {session} then {history} to `listener` before returning; later events follow in order, none lost or duplicated. */
  join(listener: (m: ServerMessage) => void): { leave(): void };
}
export interface StoredSession {
  hash: string;
  createdAtMs: number;
  expiresAtMs: number;
  lastSeenMs: number;
  peer?: string; // device scope only: tailnet address the token is bound to
}
export interface SessionStorePort {
  load(): StoredSession[];
  save(list: StoredSession[]): Promise<void>;
}
export interface RemoteAuthGate {
  isAuthenticated(cookieHeader: string | undefined, opts?: { touch?: boolean }): boolean;
  redeem(code: unknown): { ok: true; cookie: string } | { ok: false; status: 401 | 429 };
}
export interface RemoteAssets {
  pairHtml: string;
  pairJs: string;
  viewerHtml: string;
  viewerJs: string;
  appCss: string;
}
