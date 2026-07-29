import { PermissionRequestCard } from './PermissionRequestCard';
import { PostToolFlagCard } from './PostToolFlagCard';
import { useElementHeight } from '../shared/useElementHeight';

const TOP = 16;
const GAP = 14;

// Owns the vertical stacking of the two independently-pending approval cards.
// PermissionRequestCard's rendered height is genuinely variable (editable
// field expanded, deny-reason box open, a long tool name wrapping) -- a fixed
// pixel guess for PostToolFlagCard's offset was found to be fragile against
// realistic tall states, so this measures the real DOM height live via
// useElementHeight (ResizeObserver-backed) and computes PostToolFlagCard's
// `top` from it directly: PermissionRequestCard's own top (16) + its measured
// height + a gap. When no PermissionRequestCard is mounted, PostToolFlagCard
// falls back to its own default top (16).
export function PermissionCardStack() {
  const [measureRef, permissionCardHeight] = useElementHeight();
  const flagCardTop = permissionCardHeight !== null ? TOP + permissionCardHeight + GAP : TOP;

  return (
    <>
      <PermissionRequestCard measureRef={measureRef} />
      <PostToolFlagCard topOffset={flagCardTop} />
    </>
  );
}
