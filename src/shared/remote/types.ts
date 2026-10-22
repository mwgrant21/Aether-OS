// Renderer-safe contract for mobile remote access (no node imports).
export const REMOTE_PORT = 47821;
export const REMOTE_BODY_CAP = 4000; // chars per bubble body after masking
export const REMOTE_LABEL_CAP = 60;
export const REMOTE_REPLAY_BYTES = 64 * 1024; // Matt answer 7
export const REMOTE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // Open Call 1
export const REMOTE_MAX_SESSIONS = 5;
export const REMOTE_MAX_CLIENTS = 3;
export type RemoteState = 'off' | 'on' | 'unavailable';
export type RemoteUnavailableReason = 'no-tailnet-address' | 'port-in-use' | 'error';
export interface RemoteSessionInfo {
  ref: string; // first 12 hex chars of the stored hash; display + revoke-one key only
  createdAtMs: number;
  expiresAtMs: number;
  lastSeenMs: number;
}
export interface RemoteStatus {
  state: RemoteState;
  reason: RemoteUnavailableReason | null; // only when state === 'unavailable'
  address: string | null; // "100.x.y.z:47821" while on
  clients: number; // live WebSocket count (drives the top-bar chip)
  sessions: RemoteSessionInfo[]; // paired, unexpired; present even when state is 'off'
  pairingActive: boolean; // an unexpired unused code exists (the code is NOT here)
  following: boolean; // a pinned Claude session transcript is being followed
  notice: string | null; // fixed text, e.g. "Revoke not saved to disk yet"; null when nothing to report
}
export type PairingResult =
  | { ok: true; url: string; code: string; qrSvg: string; expiresAtMs: number }
  | { ok: false; reason: 'not-enabled' };
