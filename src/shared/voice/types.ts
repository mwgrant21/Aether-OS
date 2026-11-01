import type { RemoteSessionInfo } from '../remote/types';

export const VOICE_PORT = 47822;
export const VOICE_MAX_SESSIONS = 2;
export const VOICE_SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const VOICE_REPLAY_BYTES = 64 * 1024;
export const VOICE_MAX_PAYLOAD = 16 * 1024;
export const VOICE_TURN_TEXT_CAP = 4000;
export const VOICE_SPOKEN_CAP = 600;
export const VOICE_DISPLAY_CAP = 4000;
export const VOICE_ORPHAN_TURN_MS = 60_000;
export const VOICE_PERMISSION_TIMEOUT_MS = 60_000;

export type VoiceState = 'off' | 'on' | 'unavailable';
export type VoiceUnavailableReason = 'no-tailnet-address' | 'port-in-use' | 'error';
export type VoiceSessionState = 'none' | 'starting' | 'ready' | 'restarting' | 'down';

export interface VoiceStatus {
  state: VoiceState;
  reason: VoiceUnavailableReason | null;
  address: string | null;
  connected: boolean;
  session: VoiceSessionState;
  sessions: RemoteSessionInfo[];
  pairingActive: boolean;
  notice: string | null;
}

export type VoicePairingResult =
  | { ok: true; code: string; address: string; qrSvg: string; expiresAtMs: number }
  | { ok: false; reason: 'not-enabled' };
