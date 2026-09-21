import { colors, type ColorPalette } from '../../styles/tokens';

// Light mode was removed 2026-09-18 (it was never used, and could not work:
// global.css hardcoded the dark palette, so the page background never
// followed the toggle). This stays a hook so its 69 call sites are
// untouched, and so a future palette switch has somewhere to live again.
export function useColors(): ColorPalette {
  return colors;
}
