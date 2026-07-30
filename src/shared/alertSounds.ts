import type { AlarmLevel } from '../state/types';

export type NotificationReason = 'agent_needs_input' | 'agent_completed' | 'permission_prompt' | string;

export type AlertAction =
  | { kind: 'playYellow' }
  | { kind: 'startRed' }
  | { kind: 'stopRed' }
  | { kind: 'playAnomalyChime' }
  | { kind: 'playNotification'; reason: NotificationReason };

export interface AlertSnapshot {
  alarmLevel: AlarmLevel;
  anomalyCount: number;
}

export function decideAlertActions(prev: AlertSnapshot, next: AlertSnapshot): AlertAction[] {
  const actions: AlertAction[] = [];

  if (next.alarmLevel !== prev.alarmLevel) {
    if (next.alarmLevel === 'crit') {
      actions.push({ kind: 'startRed' });
    } else if (next.alarmLevel === 'warn' && prev.alarmLevel === 'crit') {
      actions.push({ kind: 'stopRed' });
    } else if (next.alarmLevel === 'warn') {
      actions.push({ kind: 'playYellow' });
    } else if (next.alarmLevel === 'ok' && prev.alarmLevel === 'crit') {
      actions.push({ kind: 'stopRed' });
    }
    // warn -> ok is intentionally silent (matches tick.ts's existing
    // notification logic, which also only reacts to level !== 'ok').
  }

  if (prev.anomalyCount === 0 && next.anomalyCount > 0) {
    actions.push({ kind: 'playAnomalyChime' });
  }

  return actions;
}

let sharedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedCtx) {
    sharedCtx = new AudioContext();
  }
  if (sharedCtx.state === 'suspended') {
    void sharedCtx.resume();
  }
  return sharedCtx;
}

function playTone(ctx: AudioContext, frequencyHz: number, startTime: number, durationSec: number, peakGain: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(frequencyHz, startTime);

  // Short linear attack/release so the tone doesn't click at start/end.
  const attack = Math.min(0.02, durationSec / 4);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(peakGain, startTime + attack);
  gain.gain.linearRampToValueAtTime(0, startTime + durationSec);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + durationSec);
}

export function playYellowAlert(): void {
  const ctx = getAudioContext();
  const now = ctx.currentTime;
  const toneDur = 0.15;
  const gap = 0.02;
  const frequencies = [880, 1046.5, 880, 1046.5]; // A5, C6, A5, C6 — bright, brief, unmistakably an alert
  frequencies.forEach((freq, i) => {
    playTone(ctx, freq, now + i * (toneDur + gap), toneDur, 0.18);
  });
}

export function playAnomalyChime(): void {
  const ctx = getAudioContext();
  playTone(ctx, 1318.5, ctx.currentTime, 0.25, 0.09); // E6, quieter and longer-tailed than the klaxon tones — reads as a notification, not an alarm
}

// One short synthesized tone per typed Notification reason -- reuses the
// existing playTone oscillator primitive below, no new audio asset.
// Unrecognized reasons (a future Claude Code version adding a new
// notification_type) get a safe default tone rather than silently playing
// nothing or throwing.
export function toneForNotificationReason(reason: NotificationReason): { frequencyHz: number; durationSec: number } {
  switch (reason) {
    case 'agent_needs_input':
      return { frequencyHz: 660, durationSec: 0.18 };
    case 'agent_completed':
      return { frequencyHz: 440, durationSec: 0.12 };
    case 'permission_prompt':
      return { frequencyHz: 880, durationSec: 0.25 };
    default:
      return { frequencyHz: 550, durationSec: 0.15 };
  }
}

export function playNotificationTone(reason: NotificationReason): void {
  const ctx = getAudioContext();
  const { frequencyHz, durationSec } = toneForNotificationReason(reason);
  playTone(ctx, frequencyHz, ctx.currentTime, durationSec, 0.15);
}

export function startRedAlert(): () => void {
  const ctx = getAudioContext();
  const toneDur = 0.22;
  const lowFreq = 587.33; // D5
  const highFreq = 739.99; // F#5 — lower and more urgent than the yellow chirp's A5/C6 pair
  let stopped = false;
  let nextToneIsHigh = false;

  function scheduleNext() {
    if (stopped) return;
    const now = ctx.currentTime;
    playTone(ctx, nextToneIsHigh ? highFreq : lowFreq, now, toneDur, 0.22);
    nextToneIsHigh = !nextToneIsHigh;
    setTimeout(scheduleNext, toneDur * 1000);
  }

  scheduleNext();

  return () => {
    stopped = true;
  };
}
