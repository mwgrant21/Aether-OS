import { useEffect, useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { useAetherStore } from '../../state/store';

export const MEMORY_EXTRACTION_DISCLOSURE =
  'Sends the result text of each completed subagent dispatch that clears the extraction bar to your Claude account via the claude CLI (claude -p --model haiku), from the background collector, usually within about 30 seconds of the dispatch completing. Each call also sends up to 20 memories previously extracted for that agent. ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL are removed from its environment; otherwise it uses whatever Claude Code is set up to use (your login, or an apiKeyHelper, settings key or Bedrock/Vertex if you configured one). Claude Code also adds its own context to each call (for example your CLAUDE.md files) and runs your configured hooks. Extracted memories are stored locally in ~/.aether-os/memory.db. Applies only to dispatches the collector picks up after you enable it. Requires the collector to be running. Off by default.';

export function MemoryExtractionCard() {
  const colors = useColors();
  const { state, dispatch } = useAetherStore();
  const enabled = state.memoryExtractionEnabled;
  const [confirming, setConfirming] = useState(false);

  // The file ~/.aether-os/collector-settings.json is the source of truth; show
  // its readback, never a locally remembered value.
  useEffect(() => {
    const api = window.aetherElectron?.memoryExtraction;
    if (!api) return;
    let live = true;
    api
      .get()
      .then((value) => {
        if (live) dispatch({ type: 'SET_MEMORY_EXTRACTION_ENABLED', enabled: value === true });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [dispatch]);

  const apply = async (requested: boolean) => {
    const api = window.aetherElectron?.memoryExtraction;
    if (!api) return;
    try {
      const readback = await api.set(requested);
      dispatch({ type: 'SET_MEMORY_EXTRACTION_ENABLED', enabled: readback === true });
    } catch {
      // The write outcome is unknown: show what is on disk, falling back to OFF.
      let onDisk = false;
      try {
        onDisk = (await api.get()) === true;
      } catch {
        onDisk = false;
      }
      dispatch({ type: 'SET_MEMORY_EXTRACTION_ENABLED', enabled: onDisk });
    }
  };

  const toggle = () => {
    if (!enabled) {
      setConfirming(true);
      return;
    }
    void apply(false); // disabling needs no confirmation
  };

  const confirmEnable = () => {
    setConfirming(false);
    void apply(true);
  };

  return (
    <div style={cardStyle(colors)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ ...titleStyle(colors), margin: 0 }}>MEMORY EXTRACTION</h2>
        <Button onClick={toggle} style={toggleStyle(colors, enabled)}>
          {enabled ? 'DISABLE' : 'ENABLE'}
        </Button>
      </div>

      {confirming && (
        <div style={confirmWrapStyle(colors)}>
          <p style={disclosureStyle(colors)}>{MEMORY_EXTRACTION_DISCLOSURE}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button onClick={confirmEnable} style={toggleStyle(colors, true)}>
              I UNDERSTAND, ENABLE
            </Button>
            <Button onClick={() => setConfirming(false)} style={toggleStyle(colors, false)}>
              CANCEL
            </Button>
          </div>
        </div>
      )}

      <p style={hintStyle(colors)}>{enabled ? MEMORY_EXTRACTION_DISCLOSURE : 'OFF. The collector sends nothing for memory extraction while this is off.'}</p>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    padding: 15,
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flexShrink: 0,
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { flex: 'none', font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function toggleStyle(colors: ColorPalette, on: boolean): CSSProperties {
  return {
    minWidth: 52,
    textAlign: 'center',
    cursor: 'pointer',
    padding: '6px 12px',
    borderRadius: 7,
    font: `600 11px/1 ${fonts.ui}`,
    letterSpacing: 1,
    color: on ? '#04202b' : colors.textMuted,
    background: on ? 'linear-gradient(180deg,#7ef0ff,#17b8d8)' : 'rgba(10,32,43,.6)',
    boxShadow: on ? '0 0 10px rgba(95,220,255,.4)' : undefined,
    border: on ? 'none' : '1px solid rgba(80,190,220,.25)',
  };
}
function confirmWrapStyle(colors: ColorPalette): CSSProperties {
  return {
    marginTop: 10,
    padding: 10,
    borderRadius: 8,
    border: `1px solid ${colors.chipBorder}`,
    background: 'rgba(10,32,43,.4)',
  };
}
function disclosureStyle(colors: ColorPalette): CSSProperties {
  return { margin: 0, font: `500 11px/1.4 ${fonts.ui}`, color: colors.textMuted };
}
function hintStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 10, font: `500 11px/1.4 ${fonts.ui}`, color: colors.textMuted };
}
