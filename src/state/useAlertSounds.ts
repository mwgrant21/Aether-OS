import { useEffect, useRef } from 'react';
import { useAetherStore } from './store';
import { decideAlertActions, playAnomalyChime, playYellowAlert, startRedAlert } from '../shared/alertSounds';

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
}
