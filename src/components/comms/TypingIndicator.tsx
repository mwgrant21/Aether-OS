import type { CSSProperties } from 'react';

export function TypingIndicator({ hue }: { hue: string }) {
  return (
    <div style={wrapStyle}>
      <span style={dotStyle(hue, 0)} />
      <span style={dotStyle(hue, 0.15)} />
      <span style={dotStyle(hue, 0.3)} />
    </div>
  );
}

const wrapStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, padding: '8px 2px' };

function dotStyle(hue: string, delay: number): CSSProperties {
  return {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: hue,
    boxShadow: `0 0 6px ${hue}`,
    animation: `typingPulse 1.1s ease-in-out ${delay}s infinite`,
  };
}
