import { useState } from 'react';
import { useAetherStore } from '../../state/store';
import { communicationClientCopy } from '../../shared/communicationClientCopy';
import { projectCommunicationSnapshot } from '../../shared/communicationSnapshot';
import { fonts } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { focusClaudeTerminal } from './PtyTerminal';

export function CommunicationClientStatus({ inTerminal = false }: { inTerminal?: boolean }) {
  const { state, dispatch } = useAetherStore();
  const colors = useColors();
  const snapshot = state.communicationSnapshot;
  const copy = communicationClientCopy(snapshot);
  const [focusing, setFocusing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!copy || !snapshot) return null;
  const focus = async () => {
    if (focusing) return;
    setFocusing(true); setError(null);
    try {
      const api = window.aetherElectron?.communication;
      const current = api ? projectCommunicationSnapshot(await api.snapshot()) : null;
      if (!current?.enabled || current.sessionStatus.instanceLabel !== snapshot.sessionStatus.instanceLabel
        || current.sessionStatus.sessionLabel !== snapshot.sessionStatus.sessionLabel) {
        setError('The session changed. Check the current session status.'); return;
      }
      focusClaudeTerminal();
      dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Terminal' });
    } catch { setError('Could not check the session. Try focusing the terminal again.'); }
    finally { setFocusing(false); }
  };
  return <div data-testid="communication-client-status" style={{ position: 'relative', flexShrink: 0,
    height: inTerminal ? 108 : undefined, boxSizing: 'border-box', padding: '10px 16px',
    borderBottom: inTerminal ? `1px solid ${colors.chromeBorder}` : undefined,
    background: colors.panelInset, color: colors.textSecondary, font: `12px/1.4 ${fonts.ui}` }}>
    <div role="status" aria-live="polite"><strong>{copy.title}</strong><br />{copy.detail}</div>
    <Button onClick={focus} disabled={focusing} style={{ marginTop: 6, padding: '4px 8px',
      borderRadius: 5, border: `1px solid ${colors.panelBorder}`, color: colors.textSecondary }}>
      Focus connected terminal
    </Button>
    {error && <span role="alert" style={{ marginLeft: 8 }}>{error}</span>}
  </div>;
}
