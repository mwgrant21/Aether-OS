// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { renderQrSvg } from './pairingQr';

describe('renderQrSvg', () => {
  it('returns a scriptless svg', () => {
    const svg = renderQrSvg('http://100.64.0.1:47821/pair#c=ABCD-EFGH');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toContain('<script');
  });

  it('is deterministic and input-dependent', () => {
    expect(renderQrSvg('a')).toBe(renderQrSvg('a'));
    expect(renderQrSvg('a')).not.toBe(renderQrSvg('b'));
  });
});
