/** Pure mapping from window maximize state to the restore/maximize control's glyph + tooltip. */
export function maximizeGlyph(isMaximized: boolean): string {
  return isMaximized ? '❐' : '☐';
}

export function maximizeLabel(isMaximized: boolean): string {
  return isMaximized ? 'Restore' : 'Maximize';
}
