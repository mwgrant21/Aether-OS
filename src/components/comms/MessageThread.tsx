import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { fonts, type ColorPalette } from '../../styles/tokens';
import { useColors } from '../shared/useColors';
import type { CommsChannel } from './commsChannels';
import type { DisplayMessage } from './transcriptFilter';
import type { NarrationMessage } from '../../state/types';

interface MessageThreadProps {
  channel: CommsChannel;
  messages: DisplayMessage[];
  narrationMessages?: NarrationMessage[];
}

// Chronological merge of real transcript messages and voice-pack narration
// lines (Stage 14 Task 5). A discriminated union so MessageRow/NarrationRow
// can each own their own visual treatment -- narration is never rendered as
// a chat bubble, per the task-5 brief.
type ThreadItem = { kind: 'transcript'; message: DisplayMessage } | { kind: 'narration'; message: NarrationMessage };

function mergeChronological(messages: DisplayMessage[], narrationMessages: NarrationMessage[]): ThreadItem[] {
  const items: ThreadItem[] = [
    ...messages.map((message): ThreadItem => ({ kind: 'transcript', message })),
    ...narrationMessages.map((message): ThreadItem => ({ kind: 'narration', message })),
  ];
  return items.sort((a, b) => a.message.atMs - b.message.atMs);
}

// Three visual treatments, per the task-3 brief: a human prompt, assistant
// text, and a compact tool row. Tool rows show `name · label` plus a size
// chip when a matching result exists -- never result content, since
// TranscriptToolResult only ever carries resultLength (see
// electron/transcriptReader.ts's header comment and Known Limitation #1 in
// the Stage 14 design doc).
export function MessageThread({ channel, messages, narrationMessages = [] }: MessageThreadProps) {
  const colors = useColors();
  const scrollRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => mergeChronological(messages, narrationMessages), [messages, narrationMessages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  return (
    <div ref={scrollRef} style={threadStyle}>
      {!items.length && (
        <div style={emptyStyle(colors)}>
          {channel.transcriptSourceId
            ? `No messages match — waiting on ${channel.name} or its filter.`
            : `${channel.name} has no backing transcript to display.`}
        </div>
      )}
      {items.map((item) =>
        item.kind === 'transcript' ? (
          <MessageRow key={item.message.id} message={item.message} channel={channel} colors={colors} />
        ) : (
          <NarrationRow key={item.message.id} message={item.message} colors={colors} />
        )
      )}
    </div>
  );
}

// Visually distinct from MessageRow: no bubble, no border, just the voice
// name and the character-styled line -- the task-5 brief is explicit that
// narration must not read as a chat message.
function NarrationRow({ message, colors }: { message: NarrationMessage; colors: ColorPalette }) {
  return (
    <div style={narrationRowStyle} data-testid="narration-row" data-interrupts={message.interrupts}>
      <span style={narrationVoiceStyle(colors, message.severity)}>{message.voiceName}</span>
      <span style={narrationTextStyle(colors)}>{message.text}</span>
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
          {tc.resultLength !== null && <span style={sizeChipStyle(colors)}>{tc.resultLength}c</span>}
        </div>
      ))}
      {/* A tool-result-only line whose matching tool_use fell outside the
          read window (so readTranscript's correlation pass in
          transcriptReader.ts couldn't attach it to a call's size chip) still
          reaches here rather than being dropped -- show it as its own compact
          row instead of a bare SYSTEM label + timestamp with nothing under it. */}
      {message.toolCalls.length === 0 &&
        message.toolResults.map((tr, i) => (
          <div key={i} style={toolRowStyle(colors)}>
            <span style={toolLabelStyle(colors)}>tool result (call not in view)</span>
            <span style={sizeChipStyle(colors)}>{tr.resultLength}c</span>
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
const narrationRowStyle: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8, padding: '2px 4px' };
function narrationVoiceStyle(colors: ColorPalette, severity: number): CSSProperties {
  return {
    flex: 'none',
    font: `700 10px/1 ${fonts.mono}`,
    letterSpacing: 1.5,
    color: severity >= 3 ? colors.warn : colors.textMuted,
  };
}
function narrationTextStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 12px/1.4 ${fonts.ui}`, fontStyle: 'italic', color: colors.textDim };
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
