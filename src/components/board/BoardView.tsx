import { useState } from 'react';
import { Button } from '../shared/Button';
import { EmptyState } from '../shared/EmptyState';
import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';
import type { BoardSessionSummary } from '../../shared/board/types';
import { PostRow } from './PostRow';
import { useBoard } from './useBoard';

const ALL = '\u0000all';
const NONE = '\u0000none'; // sessions whose cwd is not in a known project (e.g. the home dir)

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function dayOf(ms: number): string {
  return new Date(ms).toDateString(); // local calendar day
}

function sessionLabel(s: BoardSessionSummary, now: number): string {
  const parts = [s.project?.name ?? 'No project'];
  if (s.project?.worktree) parts.push(s.project.worktree);
  parts.push(ago(s.lastActiveMs, now), `${s.subagentCount} ${s.subagentCount === 1 ? 'agent' : 'agents'}`);
  return parts.join(' · ');
}

export function BoardView() {
  const colors = useColors();
  const { api, sessions, sessionsError, selected, select, feed, feedError, loading, refresh } = useBoard();
  const [filter, setFilter] = useState<string>(ALL);
  const [showEmpty, setShowEmpty] = useState(false);

  if (!api) return <div style={{ padding: 16, color: colors.textMuted }}>Traffic needs the desktop app.</div>;

  const now = Date.now();
  const all = sessions ?? [];
  const projects = new Map<string, string>();
  let hasNone = false;
  for (const s of all) {
    if (s.project) projects.set(s.project.key, s.project.name);
    else hasNone = true;
  }
  const visible = all.filter((s) => {
    if (!showEmpty && s.subagentCount === 0) return false;
    if (filter === ALL) return true;
    return filter === NONE ? s.project === null : s.project?.key === filter;
  });

  const chip = (on: boolean) => ({
    fontSize: 12, padding: '3px 10px', color: on ? colors.inkOnCyan : colors.textSecondary,
    background: on ? colors.accentCyan : colors.panelInset, border: `1px solid ${on ? colors.activeBorder : colors.chipBorder}`,
    textAlign: 'left' as const,
  });
  const filterChip = (id: string, label: string) => (
    <Button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)} style={chip(filter === id)}>{label}</Button>
  );

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, fontFamily: fonts.ui, color: colors.textBody }}>
      <aside aria-label="Sessions" style={{ width: 300, flexShrink: 0, padding: 12, display: 'grid', gap: 10, alignContent: 'start', overflowY: 'auto', borderRight: `1px solid ${colors.chipBorder}`, boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {filterChip(ALL, 'All projects')}
          {[...projects].map(([key, name]) => filterChip(key, name))}
          {hasNone && filterChip(NONE, 'No project')}
        </div>
        <Button aria-pressed={showEmpty} onClick={() => setShowEmpty((v) => !v)} style={chip(showEmpty)}>Show sessions without agents</Button>
        {sessionsError && <div role="alert" style={{ color: colors.danger }}>{sessionsError}</div>}
        {sessions !== null && visible.length === 0 && (
          <EmptyState message={all.length === 0 ? 'No sessions found.' : 'No sessions match this filter.'} />
        )}
        <div style={{ display: 'grid', gap: 4 }}>
          {visible.map((s) => {
            const on = selected?.projectDir === s.projectDir && selected.sessionId === s.sessionId;
            return (
              <Button key={`${s.projectDir}/${s.sessionId}`} aria-current={on ? 'true' : undefined} onClick={() => select({ projectDir: s.projectDir, sessionId: s.sessionId })} style={chip(on)}>
                {sessionLabel(s, now)}
              </Button>
            );
          })}
        </div>
      </aside>
      <section aria-label="Traffic" style={{ flex: 1, minWidth: 0, padding: 12, display: 'grid', gap: 10, alignContent: 'start', overflowY: 'auto' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button onClick={refresh} style={chip(false)}>Refresh</Button>
          {loading && <span role="status" style={{ color: colors.textMuted, fontSize: 12 }}>Loading...</span>}
        </div>
        {feedError && <div role="alert" style={{ color: colors.danger }}>{feedError}</div>}
        {!selected && sessions !== null && visible.length > 0 && !feedError && <EmptyState message="Select a session to see its agent traffic." />}
        {feed && feed.posts.length === 0 && <EmptyState message="No agent traffic in this session." />}
        {feed && feed.capped && <div style={{ color: colors.textMuted, fontSize: 12 }}>Showing only the newest posts.</div>}
        {feed?.posts.map((p, i) => (
          <PostRow key={p.id} post={p} dayHeader={i === 0 || dayOf(p.atMs) !== dayOf(feed.posts[i - 1].atMs)} />
        ))}
      </section>
    </div>
  );
}
