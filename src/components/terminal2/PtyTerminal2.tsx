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

    // Clipboard failures (no API, rejected promise) are ignored on purpose.
    const pasteFromClipboard = () => {
      void navigator.clipboard?.readText?.().then((text) => { if (text) sharedTerm!.paste(text); }).catch(() => {});
    };
    // xterm turns Ctrl+V into 0x16 and the app menu is null, so there is no native paste: consume the key here.
    sharedTerm.attachCustomKeyEventHandler((ev) => {
      const isPaste = ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key.toLowerCase() === 'v';
      if (!isPaste) return true;
      if (ev.type === 'keydown') {
        ev.preventDefault(); // stop any native paste so text is not pasted twice
        pasteFromClipboard();
      }
      return false; // xterm must not send 0x16 (also covers keypress/keyup)
    });
    // Copy on mouse release (not per drag tick); document so a release outside the host still copies.
    const copySelection = () => {
      if (sharedTerm!.hasSelection()) void navigator.clipboard?.writeText?.(sharedTerm!.getSelection())?.catch(() => {});
    };
    sharedHostEl.addEventListener('mousedown', () => document.addEventListener('mouseup', copySelection, { once: true }));
    // Right-click pastes unless the running program tracks the mouse (then xterm/the program gets the event).
    sharedHostEl.addEventListener('contextmenu', (ev) => {
      if (sharedTerm!.modes.mouseTrackingMode !== 'none') return;
      ev.preventDefault();
      pasteFromClipboard();
    });

    const terminal2Pty = window.aetherElectron!.terminal2Pty;
    // Subscribe before starting so the session's first output is not lost.
    terminal2Pty.onData((data) => sharedTerm!.write(data));
    // Once the shell exits, input is dead until Enter restarts the session.
    let exited = false;
    terminal2Pty.onExit(() => {
      exited = true;
      sharedTerm!.write('\r\n[process exited - press Enter to restart]\r\n');
    });
    sharedTerm.onData((input) => {
      if (!exited) { terminal2Pty.write(input); return; }
      if (input !== '\r') return;
      exited = false;
      sharedTerm!.reset();
      terminal2Pty.start({ cols: sharedTerm!.cols, rows: sharedTerm!.rows });
    });
    sharedTerm.onResize(({ cols, rows }) => terminal2Pty.resize(cols, rows));
    terminal2Pty.start({ cols: sharedTerm.cols, rows: sharedTerm.rows }); // first start; after an exit, Enter restarts via onData above
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
