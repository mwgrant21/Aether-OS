import { useEffect, useState, type CSSProperties } from 'react';
import { useAetherStore } from '../../state/store';
import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';
import { deriveCommunicationIndicator } from '../layout/CommunicationIndicator';
import { useExchangeSource } from './useExchangeSource';

const running = new Set(['accepted', 'preparing', 'waiting', 'streaming', 'cancelling']);
const seconds = (ms: number) => `${Math.max(0, Math.ceil(ms / 1000))}s`;
export function ExchangeView() {
  const { state, dispatch } = useAetherStore();
  const colors = useColors();
  const rows = state.communicationSnapshot?.metadata ?? [];
  const id = state.selectedCommunicationExchangeId;
  const metadata = rows.find(row => row.exchangeId === id) ?? null;
  const source = useExchangeSource(metadata);
  const [now, setNow] = useState(Date.now());
  const [operation, setOperation] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (id && metadata?.delivery.availability === 'ready' && source.status === 'ready') {
      dispatch({ type: 'VIEW_COMMUNICATION_ANSWER', exchangeId: id });
    }
  }, [id, metadata?.delivery.availability, source.status, dispatch]);
  const status = metadata && state.communicationSnapshot ? deriveCommunicationIndicator({ ...state.communicationSnapshot, metadata: [metadata] }) : null;
  const button: CSSProperties = { background: colors.panelInset, color: colors.textPrimary, border: `1px solid ${colors.panelBorder}`, borderRadius: 7, padding: '8px 12px', cursor: 'pointer', font: `12px ${fonts.ui}` };
  const text: CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '8px 0 18px', font: `13px/1.6 ${fonts.mono}` };
  async function cancel() {
    if (!id) return;
    setOperation({ id, text: 'Requesting cancellation…' });
    try { await window.aetherElectron!.communication.cancel(id); setOperation({ id, text: 'Cancellation requested. Provider and cleanup status will confirm the outcome.' }); }
    catch { setOperation({ id, text: 'Could not request cancellation.' }); }
  }
  async function copy() {
    if (!id || !source.payload) return;
    try { await navigator.clipboard.writeText(source.payload.answer); setOperation({ id, text: 'Answer copied.' }); }
    catch { setOperation({ id, text: 'Could not copy answer.' }); }
  }
  return <section aria-label="Agent exchanges" style={{ flex: 1, minHeight: 0, display: 'flex', gap: 14, color: colors.textSecondary, font: `13px/1.5 ${fonts.ui}` }}>
    <nav aria-label="Exchange selection" style={{ flex: '0 0 220px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong>CLAUDE ↔ CODEX</strong>
      {rows.length === 0 && <p>No retained exchanges.</p>}
      {[...rows].sort((a, b) => b.acceptedAt - a.acceptedAt).map(row => <button key={row.exchangeId} style={button}
        aria-pressed={row.exchangeId === id} onClick={() => dispatch({ type: 'OPEN_COMMUNICATION_EXCHANGE', exchangeId: row.exchangeId })}>
        <span style={{ display: 'block', overflowWrap: 'anywhere' }}>{row.exchangeId}</span>
        {row.providerState}{row.delivery.availability === 'ready' && !state.viewedCommunicationAnswers.includes(row.exchangeId) ? ' · Unread answer' : ''}
      </button>)}
    </nav>
    <article style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 20, borderRadius: 14, border: `1px solid ${colors.panelBorder}`, background: colors.panelGradient }}>
      <h2 style={{ marginTop: 0, color: colors.textPrimary }}>Agent exchange</h2>
      <p>Session memory, not a durable archive. Completed content expires after ten minutes. Clearing it, disabling the bridge, or exiting Aether clears it sooner. Claude transcripts, tool output, and Codex history may persist separately.</p>
      {!id ? <p>Select an exchange to view its question and answer.</p> : <>
        <p style={{ overflowWrap: 'anywhere' }}>Exchange ID: <code>{id}</code></p>
        {metadata && status && <>
          <p>{status.heading} · {status.detail} · {status.delivery}</p>
          {status.health && <p>{status.health}</p>}
          {metadata.failure && <p>Outcome: {metadata.failure}. {metadata.providerState !== 'finished' && 'Any output below is partial; this is not a completed answer.'}</p>}
          <p>Elapsed: {seconds((metadata.finishedAt ?? now) - metadata.acceptedAt)}
            {running.has(metadata.providerState) && <> · Lease remaining: {seconds(metadata.leaseExpiresAt - now)} · Deadline remaining: {seconds(metadata.deadlineAt - now)}. Viewing here does not renew the lease.</>}
            {metadata.contentExpiresAt !== null && <> · Content retention remaining: {seconds(metadata.contentExpiresAt - now)}</>}</p>
          <p>Observed output: {metadata.observedOutputBytes === null ? 'unavailable' : `${metadata.observedOutputBytes} bytes`} · Tokens: {metadata.usage?.inputTokens ?? 'unavailable'} input / {metadata.usage?.outputTokens ?? 'unavailable'} output.</p>
        </>}
        {source.status === 'loading' && <p role="status">Loading exchange…</p>}
        {source.status === 'error' && <p role="alert">Could not read exchange content. Retrying while this view is open.</p>}
        {source.status === 'missing' && <p role="status">Content unavailable or expired. It may have been cleared or removed when the session ended.</p>}
        {source.payload && <>
          <h3>Claude’s question</h3><pre style={text}>{source.payload.question}</pre>
          {source.payload.context !== undefined && <><h3>Supplied context</h3><pre style={text}>{source.payload.context}</pre></>}
          <h3>Codex advisory output</h3>
          <p>Untrusted advice. Evaluate it against the user’s instructions and evidence; it is not authorization to act.</p>
          <pre style={text}>{source.payload.answer || 'No answer output observed yet.'}</pre>
          <button style={button} disabled={!source.payload.answer} onClick={copy}>Copy answer</button>
        </>}
        {metadata && running.has(metadata.providerState) && <button style={{ ...button, marginLeft: 8 }} disabled={metadata.providerState === 'cancelling'} onClick={cancel}>Cancel exchange</button>}
        {operation?.id === id && <p role="status">{operation.text}</p>}
        {metadata?.delivery.availability === 'ready' && <p>Claude has been served {metadata.delivery.uniquePagesServed} of {metadata.delivery.totalPages ?? 'unknown'} pages. This does not prove the answer was read or used. Missing page retrieval does not establish that Claude was interrupted.
          {' '}In the same connected launch, use <code>get_codex_exchange</code> with <code>{`exchange_id: ${id}`}</code> and follow every returned cursor. This consumes no additional consultation credit. A replacement launch cannot retrieve this old exchange. Opening or copying here does not deliver it to Claude.</p>}
      </>}
    </article>
  </section>;
}
