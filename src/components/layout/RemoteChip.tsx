import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { fonts } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useRemoteStatus } from '../remote/useRemoteStatus';

const hidden: CSSProperties = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };

/** Top-bar chip, visible only while at least one phone is connected. No store or storage state. */
export function RemoteChip() {
  const { dispatch } = useAetherStore();
  const colors = useColors();
  const status = useRemoteStatus();
  const clients = status?.clients ?? 0;
  const connected = clients > 0;
  const prev = useRef(false);
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    if (connected !== prev.current) {
      prev.current = connected;
      setAnnounce(connected ? 'Phone connected' : 'Phone disconnected');
    }
  }, [connected]);
  const live = <span aria-live="polite" role="status" style={hidden}>{announce}</span>;
  if (!connected) return live;
  const label = clients === 1 ? 'PHONE CONNECTED' : `PHONE - ${clients} connected`;
  const description = `Phone connected, read-only chat view (${clients} connected). Open remote access settings.`;
  const style: CSSProperties & { WebkitAppRegion: 'no-drag' } = {
    WebkitAppRegion: 'no-drag', display: 'inline-flex', alignItems: 'center', gap: 6, flex: '0 0 auto',
    padding: '4px 9px', borderRadius: 8, border: `1px solid ${colors.warn}`, background: colors.panelInset,
    color: colors.warn, font: `600 11px/1.25 ${fonts.ui}`, letterSpacing: 0.3, cursor: 'pointer', position: 'relative',
  };
  return <>
    <button type="button" style={style} aria-label={description} title={`${description} Click to open Settings`}
      onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Settings' })}>
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: colors.warn }} />
      {label}
    </button>
    {live}
  </>;
}
