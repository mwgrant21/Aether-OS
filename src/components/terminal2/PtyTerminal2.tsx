import { useEffect, useRef, type CSSProperties } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
// Used only by module-level code (getOrCreateHost/fallbackStyle) that runs
// outside React and can't call useColors() -- always the dark palette.
import { colors as darkColors, fonts } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import '@xterm/xterm/css/xterm.css';

// Module-level, independent from both PtyTerminal.tsx's and
// PtyCodexTerminal.tsx's singletons -- the second claude session survives
// PtyTerminal2 being unmounted/remounted on every tab switch, same reasoning
// as PtyTerminal.tsx's identical pattern.
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
      theme: { background: darkColors.bgTerminal, foreground: darkColors.textBody },
    });
    sharedFit = new FitAddon();
    sharedTerm.loadAddon(sharedFit);
    sharedTerm.open(sharedHostEl);

    const terminal2Pty = window.aetherElectron!.terminal2Pty;
    // Subscribe before starting so the session's first output is not lost.
    terminal2Pty.onData((data) => sharedTerm!.write(data));
    sharedTerm.onData((input) => terminal2Pty.write(input));
    sharedTerm.onResize(({ cols, rows }) => terminal2Pty.resize(cols, rows));
    terminal2Pty.start({ cols: sharedTerm.cols, rows: sharedTerm.rows }); // only ever called once per app lifetime
  }
  return { hostEl: sharedHostEl, fit: sharedFit! };
}

export function PtyTerminal2() {
  const colors = useColors();
  const anchorRef = useRef<HTMLDivElement>(null);
  const hasElectronPty = typeof window !== 'undefined' && !!window.aetherElectron?.terminal2Pty;

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
      // Detach, do not destroy -- see PtyTerminal.tsx.
      hostEl.remove();
    };
  }, [hasElectronPty]);

  useEffect(() => {
    if (!sharedTerm) return;
    sharedTerm.options.theme = { background: colors.bgTerminal, foreground: colors.textBody };
  }, [colors]);

  if (!hasElectronPty) {
    return <div style={fallbackStyle}>Terminal 2 requires the Electron app — run `npm run electron:dev`</div>;
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
  color: darkColors.textDim,
  textAlign: 'center',
  padding: 20,
};
