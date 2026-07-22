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
  /** Renders the trigger element inline — spread the given props onto it. */
  trigger: (props: PopoverTriggerProps) => ReactNode;
  /** Renders the panel content; call `close()` from inside to dismiss. */
  children: (close: () => void) => ReactNode;
  /** Which edge of the panel anchors to the trigger. Defaults to `end` (right-aligned). */
  align?: PopoverAlign;
  /**
   * ARIA role shared by the trigger's `aria-haspopup` and the panel — `menu`
   * for action lists (profile menu), `dialog` for richer, non-menu content
   * (e.g. a notification feed). Defaults to `menu`.
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

function computePosition(trigger: HTMLElement, offset: number): Position {
  const rect = trigger.getBoundingClientRect();
  return {
    top: rect.bottom + offset,
    left: Math.max(VIEWPORT_MARGIN, rect.left),
    right: Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right),
  };
}

/**
 * Popover — accessible, anchored floating panel rendered through a portal to
 * `document.body`. Backs both the profile menu and the notification bell.
 *
 * Renders `fixed`-positioned from the trigger's live `getBoundingClientRect()`
 * (recomputed on open, and on window resize/scroll while open) rather than
 * `position: absolute`, because the TopBar header uses `backdrop-blur-md`,
 * which clips `absolute` descendants — an anchored dropdown living inside it
 * would be cut off at the header's bottom edge.
 *
 * The trigger element is tracked in state (a measure-on-mount callback ref
 * feeding `useState`) rather than a plain `useRef`, so the render-time
 * `trigger(triggerProps)` call never hands a ref-mutating closure to code
 * outside this component.
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
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const recomputePosition = useCallback(() => {
    if (!triggerEl) return;
    setPosition(computePosition(triggerEl, offset));
  }, [triggerEl, offset]);

  const close = useCallback(() => setOpen(false), []);

  // Measure synchronously in the click handler (not an effect body) — the
  // React Compiler's set-state-in-effect rule disallows calling setState
  // directly inside a `useEffect`, so the *initial* position is computed
  // here; the effect below only reacts to genuine resize/scroll events.
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

  // Outside pointerdown + Escape both dismiss.
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
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close, triggerEl]);

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
            ref={panelRef}
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
