import type { CSSProperties } from 'react';
import type { CommunicationBridgeSnapshot } from '../../../electron/communicationBridge/mainIntegration';
import type { CommunicationMetadata } from '../../shared/communicationTypes';
import { useAetherStore } from '../../state/store';
import { fonts } from '../../styles/tokens';
import { useColors } from '../shared/useColors';

const active = new Set(['accepted', 'preparing', 'waiting', 'streaming', 'cancelling']);
const providerLabels: Record<CommunicationMetadata['providerState'], string> = {
  accepted: 'Request accepted', preparing: 'Preparing Codex', waiting: 'Waiting for Codex',
  streaming: 'Receiving output', cancelling: 'Cancelling', finished: 'Provider finished',
  cancelled: 'Cancelled', 'timed-out': 'Timed out', failed: 'Provider failed',
};
/** Metadata only: page delivery is evidence of serving bytes, never of reading. */
export function deriveCommunicationIndicator(snapshot: CommunicationBridgeSnapshot | null, viewed: readonly string[] = []) {
  const rows = [...(snapshot?.metadata ?? [])].sort((a, b) =>
    Number(active.has(b.providerState)) - Number(active.has(a.providerState)) || b.acceptedAt - a.acceptedAt);
  const exchange = rows[0];
  const readyCount = rows.filter(row => row.delivery.availability === 'ready' && !viewed.includes(row.exchangeId)).length;
  if (!exchange) return { exchangeId: null, readyCount, heading: 'Agent communication',
    detail: snapshot ? `Bridge ${snapshot.readiness}` : 'Status unavailable',
    delivery: '', health: snapshot?.cleanup === 'pending' ? 'Cleanup pending' : snapshot?.cleanup === 'failed' ? 'Cleanup failed' : '' };
  const delivery = exchange.delivery;
  let deliveryLabel: string;
  if (delivery.availability === 'expired') deliveryLabel = 'Answer expired';
  else if (delivery.availability === 'unavailable') deliveryLabel = 'Answer unavailable';
  else if (delivery.uniquePagesServed > 0) deliveryLabel = delivery.totalPages !== null && delivery.uniquePagesServed >= delivery.totalPages
    ? `All ${delivery.totalPages} pages served` : `${delivery.uniquePagesServed} of ${delivery.totalPages ?? '?'} pages served`;
  else deliveryLabel = delivery.availability === 'ready' ? 'Answer ready · no pages served' : 'Answer pending';
  const direction = delivery.uniquePagesServed > 0 ? 'Aether → Claude'
    : exchange.providerState === 'streaming' || delivery.availability === 'ready' ? 'Codex → Aether' : 'Claude → Codex';
  const cleanup = snapshot?.cleanup === 'failed' || exchange.cleanup === 'failed' ? 'Cleanup failed'
    : snapshot?.cleanup === 'pending' || exchange.cleanup === 'pending' ? 'Cleanup pending' : '';
  return { exchangeId: exchange.exchangeId, readyCount, heading: direction,
    detail: providerLabels[exchange.providerState], delivery: deliveryLabel,
    health: [!delivery.clientConnected && 'Client disconnected', cleanup].filter(Boolean).join(' · ') };
}

export function CommunicationIndicator() {
  const { state, dispatch } = useAetherStore();
  const colors = useColors();
  const view = deriveCommunicationIndicator(state.communicationSnapshot, state.viewedCommunicationAnswers);
  const description = [view.heading, view.detail, view.delivery, view.health,
    view.readyCount > 0 ? `${view.readyCount} unread answers for operator` : ''].filter(Boolean).join('. ');
  const style: CSSProperties & { WebkitAppRegion: 'no-drag' } = {
    WebkitAppRegion: 'no-drag', flex: '0 1 230px', minWidth: 145, maxWidth: 230,
    padding: '5px 9px', borderRadius: 8, border: `1px solid ${colors.chipBorder}`,
    background: colors.panelInset, color: colors.textSecondary, font: `10px/1.25 ${fonts.ui}`,
    textAlign: 'left', cursor: 'pointer', position: 'relative',
  };
  return <button type="button" style={style} title={description} aria-label={`Open communication. ${description}`}
    onClick={() => dispatch({ type: 'OPEN_COMMUNICATION_EXCHANGE', exchangeId: view.exchangeId })}>
    <span style={{ display: 'block', fontWeight: 600 }}>{view.heading}
      {view.readyCount > 0 && <span style={{ marginLeft: 6, padding: '0 4px', borderRadius: 4,
        background: colors.accentCyanSoft, color: colors.chromeBg }}>{view.readyCount}</span>}
    </span>
    <span style={{ display: 'block' }}>{view.detail}{view.delivery && ` · ${view.delivery}`}</span>
    {view.health && <span style={{ display: 'block', color: colors.warn }}>{view.health}</span>}
  </button>;
}
