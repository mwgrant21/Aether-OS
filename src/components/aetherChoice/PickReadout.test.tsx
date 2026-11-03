import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PickReadout, TierTag, readoutStyle, PULSE_CLASS } from './PickReadout';
import { TIER_TABLE } from '../../shared/aetherChoice/tiers';
import type { TierId } from '../../shared/aetherChoice/types';

afterEach(cleanup);

const TIERS = Object.keys(TIER_TABLE) as TierId[];
const base = { tier: 'sonnet' as TierId, effort: 'medium' as const, reason: 'default', auto: false };

describe('TierTag', () => {
  it.each(TIERS)('%s renders its name text and the locked filled-bar count', (tier) => {
    const { container } = render(<TierTag tier={tier} />);
    expect(screen.getByText(tier)).toBeTruthy();
    const filled = container.querySelectorAll('[data-filled="true"]').length;
    expect(filled).toBe(TIER_TABLE[tier].bars);
    if (TIER_TABLE[tier].glyph === 'bars') {
      expect(container.querySelectorAll('[data-filled]').length).toBe(4);
    }
  });

  it('draws unfilled bars at 30% opacity and the glyph is aria-hidden', () => {
    const { container } = render(<TierTag tier="haiku" />);
    const bars = container.querySelectorAll<HTMLElement>('[data-filled]');
    expect(bars[0].style.opacity).toBe('1');
    expect(bars[1].style.opacity).toBe('0.3');
    expect(container.querySelector('[data-glyph]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('design renders a sparkle and no bars', () => {
    const { container } = render(<TierTag tier="design" />);
    expect(container.querySelector('[data-glyph="sparkle"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-filled]').length).toBe(0);
  });

  it('fable is a solid silver tag with dark text', () => {
    const { container } = render(<TierTag tier="fable" />);
    const el = container.querySelector<HTMLElement>('[data-tier="fable"]')!;
    expect(el.style.background).toBe('rgb(213, 221, 230)');
    expect(el.style.color).toBe('rgb(3, 7, 13)');
  });
});

describe('readoutStyle', () => {
  const rm = { reducedMotion: false };
  it('steady has no glow', () => {
    const s = readoutStyle('steady', rm);
    expect(s.boxShadow).toBeUndefined();
    expect(s.opacity).toBe(1);
  });
  it('queued states are 50% opacity with no glow', () => {
    for (const st of ['queued', 'queuedModel'] as const) {
      const s = readoutStyle(st, rm);
      expect(s.opacity).toBe(0.5);
      expect(s.boxShadow).toBeUndefined();
    }
  });
  it('applying and unconfirmed are cyan', () => {
    expect(readoutStyle('applying', rm).color).toBe('#5be6ff');
    expect(readoutStyle('unconfirmed', rm).color).toBe('#5be6ff');
  });
  it('blocked is amber, steady 10px/.30 glow, never animated', () => {
    const s = readoutStyle('blocked', rm);
    expect(s.color).toBe('#ffb454');
    expect(s.boxShadow).toBe('0 0 10px rgba(255,180,84,.30)');
    expect(s.animation).toBe('none');
  });
  it('notApplied is red with 18px/.85 glow and the pulse; none under reduced motion', () => {
    const s = readoutStyle('notApplied', rm);
    expect(s.color).toBe('#ff5c57');
    expect(s.boxShadow).toBe('0 0 18px rgba(255,92,87,.85)');
    expect(s.animation).toContain('aetherChoicePulse');
    expect(s.animation).toContain('2.4s');
    expect(readoutStyle('notApplied', { reducedMotion: true }).animation).toBe('none');
  });
});

describe('PickReadout', () => {
  it('notApplied gets the pulse class; blocked does not', () => {
    const { container, rerender } = render(<PickReadout {...base} state="notApplied" />);
    expect(container.firstElementChild?.classList.contains(PULSE_CLASS)).toBe(true);
    rerender(<PickReadout {...base} state="blocked" />);
    expect(container.firstElementChild?.classList.contains(PULSE_CLASS)).toBe(false);
  });
  it('unconfirmed says sent and never applied', () => {
    const { container } = render(<PickReadout {...base} state="unconfirmed" />);
    expect(container.textContent).toContain('sent');
    expect(container.textContent).not.toMatch(/applied/i);
  });
  it('queued shows the next pick', () => {
    render(<PickReadout {...base} state="queued" target={{ tier: 'opus', effort: 'high' }} />);
    expect(screen.getByText('next: opus / high')).toBeTruthy();
  });
  it('queuedModel shows the resume text', () => {
    render(<PickReadout {...base} state="queuedModel" target={{ tier: 'opus', effort: 'high' }} />);
    expect(screen.getByText('model change applies at next resume: opus')).toBeTruthy();
  });
  it('auto adds a visible auto mark; manual does not', () => {
    const { rerender } = render(<PickReadout {...base} state="steady" auto />);
    expect(screen.getByText('auto')).toBeTruthy();
    rerender(<PickReadout {...base} state="steady" auto={false} />);
    expect(screen.queryByText('auto')).toBeNull();
  });
  it('fable renders in the disabled-row state: 50% opacity, no glow, aria-disabled', () => {
    const { container } = render(<PickReadout {...base} tier="fable" state="notApplied" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute('aria-disabled')).toBe('true');
    expect(el.style.opacity).toBe('0.5');
    expect(el.style.boxShadow).toBe('');
    expect(el.classList.contains(PULSE_CLASS)).toBe(false);
  });
});

describe('aetherChoice.css', () => {
  const css = readFileSync(join(__dirname, 'aetherChoice.css'), 'utf8');
  it('defines the 2.4s pulse keyframes with locked endpoints', () => {
    expect(css).toContain('@keyframes aetherChoicePulse');
    expect(css).toContain('2.4s');
    expect(css).toContain('18px rgba(255, 92, 87, 0.85)');
    expect(css).toContain('8px rgba(255, 92, 87, 0.4)');
  });
  it('turns the pulse off under prefers-reduced-motion', () => {
    const m = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?animation:\s*none/);
    expect(m).not.toBeNull();
  });
});
