import { colors, colorsLight, type ColorPalette } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function useColors(): ColorPalette {
  const { state } = useAetherStore();
  return state.cfg.themeMode === 'light' ? colorsLight : colors;
}
