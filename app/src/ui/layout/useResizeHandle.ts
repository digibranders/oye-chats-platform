import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/**
 * A draggable edge, and the one implementation of it.
 *
 * Two surfaces let the reader set a width and remember it: the inbox's list
 * pane and the lead drawer. They are the same control — a `role="separator"`
 * the user drags or nudges — and the second one was about to be a second copy
 * of the first, which is how the console ended up with five drawers and seven
 * toggles the first time round.
 *
 * Three things this owns that a hand-rolled handle gets wrong:
 *
 * - **Pointer capture.** The cursor leaves a 12px handle immediately; without
 *   capture the drag dies on the first fast movement. It is also the one DOM
 *   API jsdom does not implement, so a failure here must not take the drag, or
 *   a test, down with it.
 * - **Direction.** Arrow keys are physical and never remapped, but the pane
 *   they resize is placed with logical properties, which CSS mirrors under
 *   `dir="rtl"`. The key that widens is always the one pointing from the
 *   separator toward the pane's far edge, so the mapping flips with direction
 *   AND with which edge the handle sits on.
 * - **Storage.** A remembered width is a convenience. Private browsing, a full
 *   quota and a blocked origin all throw, and none of them is worth taking a
 *   surface down for: the drag still works, it is just not remembered.
 */

/** Which edge of the pane the handle sits on, in logical terms. */
export type ResizeEdge = 'start' | 'end';

export interface ResizeHandleOptions {
  /** Resting size, used until the reader moves it or storage answers. */
  initial: number;
  min: number;
  /** A number, or a function for a stop that depends on the viewport. */
  max: number | (() => number);
  /** Where the remembered size lives. Omit to forget it on unmount. */
  storageKey?: string;
  /**
   * The handle's edge. `end` for a pane at the inline-start of its container
   * (the inbox list); `start` for one at the inline-end (a drawer).
   */
  edge: ResizeEdge;
  /** Names the control for a screen reader. */
  label: string;
}

export interface ResizeHandleState {
  /** The current size in pixels, already clamped. */
  size: number;
  /** True while a pointer drag is in flight; style the handle from it. */
  dragging: boolean;
  /** Spread onto the element that measures the pane. */
  paneRef: (node: HTMLElement | null) => void;
  /** Spread onto the handle. Carries its role, its value and its listeners. */
  separatorProps: {
    role: 'separator';
    'aria-orientation': 'vertical';
    'aria-label': string;
    'aria-valuenow': number;
    'aria-valuemin': number;
    'aria-valuemax': number;
    tabIndex: 0;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  };
}

/** A nudge, and a nudge with shift held. */
const STEP = 16;
const STEP_FAST = 64;

function readStored(key: string | undefined): number | null {
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function useResizeHandle({
  initial,
  min,
  max,
  storageKey,
  edge,
  label,
}: ResizeHandleOptions): ResizeHandleState {
  const resolveMax = useCallback((): number => (typeof max === 'function' ? max() : max), [max]);

  const clamp = useCallback(
    (px: number): number => {
      // The ceiling can be below the floor on a narrow window — a 512px minimum
      // against a 900px viewport — and `Math.min` applied second would then win
      // and return a size under the floor. The floor is the one that matters:
      // a pane narrower than its minimum is unusable, a wide one is only tight.
      const ceiling = Math.max(min, resolveMax());
      return Math.min(ceiling, Math.max(min, Math.round(px)));
    },
    [min, resolveMax],
  );

  const [size, setSize] = useState<number>(() => clamp(readStored(storageKey) ?? initial));
  const [dragging, setDragging] = useState(false);
  const paneNode = useRef<HTMLElement | null>(null);
  const paneRef = useCallback((node: HTMLElement | null) => {
    paneNode.current = node;
  }, []);

  const commit = useCallback(
    (next: number) => {
      const value = clamp(next);
      setSize(value);
      if (!storageKey) return;
      try {
        window.localStorage.setItem(storageKey, String(value));
      } catch {
        // See the note on storage in the hook's own docs.
      }
    },
    [clamp, storageKey],
  );

  /**
   * Does the pane's fixed edge sit on the physical left?
   *
   * The handle is on one edge, so the opposite edge is pinned and the size is
   * the pointer's distance from it. Which physical side that is depends on both
   * the logical edge and the document's direction, and the same predicate
   * decides which arrow key widens.
   */
  const anchoredLeft = useCallback((): boolean => {
    const rtl = document.documentElement.dir === 'rtl';
    return (edge === 'end') !== rtl;
  }, [edge]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): void => {
      const step = event.shiftKey ? STEP_FAST : STEP;
      const growsRight = anchoredLeft();
      let next: number;
      if (event.key === 'ArrowRight') next = growsRight ? size + step : size - step;
      else if (event.key === 'ArrowLeft') next = growsRight ? size - step : size + step;
      else if (event.key === 'Home') next = min;
      else if (event.key === 'End') next = resolveMax();
      else return;
      event.preventDefault();
      commit(next);
    },
    [anchoredLeft, commit, min, resolveMax, size],
  );

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>): void => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* no capture available; the drag still tracks while the pointer is over the handle */
    }
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>): void => {
      if (!dragging) return;
      const rect = paneNode.current?.getBoundingClientRect();
      if (!rect) return;
      commit(anchoredLeft() ? event.clientX - rect.left : rect.right - event.clientX);
    },
    [anchoredLeft, commit, dragging],
  );

  const onPointerUp = useCallback((event: PointerEvent<HTMLElement>): void => {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* nothing was captured */
    }
    setDragging(false);
  }, []);

  return {
    size,
    dragging,
    paneRef,
    separatorProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': label,
      'aria-valuenow': size,
      'aria-valuemin': min,
      'aria-valuemax': resolveMax(),
      tabIndex: 0,
      onKeyDown,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}
