import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/Button';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * A pannable, zoomable SVG viewport. Ported from a mouse-only canvas
 * in `development` (development:UserJourneyFlow.tsx#ZoomableFlowCanvas,
 * commit a56d0538) that had no keyboard path at all — the defect
 * `REBUILD.md`'s Consolidations table cites for why the journey flow
 * diagram was cut. Wheel-zoom and drag-to-pan behave the same as the
 * original; arrow keys / `+`/`-`/`0` are new, and the canvas itself is
 * a focusable `role="application"` region (an SVG viewport with its
 * own keybindings isn't a `region` or `img` — `application` is the
 * ARIA pattern for a widget that owns arrow-key navigation instead of
 * ceding it to the page).
 */

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.1;
const KEYBOARD_PAN_STEP = 40;

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0 };

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export interface ZoomPanCanvasProps {
  /** Accessible name for the canvas region, read by screen readers
   *  and used as the `role="application"` label. */
  label: string;
  viewBoxWidth: number;
  viewBoxHeight: number;
  children: ReactNode;
  className?: string;
  /**
   * Sizing the caller cannot express in a class — in practice an
   * `aspectRatio` derived from the viewBox, which is what stops
   * `preserveAspectRatio="…meet"` letterboxing the drawing inside a box of
   * some other shape.
   */
  style?: CSSProperties;
}

export function ZoomPanCanvas({
  label,
  viewBoxWidth,
  viewBoxHeight,
  children,
  className,
  style,
}: ZoomPanCanvasProps) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ clientX: number; clientY: number; startTx: number; startTy: number } | null>(
    null,
  );
  /**
   * Show the focus ring, but only when focus arrived from the keyboard.
   *
   * `:focus-visible` is supposed to be exactly this and is not, here: on a
   * focusable SVG (`role="application"`, `tabindex="0"`) the browser's own
   * heuristic treats a plain click as focus-visible, so every drag-to-pan —
   * the canvas's primary interaction — lit a blue ring around the whole
   * diagram.
   *
   * Dropping the ring outright is not the fix: this widget owns arrow keys,
   * `+`/`-` and `0`, so a keyboard user has to be able to see where they
   * are (WCAG 2.2 SC 2.4.7). Tracking *how* focus arrived keeps the ring for
   * them and never shows it to the mouse. The pointer flag is cleared by the
   * `focus` handler it exists for, so a later Tab into the canvas still rings.
   */
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const pointerFocusRef = useRef(false);

  const zoomAt = (nextScale: number, anchor?: { x: number; y: number }): void => {
    setTransform((prev) => {
      const scale = clamp(nextScale, ZOOM_MIN, ZOOM_MAX);
      if (scale === prev.scale) return prev;
      if (!anchor) return { ...prev, scale };
      const ratio = scale / prev.scale;
      return {
        scale,
        tx: anchor.x - ratio * (anchor.x - prev.tx),
        ty: anchor.y - ratio * (anchor.y - prev.ty),
      };
    });
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(transform.scale * factor, anchor);
    };
    svg.addEventListener('wheel', handler, { passive: false });
    return () => svg.removeEventListener('wheel', handler);
  }, [transform.scale]);

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    // Set before the browser moves focus, which is what the `focus` handler
    // below reads to decide whether this was a pointer or a keyboard arrival.
    pointerFocusRef.current = true;
    if (e.button !== 0) return;
    setDragging(true);
    dragRef.current = { clientX: e.clientX, clientY: e.clientY, startTx: transform.tx, startTy: transform.ty };
  };
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!dragging || !drag) return;
    setTransform((prev) => ({
      ...prev,
      tx: drag.startTx + (e.clientX - drag.clientX),
      ty: drag.startTy + (e.clientY - drag.clientY),
    }));
  };
  const endDrag = (): void => {
    setDragging(false);
    dragRef.current = null;
  };

  const zoomIn = (): void => zoomAt(transform.scale * ZOOM_STEP);
  const zoomOut = (): void => zoomAt(transform.scale / ZOOM_STEP);
  const reset = (): void => setTransform(IDENTITY);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowUp':
        setTransform((p) => ({ ...p, ty: p.ty + KEYBOARD_PAN_STEP }));
        e.preventDefault();
        break;
      case 'ArrowDown':
        setTransform((p) => ({ ...p, ty: p.ty - KEYBOARD_PAN_STEP }));
        e.preventDefault();
        break;
      case 'ArrowLeft':
        setTransform((p) => ({ ...p, tx: p.tx + KEYBOARD_PAN_STEP }));
        e.preventDefault();
        break;
      case 'ArrowRight':
        setTransform((p) => ({ ...p, tx: p.tx - KEYBOARD_PAN_STEP }));
        e.preventDefault();
        break;
      case '+':
      case '=':
        zoomIn();
        e.preventDefault();
        break;
      case '-':
      case '_':
        zoomOut();
        e.preventDefault();
        break;
      case '0':
        reset();
        e.preventDefault();
        break;
      default:
        break;
    }
  };

  return (
    <div
      className={cn('relative w-full overflow-hidden rounded-lg bg-surface-sunken', className)}
      style={style}
    >
      <svg
        ref={svgRef}
        role="application"
        aria-label={label}
        aria-roledescription={t('ds.pannableZoomableDiagram') || 'pannable, zoomable diagram'}
        tabIndex={0}
        viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
        preserveAspectRatio="xMidYMid meet"
        className={cn(
          // `h-full`, not `h-auto`: the caller sizes the box (in the journey
          // card, to the viewBox's own aspect), and the drawing fills it.
          // With `h-auto` the SVG took its height from the viewBox ratio and
          // simply left whatever the container had spare as dead space.
          'block h-full w-full select-none outline-none',
          keyboardFocused && 'outline-2 outline-offset-2 outline-accent-500',
        )}
        style={{ cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          setKeyboardFocused(!pointerFocusRef.current);
          pointerFocusRef.current = false;
        }}
        onBlur={() => setKeyboardFocused(false)}
      >
        <g transform={`translate(${transform.tx} ${transform.ty}) scale(${transform.scale})`}>{children}</g>
      </svg>

      <div className="absolute right-3 top-3 flex flex-col gap-1">
        <Button
          size="icon-sm"
          variant="secondary"
          aria-label={t('ds.zoomIn') || 'Zoom in'}
          onClick={zoomIn}
          disabled={transform.scale >= ZOOM_MAX}
        >
          <Plus aria-hidden className="h-icon-sm w-icon-sm" />
        </Button>
        <Button
          size="icon-sm"
          variant="secondary"
          aria-label={t('ds.zoomOut') || 'Zoom out'}
          onClick={zoomOut}
          disabled={transform.scale <= ZOOM_MIN}
        >
          <Minus aria-hidden className="h-icon-sm w-icon-sm" />
        </Button>
        <Button size="icon-sm" variant="secondary" aria-label={t('ds.resetView') || 'Reset view'} onClick={reset}>
          <RotateCcw aria-hidden className="h-icon-sm w-icon-sm" />
        </Button>
      </div>

      <div
        className="absolute bottom-3 right-3 rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium tabular-nums text-text-secondary"
        aria-live="polite"
      >
        {Math.round(transform.scale * 100)}%
      </div>
    </div>
  );
}
