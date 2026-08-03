import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useHoverStyle } from './useHoverStyle';
import { AetherStoreProvider } from '../../state/store';
import { colors } from '../../styles/tokens';

const wrapper = AetherStoreProvider;

describe('useHoverStyle', () => {
  it('returns base style when not hovering', () => {
    const { result } = renderHook(() => useHoverStyle({ color: 'red' }, { color: 'blue' }), { wrapper });
    expect(result.current.style).toEqual({ color: 'red' });
  });

  it('merges hover style over base on mouseEnter', () => {
    const { result } = renderHook(() => useHoverStyle({ color: 'red' }, { color: 'blue' }), { wrapper });
    act(() => result.current.onMouseEnter());
    expect(result.current.style).toEqual({ color: 'blue' });
  });

  it('reverts to base style on mouseLeave', () => {
    const { result } = renderHook(() => useHoverStyle({ color: 'red' }, { color: 'blue' }), { wrapper });
    act(() => result.current.onMouseEnter());
    act(() => result.current.onMouseLeave());
    expect(result.current.style).toEqual({ color: 'red' });
  });

  it('uses the default brightness/border hover when no override is passed', () => {
    const { result } = renderHook(() => useHoverStyle({ color: 'red' }), { wrapper });
    act(() => result.current.onMouseEnter());
    expect(result.current.style.filter).toBe('brightness(1.1)');
    // The shorthand `border` form (not the `borderColor` longhand) so it never
    // mixes shorthand/longhand with a base style's own `border: '...'`/`'none'` --
    // see useHoverStyle.ts's comment on the shorthand-mixing React warning.
    expect(result.current.style.border).toBe(`1px solid ${colors.activeBorder}`);
  });

  it('does not mix border shorthand and longhand with a base style that sets border', () => {
    // Regression check for the "mixing shorthand and non-shorthand properties"
    // React warning: a base style using the `border` shorthand (this repo's
    // documented Button convention) must not end up alongside a `borderColor`
    // longhand in the same merged style object during hover.
    const { result } = renderHook(() => useHoverStyle({ border: 'none' }), { wrapper });
    act(() => result.current.onMouseEnter());
    expect(result.current.style.borderColor).toBeUndefined();
    expect(result.current.style.border).toBe(`1px solid ${colors.activeBorder}`);
  });
});
