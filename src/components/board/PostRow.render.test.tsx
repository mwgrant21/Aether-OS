import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PostRow } from './PostRow';
import { colorOf } from '../../shared/board/identity';
import type { BoardParty, BoardPost } from '../../shared/board/types';

const main: BoardParty = { kind: 'main', name: 'main', agentId: null };
const agent = (name: string, agentId: string | null): BoardParty => ({ kind: 'agent', name, agentId });

function mk(over: Partial<BoardPost> = {}): BoardPost {
  const body = over.body ?? 'hello';
  return { id: 'p', atMs: Date.UTC(2026, 9, 20, 12, 0, 0), kind: 'message', from: main, to: agent('builder', null), startedBy: null, subject: null, body, bodyLength: body.length, truncated: false, status: null, ...over };
}
// jsdom normalises inline hsl() to rgb(); compare via a probe element so the test does not hard-code the format.
function css(color: string): string {
  const el = document.createElement('div');
  el.style.color = color;
  return el.style.color;
}
afterEach(cleanup);

describe('PostRow', () => {
  it('avatar shows initials and avatar + name share the key colour', () => {
    render(<PostRow post={mk({ from: agent('general-purpose', 'a1') })} />);
    expect(screen.getByTestId('avatar').textContent).toBe('GP');
    expect(screen.getByTestId('avatar').style.background).toBe(css(colorOf('a1')));
    expect(screen.getByTestId('sender').style.color).toBe(css(colorOf('a1')));
  });

  it('same role name with different agent ids renders different colours', () => {
    render(<><PostRow post={mk({ id: '1', from: agent('general-purpose', 'a1') })} /><PostRow post={mk({ id: '2', from: agent('general-purpose', 'a2') })} /></>);
    const [x, y] = screen.getAllByTestId('sender');
    expect(x.style.color).not.toBe(y.style.color);
  });

  it('shows "started by" only when set', () => {
    const { rerender } = render(<PostRow post={mk()} />);
    expect(screen.queryByText(/started by/)).toBeNull();
    rerender(<PostRow post={mk({ startedBy: 'builder' })} />);
    expect(screen.getByText('started by builder')).toBeTruthy();
  });

  it('recipient chips: @all, @unknown, @refuter', () => {
    const { rerender } = render(<PostRow post={mk({ to: { kind: 'all', name: 'all', agentId: null } })} />);
    expect(screen.getByText('@all')).toBeTruthy();
    rerender(<PostRow post={mk({ to: { kind: 'unknown', name: 'unknown', agentId: null } })} />);
    expect(screen.getByText('@unknown')).toBeTruthy();
    rerender(<PostRow post={mk({ to: agent('refuter', 'r1') })} />);
    expect(screen.getByText('@refuter')).toBeTruthy();
  });

  it('failed and killed show a status chip, completed does not', () => {
    const { rerender } = render(<PostRow post={mk({ kind: 'handback', status: 'failed' })} />);
    expect(screen.getByTestId('status-chip').textContent).toBe('failed');
    rerender(<PostRow post={mk({ kind: 'handback', status: 'killed' })} />);
    expect(screen.getByTestId('status-chip').textContent).toBe('killed');
    rerender(<PostRow post={mk({ kind: 'handback', status: 'completed' })} />);
    expect(screen.queryByTestId('status-chip')).toBeNull();
  });

  it('a 400-char body previews 280 chars plus an ellipsis; Show more reveals all and Show less restores', () => {
    const body = 'x'.repeat(400);
    render(<PostRow post={mk({ body })} />);
    expect(screen.getByTestId('body').textContent).toBe('x'.repeat(280) + '…');
    const btn = screen.getByRole('button', { name: 'Show more' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(screen.getByTestId('body').textContent).toBe(body);
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.getByTestId('body').textContent).toBe('x'.repeat(280) + '…');
  });

  it('a short body has no toggle', () => {
    render(<PostRow post={mk({ body: 'x'.repeat(280) })} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('body').textContent).toBe('x'.repeat(280));
  });

  it('shows the truncation note only when truncated', () => {
    const { rerender } = render(<PostRow post={mk()} />);
    expect(screen.queryByText(/Showing first/)).toBeNull();
    rerender(<PostRow post={mk({ body: 'abc', bodyLength: 9000, truncated: true })} />);
    expect(screen.getByText('Showing first 3 of 9000 characters.')).toBeTruthy();
  });

  it('renders masked text verbatim', () => {
    render(<PostRow post={mk({ body: 'key=[redacted] and <b>tag</b>' })} />);
    expect(screen.getByTestId('body').textContent).toBe('key=[redacted] and <b>tag</b>');
  });

  it('kind tags: dispatch, message, hand-back', () => {
    const { rerender } = render(<PostRow post={mk({ kind: 'dispatch' })} />);
    expect(screen.getByText('dispatch')).toBeTruthy();
    rerender(<PostRow post={mk({ kind: 'message' })} />);
    expect(screen.getByText('message')).toBeTruthy();
    rerender(<PostRow post={mk({ kind: 'handback' })} />);
    expect(screen.getByText('hand-back')).toBeTruthy();
  });

  it('time carries the ISO string in title', () => {
    render(<PostRow post={mk()} />);
    expect(document.querySelector('[title="2026-10-20T12:00:00.000Z"]')).not.toBeNull();
  });
});
