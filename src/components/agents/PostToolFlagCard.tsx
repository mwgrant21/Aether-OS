import { useEffect, useState, type CSSProperties } from 'react';
import { fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import type { ColorPalette } from '../../styles/tokens';
import type { PostToolFlagRequestUI } from '../../state/types';

export function PostToolFlagCard() {
  const colors = useColors();
  const { state } = useAetherStore();
  const request = state.pendingPostToolFlag;
  if (!request) return null;

  // Simultaneity: a PermissionRequest (blocking, gates a tool call) and a
  // PostToolUse flag-review (reviewing something that already ran) can be
  // pending at the same time -- they're independent resolver maps in
  // main.ts. Rather than a full stacking/queue system, this card simply
  // renders lower on screen whenever a PermissionRequestCard is also up, so
  // the two never visually overlap. The offset is a fixed pixel value (not
  // DOM-measured) sized to clear PermissionRequestCard's typical rendered
  // height -- good enough for "never unreadable," not meant to be pixel-exact.
  const stackedBelowPermission = state.pendingPermissionRequest !== null;

  return <PostToolFlagCardInner colors={colors} request={request} topOffset={stackedBelowPermission ? 230 : 16} />;
}

function PostToolFlagCardInner({
  colors,
  request,
  topOffset,
}: {
  colors: ColorPalette;
  request: PostToolFlagRequestUI;
  topOffset: number;
}) {
  const [blockReason, setBlockReason] = useState('');
  const [blocking, setBlocking] = useState(false);

  // Reset local edit state whenever a new request arrives (a stale reason
  // from a previous, already-resolved flag must never leak into the next one).
  useEffect(() => {
    setBlockReason('');
    setBlocking(false);
  }, [request.requestId]);

  function respond(decision: { block: boolean; reason?: string }) {
    window.aetherElectron?.postToolFlag.respond(request.requestId, decision);
  }

  function handleAllow() {
    respond({ block: false });
  }

  function handleBlockClick() {
    if (!blocking) {
      setBlocking(true);
      return;
    }
    const reason = blockReason.trim();
    if (!reason) return;
    respond({ block: true, reason });
  }

  return (
    <div style={cardStyle(colors, topOffset)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle(colors)}>FLAGGED TOOL USE</div>
        <span style={anomalyBadgeStyle(colors)}>{request.anomalyKind}</span>
      </div>

      <div style={toolNameStyle(colors)}>{request.toolName}</div>
      <div style={detailStyle(colors)}>{request.detail}</div>

      {blocking && (
        <div style={{ marginTop: 8 }}>
          <input
            style={inputStyle(colors)}
            placeholder="Reason for blocking (required)"
            value={blockReason}
            onChange={(e) => setBlockReason(e.target.value)}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <Button onClick={handleAllow} style={allowButtonStyle(colors)}>
          Dismiss
        </Button>
        <Button onClick={handleBlockClick} style={blockButtonStyle(colors)} disabled={blocking && blockReason.trim() === ''}>
          Block
        </Button>
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette, topOffset: number): CSSProperties {
  return {
    position: 'fixed',
    top: topOffset,
    right: 16,
    zIndex: 999,
    width: 320,
    padding: 15,
    borderRadius: 14,
    border: `1px solid ${colors.panelBorder}`,
    background: colors.panelGradient,
  };
}
function titleStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 12px/1 ${fonts.ui}`, letterSpacing: 3, color: colors.textSecondary };
}
function toolNameStyle(colors: ColorPalette): CSSProperties {
  return { font: `600 15px/1.4 ${fonts.ui}`, color: colors.textPrimary, marginTop: 8 };
}
function detailStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 11px/1.4 ${fonts.mono}`, color: colors.textDim, marginTop: 4 };
}
function inputStyle(colors: ColorPalette): CSSProperties {
  return {
    width: '100%',
    font: `400 12px/1.4 ${fonts.mono}`,
    color: colors.textPrimary,
    background: colors.panelInset,
    border: `1px solid ${colors.chipBorder}`,
    borderRadius: 6,
    padding: '6px 8px',
    boxSizing: 'border-box',
  };
}
function anomalyBadgeStyle(colors: ColorPalette): CSSProperties {
  return {
    font: `700 10px/1 ${fonts.ui}`,
    letterSpacing: 0.5,
    color: colors.warn,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset,
    padding: '2px 6px',
    borderRadius: 4,
  };
}
function allowButtonStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 1,
    padding: '8px 10px',
    borderRadius: 8,
    textAlign: 'center',
    font: `600 12px/1 ${fonts.ui}`,
    color: colors.textPrimary,
    background: 'rgba(59,224,160,.18)',
    border: '1px solid rgba(59,224,160,.4)',
  };
}
function blockButtonStyle(colors: ColorPalette): CSSProperties {
  return {
    flex: 1,
    padding: '8px 10px',
    borderRadius: 8,
    textAlign: 'center',
    font: `600 12px/1 ${fonts.ui}`,
    color: colors.textPrimary,
    background: 'rgba(255,157,157,.14)',
    border: '1px solid rgba(255,157,157,.4)',
  };
}
