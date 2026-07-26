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
    expect(result.current.style.borderColor).toBe(colors.activeBorder);
  });
});
