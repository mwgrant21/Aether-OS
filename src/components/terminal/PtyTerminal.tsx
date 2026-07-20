import { useEffect, useRef, type CSSProperties } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { colors, fonts } from '../../styles/tokens';
import '@xterm/xterm/css/xterm.css';

// Module-level (not component state) so the real claude session survives
// PtyTerminal being unmounted/remounted every time the user switches away
// from the Terminal tab and back -- viewRegistry.ts fully unmounts view
// components on tab change, unlike TokenMonitor's terminal, which is never
// conditionally unmounted. A detached DOM node stays fully alive in memory
// as long as this module-level variable still references it; re-parenting
// it (appendChild into wherever PtyTerminal currently renders) does not
// recreate it.
let sharedHostEl: HTMLDivElement | null = null;
let sharedTerm: Terminal | null = null;
let sharedFit: FitAddon | null = null;

function getOrCreateHost(): { hostEl: HTMLDivElement; fit: FitAddon } {
  if (!sharedHostEl) {
    sharedHostEl = document.createElement('div');
    sharedHostEl.style.width = '100%';
    sharedHostEl.style.height = '100%';

    sharedTerm = new Terminal({
      fontFamily: fonts.mono,
      fontSize: 13,
      theme: { background: '#06141c', foreground: colors.textBody },
    });
    sharedFit = new FitAddon();
    sharedTerm.loadAddon(sharedFit);
    sharedTerm.open(sharedHostEl);

    // window.aetherElectron.pty is guaranteed present here -- the caller
    // (PtyTerminal's effect) only calls getOrCreateHost() after its own
    // guard confirms it exists.
    const pty = window.aetherElectron!.pty;
    pty.start({ cols: sharedTerm.cols, rows: sharedTerm.rows }); // only ever called once per app lifetime
    pty.onData((data) => sharedTerm!.write(data));
    sharedTerm.onData((input) => pty.write(input));
    sharedTerm.onResize(({ cols, rows }) => pty.resize(cols, rows));
  }
  return { hostEl: sharedHostEl, fit: sharedFit! };
}

export function PtyTerminal() {
  const anchorRef = useRef<HTMLDivElement>(null);
  const hasElectronPty = typeof window !== 'undefined' && !!window.aetherElectron?.pty;

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || !hasElectronPty) return;

    const { hostEl, fit } = getOrCreateHost();
    anchor.appendChild(hostEl);
    fit.fit();

    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(anchor);

    return () => {
      resizeObserver.disconnect();
      // Detach, do not destroy -- the module-level singleton keeps hostEl
      // (and the live xterm/pty session it contains) alive until the
      // Terminal tab is revisited, which re-attaches it via getOrCreateHost().
      hostEl.remove();
    };
  }, [hasElectronPty]);

  if (!hasElectronPty) {
    return <div style={fallbackStyle}>Real terminal requires the Electron app — run `npm run electron:dev`</div>;
  }

  return <div ref={anchorRef} style={hostStyle} />;
}

const hostStyle: CSSProperties = { width: '100%', height: '100%' };
const fallbackStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  font: `400 13px/1.5 ${fonts.mono}`,
  color: colors.textDim,
  textAlign: 'center',
  padding: 20,
};
