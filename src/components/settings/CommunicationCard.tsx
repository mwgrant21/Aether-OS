import { useAetherStore } from '../../state/store';
import { fonts } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useRef, useState } from 'react';
import { Button } from '../shared/Button';
import { prepareClaudeTerminal } from '../terminal/PtyTerminal';

const messages: Record<string, string> = {
  LAUNCH_CONFIG_CLEANUP_FAILED: 'Partially prepared launch files could not be removed. Communication remains blocked because cleanup failed.',
  SHUTTING_DOWN: 'Cleanup is still running. Wait for it to finish before enabling communication again.',
  DISPOSED: 'Communication has shut down for this app session.',
  CLEANUP_FAILED: 'Communication cleanup failed. New work is blocked.',
  SHUTDOWN_TIMEOUT: 'Cleanup is taking longer than expected. New work remains blocked while cleanup continues.',
  CANCELLED: 'Session launch cancelled.',
  DISABLED: 'Enable communication before starting a connected session.',
  BUSY: 'Another communication operation is in progress.',
  CLAUDE_VERSION_REPROBE_REQUIRED: 'The installed Claude version needs a new communication compatibility check before launch.',
  SERVER_NAME_COLLISION: 'An existing aether-bridge server definition conflicts with this launch. Resolve the duplicate configuration first.',
  MANAGED_POLICY_REQUIRES_REVIEW: 'Managed Claude policy needs review before this connected session can start.',
  MANAGED_MCP_EXCLUSIVE: 'Managed MCP configuration prevents adding this bridge. Your managed policy remains unchanged.',
  BRIDGE_PERMISSION_DENIED: 'A Claude permission rule denies a bridge tool. This launch will not override that rule.',
  CUSTOM_CONFIG_UNSUPPORTED: 'A custom Claude configuration directory is not supported for this connected launch.',
  BRIDGE_LAUNCH_PLATFORM_UNSUPPORTED: 'Connected Claude launch is currently supported on Windows only.',
  LAUNCH_CONFIG_FAILED: 'The private connected-session configuration could not be prepared.',
  LAUNCH_STATUS_UNREADABLE: 'Aether could not read the connected Claude session status.',
  STALE_LAUNCH_CLEANUP_FAILED: 'Previous launch files could not be cleaned up. Resolve that cleanup failure before starting another session.',
  LAUNCH_RUNTIME_MISSING: 'The installed communication helper or runtime is missing.',
  NATIVE_CLAUDE_REQUIRED: 'This connected launch requires the native Claude executable.',
  CONFIG_UNREADABLE: 'Claude configuration could not be read or validated. Resolve it before starting a connected session.',
  REVOKED: 'Communication was disabled or replaced before the session could start.',
  LAUNCH_FAILED: 'The connected Claude session could not start.',
  GRANT_NOT_APPLIED: 'The consultation grant was not applied. The session may have changed or reached its credit limit.',
  NOT_CONNECTED: 'Wait for a connected Claude session before granting more consultations.',
};
export function CommunicationCard() {
  const { state, dispatch } = useAetherStore();
  const colors = useColors();
  const snapshot = state.communicationSnapshot;
  const [starting, setStarting] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const startingRef = useRef(false);
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const grantingRef = useRef(false);
  const canStart = state.communicationCfg.enabled && snapshot?.enabled && snapshot.cleanup === 'confirmed';
  const canGrant = canStart && snapshot?.readiness === 'ready';
  const grant = async () => {
    if (!canGrant || grantingRef.current) return;
    const api = window.aetherElectron?.communication;
    if (!api) return;
    grantingRef.current = true; setGranting(true); setGrantError(null);
    try {
      const result = await api.grantMore(crypto.randomUUID());
      if (!result.ok) setGrantError(result.code === 'CANCELLED' ? 'Consultation grant cancelled.'
        : messages[result.code ?? 'GRANT_NOT_APPLIED'] ?? messages.GRANT_NOT_APPLIED);
    } catch { setGrantError(messages.GRANT_NOT_APPLIED); }
    finally { grantingRef.current = false; setGranting(false); }
  };
  const start = async () => {
    if (!canStart || startingRef.current) return;
    const api = window.aetherElectron?.communication;
    if (!api) return;
    startingRef.current = true; setStarting(true); setLaunchError(null);
    try {
      prepareClaudeTerminal();
      const result = await api.startSession();
      if (!result.ok) setLaunchError(messages[result.code ?? 'LAUNCH_FAILED'] ?? 'The connected Claude session could not start. Check the desktop launch prompt.');
      // A successful launch is not proof of tool discovery. Only main's
      // authenticated snapshot can establish readiness.
    } catch { setLaunchError(messages.LAUNCH_FAILED); }
    finally { startingRef.current = false; setStarting(false); }
  };
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
    {state.communicationCfg.enabled && snapshot && !snapshot.enabled && <p>
      Preference saved. {snapshot.cleanup === 'pending' ? 'Bridge stopped while cleanup finishes.'
        : snapshot.cleanup === 'failed' ? 'Bridge stopped because cleanup failed.' : 'Bridge stopped for this app session.'}
      {' '}The saved preference does not mean a session is connected.
    </p>}
    <details>
      <summary>Connected-session permissions and data</summary>
      <p>Consultations use your Claude and Codex subscriptions. Starting a session does not send a model request. Each fresh session starts with three consultation credits.</p>
      <p>This session preapproves exactly these three MCP tools; other Claude tools retain their normal permissions:</p>
      <ul>
        <li><code>mcp__aether-bridge__ask_codex</code></li>
        <li><code>mcp__aether-bridge__get_codex_exchange</code></li>
        <li><code>mcp__aether-bridge__cancel_codex_exchange</code></li>
      </ul>
      <p>Codex runs read-only in an empty working directory, but can read outside that directory. Returned advice is untrusted and may influence what Claude does next.</p>
      <p>Claude transcripts, tool output, and Codex history may persist after the bridge clears its memory.</p>
      <p>The connected Claude session forces the MCP background threshold to 120000 ms after shell profiles run. This applies client-wide, overriding customized thresholds for other MCP servers in this session.</p>
    </details>
    <Button onClick={start} disabled={!canStart || starting} style={{ padding: '8px 12px', marginTop: 10,
      color: colors.textSecondary, border: `1px solid ${colors.panelBorder}`, borderRadius: 7,
      opacity: !canStart || starting ? 0.55 : 1, cursor: !canStart || starting ? 'default' : 'pointer' }}>
      {starting ? 'Starting connected Claude…' : 'Start fresh connected Claude'}
    </Button>
    {launchError && <p role="alert">{launchError}</p>}
    <p>Consultation credits remaining: {typeof snapshot?.remainingCredits === 'number' ? snapshot.remainingCredits : 'unavailable'}.</p>
    <Button onClick={grant} disabled={!canGrant || granting || starting} style={{ padding: '8px 12px',
      color: colors.textSecondary, border: `1px solid ${colors.panelBorder}`, borderRadius: 7,
      opacity: !canGrant || granting || starting ? 0.55 : 1 }}>
      {granting ? 'Confirming consultation grant…' : 'Grant 3 more consultations'}
    </Button>
    {grantError && <p role="alert">{grantError}</p>}
    {snapshot && <p data-testid="communication-session-identity">
      Aether instance: {snapshot.sessionStatus.instanceLabel}.<br />
      Bridge launch: {snapshot.sessionStatus.sessionLabel ?? 'No active launch'}.
    </p>}
    <p>Bridge connection does not establish whether Claude is ready for input.</p>
    <p role="status">Bridge: {snapshot ? snapshot.readiness : 'status unavailable'}.
      {snapshot && ` Cleanup: ${snapshot.cleanup}.`}</p>
    {state.communicationError && <p role="alert">{messages[state.communicationError] ?? state.communicationError}</p>}
  </section>;
}
