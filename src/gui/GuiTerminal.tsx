import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { fonts } from '../styles/tokens';
import { useColors } from '../components/shared/useColors';
import '@xterm/xterm/css/xterm.css';

export interface GuiTerminalHandle {
  /** Current terminal size (the fitted size once the host has been shown). */
  size(): { cols: number; rows: number };
  /** Clear the screen (used before a restart). */
  reset(): void;
}

interface GuiTerminalProps {
  /** Called once per PTY data chunk (after it was written to the terminal). */
  onChunk: () => void;
  /** Called when the session process exits (after the banner was written). */
  onExit: () => void;
}

/**
 * Interactive xterm bound to the gui:* session. Interactive on purpose: Claude's folder-trust and
 * permission prompts are answered by typing here. It only subscribes; the parent calls gui.start
 * afterwards (child effects run before parent effects), so first output is not lost.
 */
export const GuiTerminal = forwardRef<GuiTerminalHandle, GuiTerminalProps>(function GuiTerminal({ onChunk, onExit }, ref) {
  const colors = useColors();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const cbs = useRef({ onChunk, onExit });
  cbs.current = { onChunk, onExit };
  const themeRef = useRef({ background: colors.bgTerminal, foreground: colors.textBody });
  themeRef.current = { background: colors.bgTerminal, foreground: colors.textBody };

  useImperativeHandle(
    ref,
    () => ({
      size: () => ({ cols: termRef.current?.cols ?? 80, rows: termRef.current?.rows ?? 24 }),
      reset: () => termRef.current?.reset(),
    }),
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    const gui = window.aetherElectron?.gui;
    if (!host || !gui) return;

    const term = new Terminal({ fontFamily: fonts.mono, fontSize: 13, theme: themeRef.current });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    // A display:none host measures 0x0 and must not be fitted (no gui.resize with 0).
    const fitIfShown = (): void => {
      if (host.offsetWidth === 0 || host.offsetHeight === 0) return;
      fit.fit();
    };
    fitIfShown();

    const offData = gui.onData((d) => {
      term.write(d);
      cbs.current.onChunk();
    });
    const offExit = gui.onExit(() => {
      term.write('\r\n[process exited]\r\n');
      cbs.current.onExit();
    });
    const typed = term.onData((input) => gui.write(input));
    const resized = term.onResize(({ cols, rows }) => gui.resize(cols, rows));
    const observer = new ResizeObserver(fitIfShown);
    observer.observe(host);

    return () => {
      observer.disconnect();
      typed.dispose();
      resized.dispose();
      offData();
      offExit();
      termRef.current = null;
      term.dispose();
    };
  }, []);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = { background: colors.bgTerminal, foreground: colors.textBody };
  }, [colors]);

  return <div ref={hostRef} data-testid="gui-terminal" style={{ width: '100%', height: '100%' }} />;
});
