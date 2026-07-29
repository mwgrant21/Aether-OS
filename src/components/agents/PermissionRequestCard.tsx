import { useEffect, useState, type CSSProperties } from 'react';
import { fonts } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { Button } from '../shared/Button';
import type { ColorPalette } from '../../styles/tokens';
import type { PermissionRequestUI } from '../../state/types';

// Maps a PermissionRequestUI's editable field back into the tool_input shape
// the underlying tool expects -- mirrors derivePermissionEditableField's own
// label choices (Bash -> command, Read/Write/Edit/NotebookEdit -> file_path).
function fieldKeyFor(toolName: string): string | null {
  if (toolName === 'Bash') return 'command';
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') return 'file_path';
  return null;
}

export function PermissionRequestCard({ measureRef }: { measureRef?: (node: HTMLDivElement | null) => void } = {}) {
  const colors = useColors();
  const { state } = useAetherStore();
  const request = state.pendingPermissionRequest;

  return request ? <PermissionRequestCardInner colors={colors} request={request} measureRef={measureRef} /> : null;
}

function PermissionRequestCardInner({
  colors,
  request,
  measureRef,
}: {
  colors: ColorPalette;
  request: PermissionRequestUI;
  measureRef?: (node: HTMLDivElement | null) => void;
}) {
  const [fieldValue, setFieldValue] = useState(request.editableField?.value ?? '');
  const [denyReason, setDenyReason] = useState('');
  const [denying, setDenying] = useState(false);

  // Reset local edit state whenever a new request arrives (a stale edit from
  // a previous, already-resolved request must never leak into the next one).
  useEffect(() => {
    setFieldValue(request.editableField?.value ?? '');
    setDenyReason('');
    setDenying(false);
  }, [request.requestId]);

  function respond(input: { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; reason: string }) {
    window.aetherElectron?.permission.respond(request.requestId, input);
  }

  function handleApprove() {
    const key = request.editableField ? fieldKeyFor(request.toolName) : null;
    const updatedInput =
      key && typeof request.toolInput === 'object' && request.toolInput !== null
        ? { ...(request.toolInput as Record<string, unknown>), [key]: fieldValue }
        : request.toolInput;
    respond({ behavior: 'allow', updatedInput });
  }

  function handleDenyClick() {
    if (!denying) {
      setDenying(true);
      return;
    }
    const reason = denyReason.trim();
    if (!reason) return;
    respond({ behavior: 'deny', reason });
  }

  return (
    <div ref={measureRef} style={cardStyle(colors)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={titleStyle(colors)}>PERMISSION REQUEST</div>
        <span style={riskBadgeStyle(colors, request.risk)}>{request.risk}</span>
      </div>

      <div style={toolNameStyle(colors)}>{request.toolName}</div>

      {request.editableField && (
        <div style={{ marginTop: 8 }}>
          <label style={labelStyle(colors)}>{request.editableField.label}</label>
          <input
            style={inputStyle(colors)}
            value={fieldValue}
            onChange={(e) => setFieldValue(e.target.value)}
          />
        </div>
      )}

      {denying && (
        <div style={{ marginTop: 8 }}>
          <input
            style={inputStyle(colors)}
            placeholder="Reason for denial (required)"
            value={denyReason}
            onChange={(e) => setDenyReason(e.target.value)}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <Button onClick={handleApprove} style={approveButtonStyle(colors)}>
          Approve
        </Button>
        <Button onClick={handleDenyClick} style={denyButtonStyle(colors)} disabled={denying && denyReason.trim() === ''}>
          Deny
        </Button>
      </div>
    </div>
  );
}

function cardStyle(colors: ColorPalette): CSSProperties {
  return {
    position: 'fixed',
    top: 16,
    right: 16,
    zIndex: 1000,
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
function labelStyle(colors: ColorPalette): CSSProperties {
  return { font: `400 10px/1.4 ${fonts.ui}`, color: colors.textDim, display: 'block', marginBottom: 3 };
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
function riskBadgeStyle(colors: ColorPalette, risk: PermissionRequestUI['risk']): CSSProperties {
  return {
    font: `700 10px/1 ${fonts.ui}`,
    letterSpacing: 0.5,
    color: risk === 'HIGH' ? colors.danger : risk === 'MED' ? colors.warn : colors.success,
    border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset,
    padding: '2px 6px',
    borderRadius: 4,
  };
}
function approveButtonStyle(colors: ColorPalette): CSSProperties {
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
function denyButtonStyle(colors: ColorPalette): CSSProperties {
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
