import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';

export type PopoverAlign = 'start' | 'end';

/** Props the caller wires onto whatever element renders the trigger. */
export interface PopoverTriggerProps {
  /** Assign as `ref={props.setRef}` on the trigger's host element. */
  setRef: (node: HTMLElement | null) => void;
  onClick: () => void;
  'aria-haspopup': 'menu' | 'dialog';
  'aria-expanded': boolean;
  'aria-controls': string;
}

export interface PopoverProps {
  /** Renders the trigger element inline - spread the given props onto it. */
  trigger: (props: PopoverTriggerProps) => ReactNode;
  /** Renders the panel content; call `close()` from inside to dismiss. */
  children: (close: () => void) => ReactNode;
  /** Which edge of the panel anchors to the trigger. Defaults to `end` (right-aligned). */
  align?: PopoverAlign;
  /**
   * ARIA role shared by the trigger's `aria-haspopup` and the panel - `menu`
   * for action lists (profile menu), `dialog` for richer, non-menu content
   * (e.g. a notification feed). Defaults to `menu`. `menu` also enables
   * ArrowUp/ArrowDown roving between the panel's focusable items.
   */
  role?: 'menu' | 'dialog';
  /** Extra classes merged onto the panel wrapper. */
  panelClassName?: string;
  /** Gap in px between the trigger and the panel. Defaults to 8. */
  offset?: number;
}

interface Position {
  top: number;
  left: number;
  /** Distance from the viewport's right edge to the trigger's right edge. */
  right: number;
}

const VIEWPORT_MARGIN = 8;

const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Visible, tabbable descendants of the panel, in DOM order. */
function getFocusable(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (node) => node.offsetParent !== null || node === document.activeElement,
  );
}

/**
 * Anchor the panel to the trigger. Horizontal: clamp `left`/`right` into the
 * viewport. Vertical: open below by default, flip above when the panel would
 * overflow the bottom edge and there's room above, otherwise clamp `top` so
 * the panel stays fully on-screen. `panelHeight` is 0 on the first pass
 * (panel not yet measured) - that resolves to the plain "below" placement,
 * which the post-mount re-measure then corrects before paint.
 */
function computePosition(trigger: HTMLElement, panelHeight: number, offset: number): Position {
  const rect = trigger.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const spaceBelow = viewportHeight - rect.bottom - offset - VIEWPORT_MARGIN;
  const spaceAbove = rect.top - offset - VIEWPORT_MARGIN;

  let top: number;
  if (panelHeight <= 0 || panelHeight <= spaceBelow) {
    top = rect.bottom + offset;
  } else if (panelHeight <= spaceAbove) {
    top = rect.top - offset - panelHeight;
  } else {
    top = Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - panelHeight);
  }

  return {
    top,
    left: Math.max(VIEWPORT_MARGIN, rect.left),
    right: Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right),
  };
}

/**
 * Popover - accessible, anchored floating panel rendered through a portal to
 * `document.body`. Backs both the profile menu and the notification bell.
 *
 * Renders `fixed`-positioned from the trigger's live `getBoundingClientRect()`
 * (recomputed on open, and on window resize/scroll while open) rather than
 * `position: absolute`, because the TopBar header uses `backdrop-blur-md`,
 * which clips `absolute` descendants - an anchored dropdown living inside it
 * would be cut off at the header's bottom edge.
 *
 * Once open the panel is a focus trap: focus moves into it on open, Tab /
 * Shift+Tab cycle within it (wrapping at the ends), Escape and outside-click
 * dismiss, and focus is restored to the trigger on close. The trigger element
 * is tracked in state (a callback ref feeding `useState`) rather than a plain
 * `useRef`, so the render-time `trigger(triggerProps)` call never hands a
 * ref-mutating closure to code outside this component.
 */
