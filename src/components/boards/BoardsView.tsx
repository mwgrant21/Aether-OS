import { useCallback, useEffect, useState } from 'react';
import { Button } from '../shared/Button';
import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';
import { RANGES, type Range } from '../../shared/dashboards/spec';
import { AUTO_REFRESH, mergeRefresh, type AutoRefresh, type ShownPanel } from './boardsState';
import { BoardPanel } from './BoardPanel';
import { useBoards } from './useBoards';

const PLUS = '+'; // never a board id: ids match ^[a-z0-9-]+$

function readAuto(id: string): AutoRefresh {
  try { const v = localStorage.getItem(`boards.autoRefresh.${id}`); return v && v in AUTO_REFRESH ? (v as AutoRefresh) : 'off'; } catch { return 'off'; }
}
function writeAuto(id: string, v: AutoRefresh) {
  try { localStorage.setItem(`boards.autoRefresh.${id}`, v); } catch { /* per-viewer convenience only */ }
}

export function BoardsView() {
  const colors = useColors();
  const { api, listing, loadError, changed, reload } = useBoards();
  const [picked, setPicked] = useState<string | null>(null);
  const [range, setRange] = useState<Range | null>(null);
  const [results, setResults] = useState<Record<string, ShownPanel>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [auto, setAuto] = useState<AutoRefresh>('off');

  const boards = listing?.boards ?? [];
  const current = picked !== null && (picked === PLUS || boards.some((b) => b.id === picked)) ? picked : boards[0]?.id ?? PLUS;
  const board = boards.find((b) => b.id === current) ?? null;
  const boardId = board && !board.error ? board.id : null;
  const topError = listing?.error ?? loadError;

  const refresh = useCallback(async () => {
    if (!api || !boardId) return;
    setRefreshing(true);
    try {
      const r = await api.refresh(boardId, range ?? undefined);
      if (!r.ok) { setBoardError(r.error); return; }
      setBoardError(null);
      setResults((prev) => mergeRefresh(prev, r.panels));
      setLastRefreshed(Date.now());
    } catch {
      setBoardError('Refresh failed.');
    } finally {
      setRefreshing(false);
    }
  }, [api, boardId, range]);

  useEffect(() => { setResults({}); setConfirmDelete(false); setBoardError(null); setAuto(readAuto(current)); }, [current]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (boardId && changed.ids.includes(boardId)) void refresh(); }, [changed.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ms = AUTO_REFRESH[auto];
    if (!ms) return undefined;
    const t = setInterval(() => { void refresh(); }, ms);
    return () => clearInterval(t);
  }, [auto, refresh]);

  const chip = (on: boolean) => ({
    fontSize: 12, padding: '3px 10px', color: on ? colors.inkOnCyan : colors.textSecondary,
    background: on ? colors.accentCyan : colors.panelInset, border: `1px solid ${on ? colors.activeBorder : colors.chipBorder}`,
  });

  if (!api) return <div style={{ padding: 16, color: colors.textMuted }}>Boards needs the desktop app.</div>;

  return (
    <div style={{ padding: 16, display: 'grid', gap: 12, fontFamily: fonts.ui, color: colors.textBody, alignContent: 'start' }}>
      {topError && <div role="alert" style={{ color: colors.danger }}>{topError}</div>}
      {listing && !listing.collectorAvailable && (
        <div role="status" style={{ border: `1px solid ${colors.warnDeep}`, color: colors.warn, padding: 8 }}>
          No collector data: start the collector (see collector/README.md). Boards fill in once it has run.
        </div>
      )}
      <nav aria-label="Boards" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {boards.map((b) => (
          <Button key={b.id} aria-current={current === b.id ? 'page' : undefined} onClick={() => setPicked(b.id)} style={chip(current === b.id)}>{b.title}</Button>
        ))}
        <Button aria-label="New board" aria-current={current === PLUS ? 'page' : undefined} onClick={() => setPicked(PLUS)} style={chip(current === PLUS)}>+</Button>
      </nav>

      {current === PLUS && (
        <div style={{ display: 'grid', gap: 8, maxWidth: 720 }}>
          <p style={{ margin: 0 }}>Ask Claude in the Terminal tab, for example: "Make a board of my token spend by model per day this month."</p>
          <p style={{ margin: 0, color: colors.textSecondary }}>
            Claude needs the aether-data tool server, registered once. Copy the command, paste it into the Terminal tab, then restart Claude there.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button onClick={() => { void api.copyRegisterCommand().then((r) => setCopied(r.ok ? 'copied' : 'failed'), () => setCopied('failed')); }} style={chip(false)}>Copy register command</Button>
            {copied === 'copied' && <span style={{ color: colors.success }}>Copied. Paste it into the Terminal tab.</span>}
            {copied === 'failed' && <span style={{ color: colors.danger }}>Could not copy.</span>}
          </div>
        </div>
      )}

      {board?.error && <div role="alert" style={{ color: colors.danger }}>invalid: {board.error}</div>}

      {board && !board.error && (
        <>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button aria-pressed={range === null} onClick={() => setRange(null)} style={chip(range === null)}>Panel default</Button>
            {RANGES.map((r) => <Button key={r} aria-pressed={range === r} onClick={() => setRange(r)} style={chip(range === r)}>{r}</Button>)}
            <Button onClick={() => { void refresh(); }} disabled={refreshing} style={chip(false)}>{refreshing ? 'Refreshing…' : 'Refresh'}</Button>
            {(Object.keys(AUTO_REFRESH) as AutoRefresh[]).map((a) => (
              <Button key={a} aria-pressed={auto === a} onClick={() => { setAuto(a); writeAuto(board.id, a); }} style={chip(auto === a)}>auto {a}</Button>
            ))}
            {lastRefreshed !== null && <span style={{ color: colors.textMuted, fontSize: 12 }}>last refreshed {new Date(lastRefreshed).toLocaleTimeString()}</span>}
            <span style={{ flex: 1 }} />
            {confirmDelete ? (
              <>
                <span style={{ color: colors.warn, fontSize: 12 }}>Delete "{board.title}"? This removes its file.</span>
                <Button onClick={() => { void api.remove(board.id).then((r) => { setConfirmDelete(false); if (!r.ok) setBoardError(r.error ?? 'Delete failed.'); else { setPicked(null); reload(); } }, () => { setConfirmDelete(false); setBoardError('Delete failed.'); }); }} style={{ ...chip(false), color: colors.danger }}>Confirm delete</Button>
                <Button onClick={() => setConfirmDelete(false)} style={chip(false)}>Cancel</Button>
              </>
            ) : (
              <Button onClick={() => setConfirmDelete(true)} style={chip(false)}>Delete board</Button>
            )}
          </div>
          {boardError && <div role="alert" style={{ color: colors.danger }}>{boardError}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
            {board.panels.map((p) => <BoardPanel key={p.id} panel={p} result={results[p.id]} refreshing={refreshing} />)}
          </div>
        </>
      )}
    </div>
  );
}
