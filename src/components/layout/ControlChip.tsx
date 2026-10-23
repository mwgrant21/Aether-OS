import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { fonts } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useControlStatus } from '../control/useControlStatus';

const hidden: CSSProperties = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };

/** Top-bar chip, visible only while at least one phone holds a control connection. No store or storage state. */
export function ControlChip() {
  const { dispatch } = useAetherStore();
  const colors = useColors();
  const status = useControlStatus();
  const count = status?.connected ?? 0;
  const connected = count > 0;
  const prev = useRef(false);
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    if (connected !== prev.current) {
      prev.current = connected;
      setAnnounce(connected ? 'Phone control connected' : 'Phone control disconnected');
    }
  }, [connected]);
  const live = <span aria-live="polite" style={hidden}>{announce}</span>;
  const label = count === 1 ? 'PHONE CONTROL - connected' : `PHONE CONTROL - ${count} connected`;
  const description = `Phone control connected (${count} connected). Open phone control settings.`;
  const style: CSSProperties & { WebkitAppRegion: 'no-drag' } = {
    WebkitAppRegion: 'no-drag', display: 'inline-flex', alignItems: 'center', gap: 6, flex: '0 0 auto',
    padding: '4px 9px', borderRadius: 8, border: `1px solid ${colors.danger}`, background: colors.panel,
    color: colors.danger, font: `700 11px/1.25 ${fonts.ui}`, letterSpacing: 0.3, cursor: 'pointer', position: 'relative',
  };
  return <>
    {connected && <button type="button" style={style} aria-label={description} title={`${description} Click to open Settings`}
      onClick={() => dispatch({ type: 'SET_ACTIVE_TAB', tab: 'Settings' })}>
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: colors.danger }} />
      {label}
    </button>}
    {live}
  </>;
}
