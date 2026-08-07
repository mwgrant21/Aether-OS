import { useEffect, useRef, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import type { CommsChannel } from './commsChannels';
import type { DisplayMessage } from './transcriptFilter';

interface MessageThreadProps {
  channel: CommsChannel;
  messages: DisplayMessage[];
}

// Three visual treatments, per the task-3 brief: a human prompt, assistant
// text, and a compact tool row. Tool rows show `name · label` plus a size
// chip when a matching result exists -- never result content, since
// TranscriptToolResult only ever carries resultLength (see
// electron/transcriptReader.ts's header comment and Known Limitation #1 in
// the Stage 14 design doc).
export function MessageThread({ channel, messages }: MessageThreadProps) {
  const colors = useColors();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <div ref={scrollRef} style={threadStyle}>
      {!messages.length && (
        <div style={emptyStyle(colors)}>
          {channel.transcriptSourceId
            ? `No messages match — waiting on ${channel.name} or its filter.`
            : `${channel.name} has no backing transcript to display.`}
        </div>
      )}
      {messages.map((m) => (
        <MessageRow key={m.id} message={m} channel={channel} colors={colors} />
      ))}
    </div>
  );
}

function MessageRow({ message, channel, colors }: { message: DisplayMessage; channel: CommsChannel; colors: ColorPalette }) {
  const label = message.role === 'human' ? 'YOU' : message.role === 'assistant' ? channel.name : 'SYSTEM';
  const labelColor = message.role === 'human' ? colors.textSecondary : message.role === 'assistant' ? channel.hue : colors.textDim;

  return (
    <div style={rowStyle(message.role)}>
      <div style={metaRowStyle}>
        <span style={labelStyle(labelColor)}>{label}</span>
        <span style={{ color: colors.textDim, font: `400 10px/1 ${fonts.mono}` }}>{new Date(message.atMs).toLocaleTimeString()}</span>
      </div>
      {message.text && <div style={textStyle(colors)}>{message.text}</div>}
      {message.toolCalls.map((tc, i) => (
        <div key={i} style={toolRowStyle(colors)}>
          <span style={toolNameStyle(colors)}>{tc.name}</span>
          <span style={toolDotStyle(colors)}>·</span>
          <span style={toolLabelStyle(colors)}>{tc.label}</span>
          {message.toolResults[i] && <span style={sizeChipStyle(colors)}>{message.toolResults[i].resultLength}c</span>}
        </div>
      ))}
    </div>
  );
}

const threadStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 2px', display: 'flex', flexDirection: 'column', gap: 12 };
function emptyStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 12px/1.6 ${fonts.ui}`, color: colors.textMuted, padding: '8px 2px' };
}
function rowStyle(role: DisplayMessage['role']): CSSProperties {
  return { display: 'flex', flexDirection: 'column', alignItems: role === 'human' ? 'flex-end' : 'flex-start', gap: 5 };
}
const metaRowStyle: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8 };
function labelStyle(color: string): CSSProperties {
  return { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 1.5, color };
}
function textStyle(colors: ColorPalette): CSSProperties {
  return {
    maxWidth: '80%',
    font: `400 13px/1.5 ${fonts.ui}`,
    color: colors.textBody,
    padding: '9px 12px',
    borderRadius: 10,
    border: `1px solid ${colors.chromeBorder}`,
    background: colors.panelInset,
  };
}
function toolRowStyle(colors: ColorPalette): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 10px',
    borderRadius: 8,
    background: colors.panelInset,
    border: `1px solid ${colors.chipBorder}`,
    font: `400 11px/1.3 ${fonts.mono}`,
  };
}
function toolNameStyle(colors: ColorPalette): CSSProperties {
  return { color: colors.accentCyan, fontWeight: 700 };
}
function toolDotStyle(colors: ColorPalette): CSSProperties {
  return { color: colors.textDim };
}
function toolLabelStyle(colors: ColorPalette): CSSProperties {
  return { color: colors.textBody, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
}
function sizeChipStyle(colors: ColorPalette): CSSProperties {
  return {
    marginLeft: 'auto',
    flex: 'none',
    font: `600 9px/1 ${fonts.mono}`,
    color: colors.textDim,
    border: `1px solid ${colors.chipBorder}`,
    borderRadius: 5,
    padding: '2px 5px',
  };
}
