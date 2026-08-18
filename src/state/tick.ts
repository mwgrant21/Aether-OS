import type { AetherState, AlarmLevel } from './types';
import { nowShort } from '../utils/format';

export function computeTick(state: AetherState): Partial<AetherState> {
  let effectiveRate = state.rate;
  if (state.cfg.autoThrottle) effectiveRate = Math.min(effectiveRate, state.cfg.alarm * 1000 * 0.8);

  const used = state.used + (effectiveRate / 60) * 0.9 * 0.05;

  const pressure = state.statusline
    ? Math.max(state.statusline.fiveHour?.usedPercentage ?? 0, state.statusline.sevenDay?.usedPercentage ?? 0)
    : 0;
  const level: AlarmLevel = pressure >= 90 ? 'crit' : pressure >= 75 ? 'warn' : 'ok';

  let notifs = state.notifs;
  let unread = state.unread;
  if (level !== state.alarmLevel && level !== 'ok') {
    notifs = [
      {
        t: nowShort(),
        m: level === 'crit' ? `RATE LIMIT ALARM — usage at ${Math.round(pressure)}%` : 'Rate limit elevated — approaching threshold',
        c: level === 'crit' ? '#ff6b7a' : '#f5c66b',
      },
      ...notifs,
    ].slice(0, 12);
    unread += 1;
  }

  return { used, alarmLevel: level, notifs, unread };
}