export function Popover({
  trigger,
  children,
  align = 'end',
  role = 'menu',
  panelClassName,
  offset = 8,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const [triggerEl, setTriggerEl] = useState<HTMLElement | null>(null);
  // The measured panel height, kept in state (not read off the ref) so the
  // click-reachable `recomputePosition`/`toggle` never touch a ref during a
  // render-reachable path - that trips the React Compiler's ref-safety rule.
  const [panelHeight, setPanelHeight] = useState(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const recomputePosition = useCallback(() => {
    if (!triggerEl) return;
    setPosition(computePosition(triggerEl, panelHeight, offset));
  }, [triggerEl, panelHeight, offset]);

  // Callback ref: capture the panel node AND measure it once mounted, so the
  // vertical flip/clamp uses the panel's real height. Runs in the commit phase
  // (before paint), so the corrected placement never flickers. Measures the
  // node param directly (not `panelRef.current`), keeping the render-reachable
  // path ref-free; stable across position updates, so it does not re-fire on
  // every reposition.
  const setPanelRef = useCallback(
    (node: HTMLDivElement | null) => {
      panelRef.current = node;
      if (node && triggerEl) {
        const measured = node.offsetHeight;
        setPanelHeight(measured);
        setPosition(computePosition(triggerEl, measured, offset));
      }
    },
    [triggerEl, offset],
  );

  const close = useCallback(() => setOpen(false), []);

  // Measure the trigger synchronously in the click handler (not an effect
  // body) so the panel's initial "below" placement is ready on the first
  // render; the post-mount callback ref then applies the flip/clamp.
  const toggle = useCallback(() => {
    if (!open) recomputePosition();
    setOpen((wasOpen) => !wasOpen);
  }, [open, recomputePosition]);

  // Keep the panel pinned to the trigger while it's open and the page scrolls/resizes.
  useEffect(() => {
    if (!open) return undefined;
    const onReposition = (): void => recomputePosition();
    window.addEventListener('resize', onReposition);
    // `capture: true` so scrolling any ancestor (not just the window) repositions the panel.
    window.addEventListener('scroll', onReposition, true);
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open, recomputePosition]);

  // Outside pointerdown dismisses; Escape dismisses; Tab is trapped inside the
  // panel; ArrowUp/Down rove between items when `role="menu"`.
  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (triggerEl?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return;
      }
      const panel = panelRef.current;
      if (!panel) return;

      if (event.key === 'Tab') {
        const nodes = getFocusable(panel);
        if (nodes.length === 0) {
          // Nothing tabbable - keep focus on the panel itself.
          event.preventDefault();
          panel.focus();
          return;
        }
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = document.activeElement;
        if (event.shiftKey) {
          if (active === first || active === panel) {
            event.preventDefault();
            last.focus();
          }
        } else if (active === last || active === panel) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      if (role === 'menu' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        const nodes = getFocusable(panel);
        if (nodes.length === 0) return;
        event.preventDefault();
        const active = document.activeElement as HTMLElement | null;
        const currentIndex = active ? nodes.indexOf(active) : -1;
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = (currentIndex + delta + nodes.length) % nodes.length;
        nodes[nextIndex].focus();
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close, triggerEl, role]);

  // Focus the panel on open; restore focus to the trigger on close.
  useEffect(() => {
    if (!open) return undefined;
    const raf = requestAnimationFrame(() => panelRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      triggerEl?.focus();
    };
  }, [open, triggerEl]);

  const triggerProps: PopoverTriggerProps = {
    setRef: setTriggerEl,
    onClick: toggle,
    'aria-haspopup': role,
    'aria-expanded': open,
    'aria-controls': panelId,
  };

  return (
    <>
      {trigger(triggerProps)}
      {open &&
        position &&
        createPortal(
          <div
            ref={setPanelRef}
            id={panelId}
            role={role}
            tabIndex={-1}
            style={{
              position: 'fixed',
              top: position.top,
              ...(align === 'end' ? { right: position.right } : { left: position.left }),
            }}
            className={cn(
              'z-50 min-w-[16rem] overflow-hidden rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-lg)]',
              'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
              panelClassName,
            )}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  );
}
