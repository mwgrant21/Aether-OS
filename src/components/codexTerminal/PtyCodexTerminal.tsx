import { useEffect, useRef, type CSSProperties } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
// Used only by module-level code (getOrCreateHost/fallbackStyle) that runs
// outside React and can't call useColors() -- always the dark palette.
import { colors as darkColors, fonts } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { useAetherStore } from '../../state/store';
import { attachTerminalMarkers, type TerminalMarkers } from '../terminal/terminalMarkerDecorations';
import '@xterm/xterm/css/xterm.css';

// Module-level, independent from Claude terminal's own singleton in
// PtyTerminal.tsx -- the real codex session survives PtyCodexTerminal being
// unmounted/remounted every time the operator switches away from the Codex
// tab and back, same reasoning as PtyTerminal.tsx's identical pattern.
let sharedHostEl: HTMLDivElement | null = null;
let sharedTerm: Terminal | null = null;
let sharedFit: FitAddon | null = null;
// Starts disabled; the component effect follows cfg.terminalMarkerColors.
let sharedMarkers: TerminalMarkers | null = null;

function getOrCreateHost(): { hostEl: HTMLDivElement; fit: FitAddon } {
  if (!sharedHostEl) {
    sharedHostEl = document.createElement('div');
    sharedHostEl.style.width = '100%';
    sharedHostEl.style.height = '100%';

    sharedTerm = new Terminal({
      allowProposedApi: true, // registerDecoration (terminal marker colors) is proposed API
      fontFamily: fonts.mono,
      fontSize: 13,
      theme: { background: darkColors.bgTerminal, foreground: darkColors.textBody },
    });
    sharedFit = new FitAddon();
    sharedTerm.loadAddon(sharedFit);
    sharedTerm.open(sharedHostEl);
    sharedMarkers = attachTerminalMarkers(sharedTerm);

    const codexPty = window.aetherElectron!.codexPty;
    // Main's screen mirror, sent when this window re-attaches to a running session (reload). Subscribed before
    // start; optional call because older preloads do not provide it.
    codexPty.onSnap?.(({ cols, rows, d }) => {
      if (d === '') return;
      sharedTerm!.reset();
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) sharedTerm!.resize(cols, rows);
      // Refit only after the snap is parsed at the mirror's size; a reloaded xterm fires no onResize for an
      // unchanged size, so tell main the real size explicitly to make the TUI repaint.
      sharedTerm!.write(d, () => {
        sharedFit!.fit();
        if (sharedTerm!.cols !== cols || sharedTerm!.rows !== rows) codexPty.resize(sharedTerm!.cols, sharedTerm!.rows);
      });
    });
    codexPty.start({ cols: sharedTerm.cols, rows: sharedTerm.rows }); // only ever called once per app lifetime
    codexPty.onData((data) => sharedTerm!.write(data));
    sharedTerm.onData((input) => codexPty.write(input));
    sharedTerm.onResize(({ cols, rows }) => codexPty.resize(cols, rows));
  }
  return { hostEl: sharedHostEl, fit: sharedFit! };
}

export function PtyCodexTerminal() {
  const colors = useColors();
  const markersOn = useAetherStore().state.cfg.terminalMarkerColors;
  const anchorRef = useRef<HTMLDivElement>(null);
  const hasElectronCodexPty = typeof window !== 'undefined' && !!window.aetherElectron?.codexPty;

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || !hasElectronCodexPty) return;

    const { hostEl, fit } = getOrCreateHost();
    anchor.appendChild(hostEl);
    fit.fit();

    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(anchor);

    return () => {
      resizeObserver.disconnect();
      hostEl.remove();
    };
  }, [hasElectronCodexPty]);

  useEffect(() => {
    if (!sharedTerm) return;
    sharedTerm.options.theme = { background: colors.bgTerminal, foreground: colors.textBody };
  }, [colors]);

  useEffect(() => {
    sharedMarkers?.setEnabled(markersOn);
  }, [markersOn]);

  if (!hasElectronCodexPty) {
    return <div style={fallbackStyle}>Codex terminal requires the Electron app — run `npm run electron:dev`</div>;
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
