import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Marks a notifications trigger. Button takes no data props, so this goes on a
 * wrapper: the bell's wrapper div in TopBar, a `display: contents` span around
 * the STANDBY STRIP's Alerts button. A pointer-down inside any marked element
 * is not "outside": otherwise pointer-down would close the panel and the
 * trigger's click would reopen it.
 */
export const NOTIF_TRIGGER_ATTR = 'data-notif-trigger';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DropdownFocusOptions {
  open: boolean;
  panelRef: RefObject<HTMLElement>;
  triggerAttr: string;
  /** Where focus returns when the trigger that opened the panel has unmounted. */
  fallbackTrigger: () => HTMLElement | null;
  close: () => void;
}

/**
 * Focus management for a disclosure panel with more than one trigger.
 * - Open: remember the focused trigger, then focus the panel's first focusable
 *   element, else the panel itself (give it tabIndex={-1}).
 * - Close: return focus to that trigger (or fallbackTrigger() if it has gone),
 *   but only when focus would otherwise be lost (on <body> or detached, as
 *   when the panel that held it unmounts). If the user activated another
 *   control -- e.g. the approvals button, whose TOGGLE_APPROVALS closes this
 *   panel -- focus stays there.
 * - While open: Escape closes; a pointer-down outside the panel and outside
 *   every triggerAttr element closes.
 */
export function useDropdownFocus({ open, panelRef, triggerAttr, fallbackTrigger, close }: DropdownFocusOptions): void {
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  // Layout effect: runs after the panel mounts or unmounts but before paint.
  useLayoutEffect(() => {
    if (open === wasOpenRef.current) return;
    wasOpenRef.current = open;
    if (open) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      const panel = panelRef.current;
      if (panel) (panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel).focus();
      return;
    }
    const opener = openerRef.current;
    openerRef.current = null;
    const active = document.activeElement;
    const focusLost = active === null || active === document.body || !active.isConnected;
    if (!focusLost) return;
    const target = opener !== null && opener.isConnected ? opener : fallbackTrigger();
    target?.focus();
  }, [open, panelRef, fallbackTrigger]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
    }
    function onPointerDown(e: Event) {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(`[${triggerAttr}]`)) return;
      close();
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, panelRef, triggerAttr, close]);
}
