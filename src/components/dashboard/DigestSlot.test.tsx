import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { DigestSlot, DIGEST_EXIT_MS } from './DigestSlot';

function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
}
const slot = (present: boolean) => (
  <DigestSlot present={present}>
    <div>panel</div>
  </DigestSlot>
);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('DigestSlot', () => {
  it('renders nothing while its digest has no data, and a steady panel when it has data from the start', () => {
    stubReducedMotion(false);
    const { unmount } = render(slot(false));
    expect(screen.queryByText('panel')).toBeNull();
    unmount();
    render(slot(true));
    expect(screen.getByTestId('digest-slot').dataset.phase).toBe('steady');
  });

  it('enters with the digestEnter animation when its digest gains data', () => {
    stubReducedMotion(false);
    const { rerender } = render(slot(false));
    rerender(slot(true));
    expect(screen.getByTestId('digest-slot').dataset.phase).toBe('entering');
  });

  it('fades out on opacity and transform only, then unmounts after motion.duration.slow', () => {
    stubReducedMotion(false);
    const { rerender } = render(slot(true));
    rerender(slot(false));
    const el = screen.getByTestId('digest-slot');
    expect(el.dataset.phase).toBe('leaving');
    expect(el.style.opacity).toBe('0');
    expect(el.style.transition).toContain('opacity');
    expect(el.style.transition).toContain('transform');
    expect(el.style.transition).not.toContain('height');
    act(() => {
      vi.advanceTimersByTime(DIGEST_EXIT_MS - 1);
    });
    expect(screen.getByText('panel')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('panel')).toBeNull();
  });

  it('releases its flex share while leaving, and holds flex 1 1 0 while steady', () => {
    stubReducedMotion(false);
    const { rerender } = render(slot(true));
    expect(screen.getByTestId('digest-slot').style.flex).toBe('1 1 0px');
    rerender(slot(false));
    const el = screen.getByTestId('digest-slot');
    expect(el.style.position).toBe('absolute');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('under reduced motion appears and disappears without animating', () => {
    stubReducedMotion(true);
    const { rerender } = render(slot(false));
    rerender(slot(true));
    expect(screen.getByTestId('digest-slot').dataset.phase).toBe('steady');
    rerender(slot(false));
    expect(screen.queryByText('panel')).toBeNull();
  });

  it('stays mounted when its digest regains data mid-exit', () => {
    stubReducedMotion(false);
    const { rerender } = render(slot(true));
    rerender(slot(false));
    act(() => {
      vi.advanceTimersByTime(DIGEST_EXIT_MS / 2);
    });
    rerender(slot(true));
    act(() => {
      vi.advanceTimersByTime(DIGEST_EXIT_MS);
    });
    expect(screen.getByText('panel')).toBeTruthy();
  });
});
