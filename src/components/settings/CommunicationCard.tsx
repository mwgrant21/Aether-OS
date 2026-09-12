import { useAetherStore } from '../../state/store';
import { fonts } from '../../styles/tokens';
import { useColors } from '../shared/useColors';

const messages: Record<string, string> = {
  SHUTTING_DOWN: 'Cleanup is still running. Wait for it to finish before enabling communication again.',
  DISPOSED: 'Communication has shut down for this app session.',
  CLEANUP_FAILED: 'Communication cleanup failed. New work is blocked.',
  SHUTDOWN_TIMEOUT: 'Cleanup is taking longer than expected. New work remains blocked while cleanup continues.',
};
export function CommunicationCard() {
  const { state, dispatch } = useAetherStore();
  const colors = useColors();
  const snapshot = state.communicationSnapshot;
  return <section aria-label="Agent communication" style={{ padding: 15, borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient,
    color: colors.textSecondary, font: `12px/1.5 ${fonts.ui}`, flexShrink: 0 }}>
    <h3 style={{ margin: '0 0 12px', fontSize: 12, letterSpacing: 2 }}>AGENT COMMUNICATION</h3>
    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input type="checkbox" checked={state.communicationCfg.enabled}
        onChange={event => dispatch({ type: 'SET_COMMUNICATION_CFG', enabled: event.target.checked })} />
      Enable Claude–Codex communication
    </label>
    <p>Enabling saves your preference. It does not launch a session, send a request, or spend allowance. A fresh connected Claude session is required; it starts with three consultation credits.</p>
    <p role="status">Bridge: {snapshot ? snapshot.readiness : 'status unavailable'}.
      {snapshot && ` Cleanup: ${snapshot.cleanup}.`}</p>
    {state.communicationError && <p role="alert">{messages[state.communicationError] ?? state.communicationError}</p>}
  </section>;
}
