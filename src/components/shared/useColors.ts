import { colors, colorsLight } from '../../styles/tokens';
import { useAetherStore } from '../../state/store';

export function useColors(): typeof colors {
  const { state } = useAetherStore();
  return (state.cfg.themeMode === 'light' ? colorsLight : colors) as typeof colors;
}
