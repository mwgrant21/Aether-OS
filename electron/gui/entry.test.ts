// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { guiVariantEnabled, rendererEntryName } from './entry';

describe('guiVariantEnabled / rendererEntryName', () => {
  it.each([undefined, '', '0', 'true', '1 '])('AETHER_GUI=%j keeps the default entry', (v) => {
    const env = { AETHER_GUI: v } as NodeJS.ProcessEnv;
    expect(guiVariantEnabled(env)).toBe(false);
    expect(rendererEntryName(env)).toBe('index.html');
  });

  it('AETHER_GUI=1 selects gui.html', () => {
    const env = { AETHER_GUI: '1' } as NodeJS.ProcessEnv;
    expect(guiVariantEnabled(env)).toBe(true);
    expect(rendererEntryName(env)).toBe('gui.html');
  });
});

describe('gui.html', () => {
  it('titles the window Aether Chat', () => {
    const html = readFileSync(new URL('../../gui.html', import.meta.url), 'utf8');
    expect(html).toContain('<title>Aether Chat</title>');
  });
});
