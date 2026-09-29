import type { CSSProperties } from 'react';

// Visually hidden but still reachable by assistive tech / aria-live -- the
// standard clip-based pattern (not display:none, which would also hide it
// from the accessibility tree). Shared so every visually-hidden label
// (TopBar's live counts, AppShell's page heading) uses the same recipe.
export const srOnlyStyle: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};
