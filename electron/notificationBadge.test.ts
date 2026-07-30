import { describe, it, expect } from 'vitest';
import { renderNotificationBadge } from './notificationBadge';

describe('renderNotificationBadge', () => {
  it('returns a square RGBA buffer of the requested size', () => {
    const badge = renderNotificationBadge(16);
    expect(badge.width).toBe(16);
    expect(badge.height).toBe(16);
    expect(badge.buffer.length).toBe(16 * 16 * 4);
  });

  it('renders an opaque, non-transparent pixel at the center', () => {
    const badge = renderNotificationBadge(16);
    const centerIdx = (8 * 16 + 8) * 4;
    expect(badge.buffer[centerIdx + 3]).toBe(255); // alpha channel: fully opaque
  });

  it('renders a fully transparent pixel at the corner (outside the circle)', () => {
    const badge = renderNotificationBadge(16);
    const cornerIdx = (0 * 16 + 0) * 4;
    expect(badge.buffer[cornerIdx + 3]).toBe(0); // alpha channel: fully transparent
  });
});
