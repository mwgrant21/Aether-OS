import { describe, expect, it } from 'vitest';
import { maximizeGlyph, maximizeLabel } from './windowControls';

describe('maximizeGlyph', () => {
  it('shows the restore glyph when maximized', () => {
    expect(maximizeGlyph(true)).toBe('❐');
  });

  it('shows the maximize glyph when not maximized', () => {
    expect(maximizeGlyph(false)).toBe('☐');
  });
});

describe('maximizeLabel', () => {
  it('labels as Restore when maximized', () => {
    expect(maximizeLabel(true)).toBe('Restore');
  });

  it('labels as Maximize when not maximized', () => {
    expect(maximizeLabel(false)).toBe('Maximize');
  });
});
