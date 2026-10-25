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
  peer?: string; // device scope only: tailnet address the token is bound to
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

// ---- Phone control (mobile V1). Mirrors protocol/mobile-protocol.json; pinned by mobileProtocol.test.ts.
export const CONTROL_PORT = 47821;
export const CONTROL_PATH = '/ctl';
export const CONTROL_PAIR_PATH = '/api/device/pair';
export const CONTROL_CODE_LENGTH = 8;
export const CONTROL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CONTROL_CODE_TTL_MS = 5 * 60 * 1000;
export const CONTROL_MAX_CODE_FAILURES = 5;
export const CONTROL_PAIR_BODY_CAP = 1024;
export const CONTROL_PAIR_CONFIRM_TIMEOUT_MS = 60 * 1000;
export const CONTROL_SLIDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CONTROL_ABSOLUTE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const CONTROL_HELLO_TIMEOUT_MS = 5000;
export const CONTROL_MAX_SOCKETS = 2;
export const CONTROL_MAX_DEVICES = 1; // Matt, 2026-10-22: one paired app; replacing it is T2/T6 policy; not in the JSON
export const CONTROL_CTL_MAX_PAYLOAD = 64 * 1024;
export const CONTROL_RECHECK_MS = 10000;
export const CONTROL_PROOF_LABEL = 'server';
export const CONTROL_PROOF_SUFFIX = '/ctl';
export const CONTROL_MESSAGE_TYPES = {
  phoneToTitan: ['hello'],
  titanToPhone: ['welcome', 'bye'],
} as const;
export const CONTROL_BYE_REASONS = [
  'revoked',
  'disabled',
  'expired',
  'superseded',
  'policy',
  'slow-consumer',
  'rate-limit',
] as const;
export const CONTROL_PAIR_STATUS = { ok: 200, badCode: 401, declined: 403, burned: 429, busy: 409 } as const;

export interface ControlSocket {
  send(text: string): void; // no-op after close
  close(code: number): void;
  bufferedBytes(): number;
  onMessage(cb: (text: string) => void): void; // text frames only; the server closes 1003 on a binary frame
  onClose(cb: () => void): void;
}
export interface ControlIdentity {
  ref: string; // first 12 hex of the stored hash
  expiresAtMs: number;
  proofFor(nonce: string): string;
}
export type ControlPairResult =
  | { status: 200; token: string; expiresAtMs: number }
  | { status: 400 | 401 | 403 | 429 | 409 };
export type AuthRejectReason = 'no-device' | 'no-bearer' | 'unknown' | 'expired' | 'peer-mismatch' | 'error';
export interface ControlPort {
  maxSockets: number;
  authenticate(
    authorization: string | undefined,
    peer: string | undefined,
    o?: { touch?: boolean; onReject?: (reason: AuthRejectReason) => void },
  ): ControlIdentity | null;
  pair(code: unknown, peer: string | undefined): Promise<ControlPairResult>;
  open(socket: ControlSocket, identity: ControlIdentity): void;
}
export interface ListenerPort {
  acquire(): Promise<{ ok: true; address: string } | { ok: false; reason: RemoteUnavailableReason }>;
  release(): Promise<void>;
  address(): string | null; // "100.x.y.z:47821" while the shared listener is up
  closeControlClients(reason: 'revoked' | 'disabled'): void;
  recheckControl(): void;
  onControlClients(cb: (n: number) => void): void;
}
export interface ControlStatus {
  state: RemoteState;
  reason: RemoteUnavailableReason | null;
  address: string | null;
  connected: number;
  devices: RemoteSessionInfo[];
  pairingActive: boolean;
  reenableAtLaunch: boolean;
  notice: string | null;
}
export type ControlPairingResult =
  | { ok: true; uri: string; code: string; qrSvg: string; expiresAtMs: number }
  | { ok: false; reason: 'not-enabled' };
