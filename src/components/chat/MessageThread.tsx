import { useEffect, useRef, type CSSProperties } from 'react';
import { colors, fonts } from '../../styles/tokens';
import type { ChatChannel } from './chatChannels';
import type { ChatMessage } from './chatPersistence';
import { TypingIndicator } from './TypingIndicator';

interface MessageThreadProps {
  channel: ChatChannel;
  messages: ChatMessage[];
  isTyping: boolean;
}

export function MessageThread({ channel, messages, isTyping }: MessageThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, isTyping]);

  return (
    <div ref={scrollRef} style={threadStyle}>
      {!messages.length && (
        <div style={emptyStyle}>
          {channel.archived
            ? `${channel.name} is archived — this is the full history from before it went idle.`
            : `Say hello to ${channel.name} to start the conversation.`}
        </div>
      )}
      {messages.map((m) => (
        <div key={m.id} style={rowStyle(m.role)}>
          <div style={metaRowStyle}>
            <span style={labelStyle(m.role === 'user' ? colors.textSecondary : channel.hue)}>{m.role === 'user' ? 'YOU' : channel.name}</span>
            <span style={{ color: colors.textDim, font: `400 10px/1 ${fonts.mono}` }}>{m.t}</span>
          </div>
          <div style={textStyle}>{m.text}</div>
        </div>
      ))}
      {isTyping && <TypingIndicator hue={channel.hue} />}
    </div>
  );
}

const threadStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 2px', display: 'flex', flexDirection: 'column', gap: 12 };
const emptyStyle: CSSProperties = { font: `400 12px/1.6 ${fonts.ui}`, color: colors.textMuted, padding: '8px 2px' };
function rowStyle(role: ChatMessage['role']): CSSProperties {
  return { display: 'flex', flexDirection: 'column', alignItems: role === 'user' ? 'flex-end' : 'flex-start' };
}
const metaRowStyle: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8 };
function labelStyle(color: string): CSSProperties {
  return { font: `600 10px/1 ${fonts.ui}`, letterSpacing: 1.5, color };
}
const textStyle: CSSProperties = {
  marginTop: 5,
  maxWidth: '80%',
  font: `400 13px/1.5 ${fonts.ui}`,
  color: colors.textBody,
  padding: '9px 12px',
  borderRadius: 10,
  border: `1px solid ${colors.chromeBorder}`,
  background: 'rgba(6,20,28,.55)',
};
