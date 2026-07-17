import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { colors, fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { SystemOverviewCard } from './SystemOverviewCard';
import { ActiveAgentsCard } from './ActiveAgentsCard';
import { LiveOutputCard } from './LiveOutputCard';

const SPAWN_NAMES = ['UI Designer', 'Code Builder', 'Content Writer', 'Test Runner', 'Deploy Bot'];
const BUILD_STEPS = [
  { text: 'Initializing project', tag: '[ok]' },
  { text: 'Analyzing requirements', tag: '[ok]' },
  { text: 'Generating structure', tag: '[ok]' },
  { text: 'Writing code · index.html · styles.css · script.js', tag: '[ok]' },
  { text: 'Optimizing assets', tag: '[ok]' },
  { text: 'Running build', tag: '[ok]' },
  { text: 'Finalizing', tag: '[ok]' },
];
const CHIPS = ['status', 'agents', 'spawn Optimizer', 'budget', 'help'];

export function TerminalView() {
  const { state, dispatch } = useAetherStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.termHist.length]);

  function submit() {
    if (!state.cmdVal.trim()) return;
    dispatch({ type: 'RUN_COMMAND', raw: state.cmdVal });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') submit();
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      dispatch({ type: 'HIST_NAV', up: true });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      dispatch({ type: 'HIST_NAV', up: false });
    }
  }

  return (
    <div style={rootStyle}>
      <div style={terminalCardStyle}>
        <div style={scanSweepStyle} />
        <div style={headerStyle}>
          <span style={liveDotStyle} />
          <span style={{ font: `400 13px/1 ${fonts.mono}`, color: colors.accentCyanSoft }}>operator@aether-core</span>
          <span style={{ font: `400 13px/1 ${fonts.mono}`, color: colors.textDim }}>:~$ session active</span>
          <span style={{ marginLeft: 'auto', font: `400 11px/1 ${fonts.mono}`, color: colors.textDim }}>TERMINAL · zsh</span>
        </div>

        <div ref={scrollRef} style={scrollbackStyle}>
          <div style={{ color: colors.textSecondary }}>Welcome back, operator. Reactor is online.</div>
          <div style={{ color: colors.textMuted }}>
            Type <span style={{ color: colors.accentCyanSoft }}>'help'</span> for available commands.
          </div>
          <div style={{ height: 12 }} />
          <div>
            <span style={{ color: colors.accentCyanSoft }}>operator@aether-core</span>
            <span style={{ color: colors.textMuted }}>:~$</span> <span style={{ color: colors.textBody }}>build my landing page</span>
          </div>
          <div style={{ color: colors.accentCyanSoft, marginTop: 4 }}>◇ Reactor spun up — spawning 5 parallel agents…</div>
          {SPAWN_NAMES.map((n) => (
            <div key={n}>
              <span style={{ color: colors.textMuted }}>&gt;</span> <span style={{ color: colors.textBody }}>{n}</span>{' '}
              <span style={{ color: colors.success, marginLeft: 16 }}>spawned</span>
            </div>
          ))}
          <div style={{ height: 6 }} />
          {BUILD_STEPS.map((s) => (
            <div key={s.text} style={{ color: colors.textSecondary }}>
              <span style={{ color: colors.success }}>✓</span> {s.text} <span style={{ color: colors.textDim }}>{s.tag}</span>
            </div>
          ))}
          <div style={{ height: 8 }} />
          <div style={{ color: colors.success }}>✓ Build complete — site is live.</div>
          <div style={{ color: colors.textSecondary }}>
            Preview: <a href="#">http://localhost:3000</a>
          </div>
          <div style={{ height: 8 }} />
          {state.termHist.map((th, idx) => (
            <div key={idx} style={{ whiteSpace: 'pre-wrap', color: th.c }}>
              {th.t}
            </div>
          ))}
          <div>
            <span style={{ color: colors.accentCyanSoft }}>operator@aether-core</span>
            <span style={{ color: colors.textMuted }}>:~$</span> <span style={caretStyle} />
          </div>
        </div>

        <div style={coreFloatWrapStyle}>
          {/* Task 17 replaces this placeholder with <ReactorCore /> */}
          <div style={coreCircleStyle} />
        </div>
        <div style={calloutStyle}>Reactor nominal — {state.agents.length} agents drawing power.</div>

        <div style={inputBarStyle}>
          <div style={inputRowStyle}>
            <span style={{ color: colors.accentCyanSoft, font: `700 15px/1 ${fonts.mono}` }}>&gt;</span>
            <input
              value={state.cmdVal}
              onChange={(e) => dispatch({ type: 'SET_CMD_VAL', value: e.target.value })}
              onKeyDown={onKeyDown}
              placeholder="Type a command — try 'help'"
              spellCheck={false}
              style={inputStyle}
            />
            <span onClick={submit} style={sendButtonStyle}>
              ➤
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 11, flexWrap: 'wrap' }}>
            {CHIPS.map((c) => (
              <div key={c} onClick={() => dispatch({ type: 'RUN_COMMAND', raw: c })} style={chipStyle}>
                {c}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={railStyle}>
        <SystemOverviewCard />
        <ActiveAgentsCard />
        <LiveOutputCard />
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', gap: 14 };
const terminalCardStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  position: 'relative',
  borderRadius: 14,
  border: `1px solid ${colors.panelBorder}`,
  background: colors.panelGradient,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};
const scanSweepStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  height: 150,
  background: 'linear-gradient(180deg, rgba(95,240,255,.08), transparent)',
  animation: 'scan 7s linear infinite',
  pointerEvents: 'none',
};
const headerStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '11px 16px',
  borderBottom: `1px solid ${colors.chromeBorder}`,
};
const liveDotStyle: CSSProperties = { width: 10, height: 10, borderRadius: '50%', background: colors.accentCyanDeep, boxShadow: '0 0 8px rgba(95,240,255,.8)' };
const scrollbackStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', padding: '16px 20px', font: `400 13px/1.8 ${fonts.mono}`, position: 'relative' };
const caretStyle: CSSProperties = {
  width: 9,
  height: 16,
  display: 'inline-block',
  background: colors.accentCyan,
  verticalAlign: -2,
  marginLeft: 4,
  animation: 'blink 1s step-end infinite',
};
const coreFloatWrapStyle: CSSProperties = {
  position: 'absolute',
  right: 6,
  top: '52%',
  transform: 'translateY(-50%)',
  width: 334,
  height: 334,
  display: 'grid',
  placeItems: 'center',
  pointerEvents: 'none',
};
const coreCircleStyle: CSSProperties = {
  width: 224,
  height: 224,
  borderRadius: '50%',
  border: '1px solid rgba(95,220,255,.25)',
  background: 'radial-gradient(circle, rgba(23,184,216,.15), transparent 70%)',
};
const calloutStyle: CSSProperties = {
  position: 'absolute',
  right: 100,
  top: 'calc(52% + 176px)',
  padding: '9px 13px',
  borderRadius: '2px 10px 10px 10px',
  border: '1px solid rgba(95,220,255,.3)',
  background: 'rgba(10,34,45,.9)',
  font: `400 12px/1.4 ${fonts.ui}`,
  color: '#bff4ff',
  maxWidth: 146,
  textAlign: 'left',
};
const inputBarStyle: CSSProperties = { flex: 'none', padding: '13px 16px', borderTop: `1px solid ${colors.chromeBorder}` };
const inputRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderRadius: 10,
  border: '1px solid rgba(80,190,220,.3)',
  background: 'rgba(6,20,28,.7)',
};
const inputStyle: CSSProperties = {
  flex: 1,
  font: `400 13px/1 ${fonts.mono}`,
  color: colors.textBody,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  caretColor: colors.accentCyan,
};
const sendButtonStyle: CSSProperties = {
  cursor: 'pointer',
  width: 30,
  height: 30,
  borderRadius: 8,
  background: 'linear-gradient(180deg,#17b8d8,#0f7f97)',
  display: 'grid',
  placeItems: 'center',
  color: colors.textPrimary,
  boxShadow: '0 0 14px rgba(95,240,255,.5)',
};
const chipStyle: CSSProperties = {
  cursor: 'pointer',
  padding: '6px 13px',
  borderRadius: 7,
  border: '1px solid rgba(80,190,220,.25)',
  background: 'rgba(10,32,43,.5)',
  font: `400 12px/1 ${fonts.mono}`,
  color: colors.textSecondary,
};
const railStyle: CSSProperties = { width: 332, flex: 'none', display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 };
