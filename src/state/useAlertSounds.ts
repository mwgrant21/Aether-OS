import { useEffect, useRef } from 'react';
import { useAetherStore } from './store';
import { decideAlertActions, playAnomalyChime, playNotificationTone, playYellowAlert, startRedAlert } from '../shared/alertSounds';

export function useAlertSounds(): void {
  const { state } = useAetherStore();
  const prevRef = useRef({ alarmLevel: state.alarmLevel, anomalyCount: state.anomalies.length });
  const stopRedRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const next = { alarmLevel: state.alarmLevel, anomalyCount: state.anomalies.length };

    if (state.cfg.sound) {
      for (const action of decideAlertActions(prevRef.current, next)) {
        if (action.kind === 'playYellow') playYellowAlert();
        else if (action.kind === 'playAnomalyChime') playAnomalyChime();
        else if (action.kind === 'startRed') stopRedRef.current = startRedAlert();
        else if (action.kind === 'stopRed') {
          stopRedRef.current?.();
          stopRedRef.current = null;
        }
      }

      // Backstop: if we're still (or again) in crit and sound is on, but no
      // red-alert loop is running, start one. Covers sound being re-enabled
      // while alarmLevel never left 'crit' (decideAlertActions sees no
      // transition, so it emits no `startRed`). If `decideAlertActions`
      // already started one above, `stopRedRef.current` is non-null here, so
      // this never double-starts an overlapping loop.
      if (next.alarmLevel === 'crit' && !stopRedRef.current) {
        stopRedRef.current = startRedAlert();
      }
    }

    prevRef.current = next;
  }, [state.alarmLevel, state.anomalies.length, state.cfg.sound]);

  // If sound is toggled OFF mid-red-alert, stop the loop immediately rather
  // than waiting for the next alarmLevel transition to fire `stopRed`.
  useEffect(() => {
    if (!state.cfg.sound) {
      stopRedRef.current?.();
      stopRedRef.current = null;
    }
  }, [state.cfg.sound]);

  useEffect(() => {
    if (state.cfg.sound && state.lastNotification) {
      playNotificationTone(state.lastNotification.reason);
    }
    // Deliberately keyed on atMs, not the whole object reference, so two
    // notifications with the same reason in quick succession (e.g. two
    // permission_prompts) both trigger a fresh play instead of the second
    // being skipped by a same-value effect-dependency comparison.
  }, [state.lastNotification?.atMs, state.cfg.sound]);
}
