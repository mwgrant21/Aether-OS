import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useElementHeight } from './useElementHeight';

// jsdom has no ResizeObserver by default -- this fake lets the test drive the
// observer's callback directly to simulate a real content-size change (e.g.
// PermissionRequestCard's deny-reason box opening), which real pixel layout
// in jsdom cannot produce on its own.
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  callback: ResizeObserverCallback;
  observed: Element[] = [];
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.observed = [];
  }
  unobserve() {}
}

describe('useElementHeight', () => {
  let originalRO: unknown;

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    originalRO = (global as any).ResizeObserver;
    (global as any).ResizeObserver = FakeResizeObserver;
  });

  afterEach(() => {
    (global as any).ResizeObserver = originalRO;
  });

  it('starts at null before any node is attached', () => {
    const { result } = renderHook(() => useElementHeight());
    expect(result.current[1]).toBeNull();
  });

  it('reports the initial height via getBoundingClientRect when a node mounts', () => {
    const { result } = renderHook(() => useElementHeight());
    const el = document.createElement('div');
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ height: 120 } as DOMRect);

    act(() => result.current[0](el));

    expect(result.current[1]).toBe(120);
  });

  it('updates height when the ResizeObserver callback fires with a new contentRect', () => {
    const { result } = renderHook(() => useElementHeight());
    const el = document.createElement('div');
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ height: 120 } as DOMRect);
    act(() => result.current[0](el));

    const observer = FakeResizeObserver.instances[0];
    act(() => {
      observer.callback([{ contentRect: { height: 208 } } as ResizeObserverEntry], observer as unknown as ResizeObserver);
    });

    expect(result.current[1]).toBe(208);
  });

  it('resets to null and disconnects when the ref is called with null (unmount)', () => {
    const { result } = renderHook(() => useElementHeight());
    const el = document.createElement('div');
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ height: 120 } as DOMRect);
    act(() => result.current[0](el));
    const observer = FakeResizeObserver.instances[0];

    act(() => result.current[0](null));

    expect(result.current[1]).toBeNull();
    expect(observer.observed).toEqual([]);
  });
});
