import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { ArrowLeft } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/Button';
import { useTranslation } from '../../i18n/useTranslation';

/** Default list widths, in px, so the resize arithmetic has one unit. */
const LIST_WIDTHS = { sm: 288, md: 320 } as const;
const MIN_LIST = 240;
const MAX_LIST = 480;

function clamp(px: number): number {
  return Math.min(MAX_LIST, Math.max(MIN_LIST, Math.round(px)));
}

function readStored(key: string | undefined): number | null {
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(value) ? clamp(value) : null;
  } catch {
    // Private browsing, a full quota, a blocked origin. A remembered pane width
    // is not worth taking the inbox down for.
    return null;
  }
}

export interface SplitPaneProps {
  /** The queue: conversations, leads, records. Always the first pane. */
  list: ReactNode;
  /** The selected thing. */
  detail: ReactNode;
  /** A third pane of context about the selection. Only at the widest step. */
  inspector?: ReactNode;
  /**
   * Something is selected.
   *
   * Drives which pane is visible once the panes have to stack. The component
   * cannot infer it: an empty detail pane and an unselected one look the same
   * from here and mean opposite things.
   */
  selected: boolean;
  /** The back control, rendered above the detail pane only while stacked. */
  onBack?: () => void;
  /** What the back control returns to. Default "Back". */
  backLabel?: string;
  /** The list's resting width. 18rem for a queue, 20rem for rows with meta. */
  listWidth?: 'sm' | 'md';
  /**
   * Let the operator drag the split.
   *
   * Intercom, Front, Zendesk and Help Scout all do, because an operator lives in
   * this screen all day and the right split depends on their monitor and their
   * queue. Pair it with `storageKey` — a split that resets on every navigation
   * is worse than one that cannot move.
   */
  resizable?: boolean;
  /** Where the dragged width is remembered, per user. */
  storageKey?: string;
  /** Names the list pane's region, e.g. "Conversations". */
  listLabel?: string;
  /** Names the detail pane's region, e.g. "Conversation". */
  detailLabel?: string;
  /** Names the inspector pane's region, e.g. "Visitor". */
  inspectorLabel?: string;
  className?: string;
}

/**
 * List, detail, and optionally an inspector.
 *
 * The shape of Linear's issue list, Stripe's payments, and every inbox this
 * console is measured against. It lived in the inbox as a hand-written
 * `grid-cols-[20rem_minmax(0,1fr)_20rem]`, which meant Leads, superadmin
 * Customers and the knowledge sources each solved list→detail a different way —
 * two of them by making the detail a whole route change, which throws away the
 * list's scroll position and the operator's place in the queue.
 *
 * **Both panes stay mounted when the layout stacks.** The stacked pane is
 * `display: none`, not unmounted: a half-typed reply, a scroll offset held in
 * React state, an open filter — all of it survives going back and forth. What
 * the platform does *not* guarantee across `display: none` is the DOM's own
 * `scrollTop`, so a pane that must restore an exact offset owns that itself.
 *
 * **The steps are container queries.** Two panes from `@3xl/page` (768 of split
 * width), three from `@6xl/page` (1152). The inbox previously promised three
 * panes at a 1280 viewport and could not honour it — at 1280 the transcript was
 * 392px wide. Between the two-pane and three-pane steps the inspector is not
 * rendered at all, and the surface is expected to offer it as a drawer.
 *
 * The resize separator is a real `role="separator"`: arrow keys move it 16px at
 * a time (64 with shift), Home and End go to the stops, and the value is
 * reported in pixels so a screen-reader user hears what changed.
 */
