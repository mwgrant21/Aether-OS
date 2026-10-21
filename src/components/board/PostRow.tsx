import { useState } from 'react';
import { Button } from '../shared/Button';
import { useColors } from '../shared/useColors';
import { fonts } from '../../styles/tokens';
import { colorKeyOf, colorOf, initialsOf, recipientChip } from '../../shared/board/identity';
import type { BoardPost } from '../../shared/board/types';

const PREVIEW_CHARS = 280;
const KIND_TAG: Record<BoardPost['kind'], string> = { dispatch: 'dispatch', message: 'message', handback: 'hand-back' };

export function PostRow({ post, dayHeader }: { post: BoardPost; dayHeader?: boolean }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const hue = colorOf(colorKeyOf(post.from));
  const cut = post.body.length > PREVIEW_CHARS;
  const shown = cut && !open ? `${post.body.slice(0, PREVIEW_CHARS)}…` : post.body;
  const when = new Date(post.atMs);
  const tag = { fontSize: 11, padding: '1px 6px', border: `1px solid ${colors.chipBorder}`, background: colors.panelInset, color: colors.textMuted };
  const bad = post.status === 'failed' || post.status === 'killed';

  return (
    <>
      {dayHeader && (
        <div data-testid="day-header" style={{ fontSize: 12, color: colors.textMuted, padding: '8px 0 2px', fontFamily: fonts.ui }}>
          {when.toLocaleDateString()}
        </div>
      )}
      <article data-testid="post" style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: `1px solid ${colors.chipBorder}` }}>
        <div
          data-testid="avatar"
          aria-hidden="true"
          style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: colors.inkOnCyan, background: hue }}
        >
          {initialsOf(post.from.name)}
        </div>
        <div style={{ minWidth: 0, flex: 1, display: 'grid', gap: 3 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12 }}>
            <strong data-testid="sender" style={{ color: hue }}>{post.from.name}</strong>
            {post.startedBy && <span style={{ color: colors.textMuted }}>started by {post.startedBy}</span>}
            <span title={when.toISOString()} style={{ color: colors.textMuted }}>{when.toLocaleTimeString()}</span>
            <span style={tag}>{KIND_TAG[post.kind]}</span>
            <span style={tag}>{recipientChip(post.to)}</span>
            {bad && <span data-testid="status-chip" style={{ ...tag, color: colors.danger, borderColor: colors.danger }}>{post.status}</span>}
          </div>
          {post.subject && <div style={{ color: colors.textBody }}>{post.subject}</div>}
          <div data-testid="body" style={{ whiteSpace: 'pre-wrap', color: colors.textSecondary, overflowWrap: 'anywhere' }}>{shown}</div>
          {cut && (
            <Button aria-expanded={open} onClick={() => setOpen((v) => !v)} style={{ fontSize: 12, color: colors.accentCyan, justifySelf: 'start' }}>
              {open ? 'Show less' : 'Show more'}
            </Button>
          )}
          {post.truncated && (
            <div style={{ color: colors.textMuted, fontSize: 12 }}>Showing first {post.body.length} of {post.bodyLength} characters.</div>
          )}
        </div>
      </article>
    </>
  );
}
