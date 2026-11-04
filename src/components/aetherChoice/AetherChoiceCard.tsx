import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import { LAUNCH_EFFORTS, MODEL_ALIASES, type LaunchEffort, type ModelAlias } from '../../shared/aetherChoice/types';
import type { AetherChoiceSlot, AetherChoiceSlotState } from '../../shared/aetherChoice/ipc';
import { PickReadout } from './PickReadout';
import { useAetherChoice } from './useAetherChoice';

const SLOTS: ReadonlyArray<{ slot: AetherChoiceSlot; label: string }> = [
  { slot: 'claude', label: 'TERMINAL' },
  { slot: 'terminal2', label: 'TERMINAL 2' },
];

type Run = (action: () => Promise<boolean>) => Promise<void>;

export function AetherChoiceCard() {
  const colors = useColors();
  const { status, state, refresh } = useAetherChoice();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);

  if (status !== 'ready' || !state) return null;

  // One action at a time; the ref blocks a double click before the re-render disables the buttons.
  const run: Run = async action => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    try {
      if (!(await action())) setFailed(true);
    } catch {
      setFailed(true);
    }
    try {
      await refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div style={cardStyle(colors)}>
      <h2 style={{ ...titleStyle(colors), margin: 0 }}>AETHERCHOICE</h2>
      {SLOTS.map(({ slot, label }) => {
        const s = state[slot];
        if (!s) return null;
        return <SlotPanel key={slot} slot={slot} label={label} s={s} busy={busy} colors={colors} run={run} />;
      })}
      <div style={{ marginTop: 12 }}>
        <Button onClick={() => { void run(async () => true); }} disabled={busy} style={toggleStyle(colors, false)}>
          REFRESH
        </Button>
      </div>
      {failed && <p style={{ ...hintStyle(colors), color: colors.danger }}>Pick not accepted.</p>}
      <p style={hintStyle(colors)}>
        Effort changes are typed once, at a confirmed idle prompt. A model change waits for the next launch.
      </p>
    </div>
  );
}

function SlotPanel(props: {
  slot: AetherChoiceSlot;
  label: string;
  s: AetherChoiceSlotState;
  busy: boolean;
  colors: ColorPalette;
  run: Run;
}) {
  const { slot, label, s, busy, colors, run } = props;
  const [model, setModel] = useState<ModelAlias>(s.tier);
  const [effort, setEffort] = useState<LaunchEffort>(s.effort);
  useEffect(() => {
    setModel(s.tier);
    setEffort(s.effort);
  }, [s.tier, s.effort]);

  return (
    <div style={{ marginTop: 12 }}>
      <div style={labelStyle(colors)}>{label}</div>
      <div style={{ marginTop: 6 }}>
        <PickReadout
          tier={s.tier}
          effort={s.effort}
          reason={s.reason}
          state={s.readout}
          auto={s.auto}
          target={s.target}
          haltedText={s.haltedText}
        />
      </div>
      {s.readout === 'notApplied' && (
        <>
          <Button
            onClick={() => {
              void run(async () => {
                await window.aetherElectron?.aetherChoice.clearHalt({ slot });
                return true;
              });
            }}
            disabled={busy}
            style={{ ...toggleStyle(colors, false), marginTop: 8 }}
          >
            CLEAR HALT
          </Button>
          <p style={hintStyle(colors)}>
            Clearing a halt lets Aether write again; it does not change what is running.
          </p>
        </>
      )}
      <div style={chipRowStyle}>
        {MODEL_ALIASES.map(m => (
          <Button key={m} onClick={() => setModel(m)} disabled={busy} aria-pressed={model === m} style={toggleStyle(colors, model === m)}>
            {m}
          </Button>
        ))}
      </div>
      <div style={chipRowStyle}>
        {LAUNCH_EFFORTS.map(e => (
          <Button key={e} onClick={() => setEffort(e)} disabled={busy} aria-pressed={effort === e} style={toggleStyle(colors, effort === e)}>
            {e}
          </Button>
        ))}
      </div>
      <Button
        onClick={() => {
          void run(async () => {
            const r = await window.aetherElectron?.aetherChoice.submit({ slot, model, effort });
            return !!r && r.ok;
          });
        }}
        disabled={busy}
        style={{ ...toggleStyle(colors, true), marginTop: 8 }}
      >
        SUBMIT PICK
      </Button>
    </div>
  );
}

const chipRowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 };

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
function labelStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 11px/1 ${fonts.ui}`, letterSpacing: 2, color: colors.textMuted };
}
function hintStyle(colors: ColorPalette): CSSProperties {
  return { marginTop: 10, font: `500 11px/1.4 ${fonts.ui}`, color: colors.textMuted };
}