export function SplitPane({
  list,
  detail,
  inspector,
  selected,
  onBack,
  backLabel: backLabelProp,
  listWidth = 'sm',
  resizable = false,
  storageKey,
  listLabel,
  detailLabel,
  inspectorLabel,
  className,
}: SplitPaneProps) {
  const { t } = useTranslation();
  // `??` would also swallow an explicit `null`; a default parameter
  // only applies to `undefined`, and callers pass null to opt OUT.
  const backLabel = backLabelProp === undefined ? (t('ds.back') || 'Back') : backLabelProp;
  const [width, setWidth] = useState<number>(
    () => readStored(storageKey) ?? LIST_WIDTHS[listWidth],
  );
  const [dragging, setDragging] = useState(false);
  const listRef = useRef<HTMLElement>(null);

  const commit = useCallback(
    (next: number) => {
      const value = clamp(next);
      setWidth(value);
      if (!storageKey) return;
      try {
        window.localStorage.setItem(storageKey, String(value));
      } catch {
        // See `readStored`.
      }
    },
    [storageKey],
  );

  function onSeparatorKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? 64 : 16;
    let next: number;
    if (event.key === 'ArrowLeft') next = width - step;
    else if (event.key === 'ArrowRight') next = width + step;
    else if (event.key === 'Home') next = MIN_LIST;
    else if (event.key === 'End') next = MAX_LIST;
    else return;
    event.preventDefault();
    commit(next);
  }

  function onSeparatorPointerDown(event: PointerEvent<HTMLDivElement>): void {
    // Pointer capture is what keeps the drag alive once the cursor leaves the
    // 12px handle, which it does immediately. It is also the one DOM API in
    // this file jsdom does not implement, so a failure here must not take the
    // drag — or a test — down with it.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* no capture available; the drag still tracks while the pointer is over the handle */
    }
    setDragging(true);
  }

  function onSeparatorPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (!dragging) return;
    const left = listRef.current?.getBoundingClientRect().left;
    if (left === undefined) return;
    commit(event.clientX - left);
  }

  function onSeparatorPointerUp(event: PointerEvent<HTMLDivElement>): void {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* nothing was captured */
    }
    setDragging(false);
  }

  return (
    <div
      className={cn('@container/page flex min-h-0 flex-1 flex-col', className)}
      style={{ '--split-list': `${width}px` } as CSSProperties}
    >
      <div
        className={cn(
          'grid min-h-0 flex-1 grid-cols-1',
          '@3xl/page:grid-cols-[var(--split-list)_minmax(0,1fr)]',
          inspector && '@6xl/page:grid-cols-[var(--split-list)_minmax(0,1fr)_18rem]',
        )}
      >
        <section
          ref={listRef}
          aria-label={listLabel}
          className={cn(
            'relative flex min-h-0 min-w-0 flex-col border-border @3xl/page:flex @3xl/page:border-r',
            selected && 'hidden',
          )}
        >
          <div className="@container/page flex min-h-0 min-w-0 flex-1 flex-col">{list}</div>
          {resizable ? (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('ds.resizeTheList') || 'Resize the list'}
              aria-valuenow={width}
              aria-valuemin={MIN_LIST}
              aria-valuemax={MAX_LIST}
              tabIndex={0}
              onKeyDown={onSeparatorKeyDown}
              onPointerDown={onSeparatorPointerDown}
              onPointerMove={onSeparatorPointerMove}
              onPointerUp={onSeparatorPointerUp}
              onPointerCancel={onSeparatorPointerUp}
              className={cn(
                // A 1px hairline is not a 24px target, so the hit area straddles
                // the border and the border stays where the eye expects it.
                'absolute inset-y-0 right-0 hidden w-3 translate-x-1/2 cursor-col-resize',
                'touch-none select-none @3xl/page:block',
                'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent-500',
                dragging && 'bg-accent-50',
              )}
            />
          ) : null}
        </section>

        <section
          aria-label={detailLabel}
          className={cn(
            'flex min-h-0 min-w-0 flex-col @3xl/page:flex',
            !selected && 'hidden',
          )}
        >
          {onBack ? (
            <div className="flex h-row shrink-0 items-center border-b border-border bg-surface px-cell @3xl/page:hidden">
              <Button
                variant="ghost"
                size="sm"
                onClick={onBack}
                iconLeft={<ArrowLeft aria-hidden />}
                className="-ml-2"
              >
                {backLabel}
              </Button>
            </div>
          ) : null}
          <div className="@container/page flex min-h-0 min-w-0 flex-1 flex-col">{detail}</div>
        </section>

        {inspector ? (
          <section
            aria-label={inspectorLabel}
            className="hidden min-h-0 min-w-0 flex-col border-l border-border @6xl/page:flex"
          >
            <div className="@container/page flex min-h-0 min-w-0 flex-1 flex-col">{inspector}</div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
