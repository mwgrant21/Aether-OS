// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { diagMessage, throttle } from './pageDiag.js';

describe('diagMessage', () => {
  it('builds the fixed shape for a mouse pointer event', () => {
    expect(diagMessage('p', 'down', { pointerType: 'mouse', button: 0, buttons: 1, clientX: 10.6, clientY: 20.2 }))
      .toEqual({ t: 'diag', k: 'p', a: 'down', pt: 'mouse', b: 0, bs: 1, dx: 0, dy: 0, dm: 0, x: 11, y: 20, n: 0 });
  });
  it('reads wheel deltas and clamps everything', () => {
    const m = diagMessage('w', 'wheel', { deltaX: 1e9, deltaY: -1e9, deltaMode: 7, clientX: -99999, clientY: 99999, button: 99, buttons: 999 });
    expect(m).toMatchObject({ dx: 100000, dy: -100000, dm: 2, x: -10000, y: 20000, b: 31, bs: 63 });
  });
  it('maps an unknown pointerType to the empty string', () => {
    expect(diagMessage('p', 'move', { pointerType: 'laser' }).pt).toBe('');
    expect(diagMessage('p', 'move', {}).pt).toBe('');
  });
  it('touch events report the touch count and first-touch position', () => {
    const m = diagMessage('t', 'move', { touches: [{ clientX: 5, clientY: 6 }, { clientX: 1, clientY: 1 }] });
    expect(m).toMatchObject({ k: 't', n: 2, x: 5, y: 6 });
  });
  it('non-finite numbers become 0', () => {
    expect(diagMessage('p', 'move', { clientX: NaN, deltaY: Infinity })).toMatchObject({ x: 0, dy: 0 });
  });
  it('never carries key, data, target or value', () => {
    const ev = { key: 'KEYSECRET', data: 'DATASECRET', target: { textContent: 'TARGETSECRET' }, value: 'VALUESECRET', pointerType: 'KEYSECRET' };
    const s = JSON.stringify(diagMessage('p', 'down', ev));
    for (const w of ['KEYSECRET', 'DATASECRET', 'TARGETSECRET', 'VALUESECRET']) expect(s).not.toContain(w);
  });
});

describe('throttle', () => {
  it('limits moves to one per 40 ms', () => {
    expect(throttle(1000, 1039, 'move')).toBe(false);
    expect(throttle(1000, 1040, 'move')).toBe(true);
  });
  it('never throttles down, up, cancel or wheel', () => {
    for (const a of ['down', 'up', 'cancel', 'wheel']) expect(throttle(1000, 1001, a)).toBe(true);
  });
});
