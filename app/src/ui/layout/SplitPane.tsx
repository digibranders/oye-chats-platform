import { useRef, type CSSProperties, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/Button';
import { useResizeHandle } from './useResizeHandle';
import { useTranslation } from '../../i18n/useTranslation';

/** Default list widths, in px, so the resize arithmetic has one unit. */
const LIST_WIDTHS = { sm: 288, md: 320 } as const;
const MIN_LIST = 240;
const MAX_LIST = 480;

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
  // The list sits at the grid's inline-start track, so its handle is on its
  // `end` edge and the hook works the direction out from there.
  const { size: width, dragging, paneRef, separatorProps } = useResizeHandle({
    initial: LIST_WIDTHS[listWidth],
    min: MIN_LIST,
    max: MAX_LIST,
    storageKey,
    edge: 'end',
    label: t('ds.resizeTheList') || 'Resize the list',
  });
  const listRef = useRef<HTMLElement>(null);

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
          ref={(node) => {
            listRef.current = node;
            paneRef(node);
          }}
          aria-label={listLabel}
          className={cn(
            'relative flex min-h-0 min-w-0 flex-col border-border @3xl/page:flex @3xl/page:border-e',
            selected && 'hidden',
          )}
        >
          <div className="@container/page flex min-h-0 min-w-0 flex-1 flex-col">{list}</div>
          {resizable ? (
            <div
              {...separatorProps}
              className={cn(
                // A 1px hairline is not a 24px target, so the hit area straddles
                // the border and the border stays where the eye expects it.
                // `translate-x-1/2` is a transform — never direction-aware — so it
                // always shifts physically rightward; `rtl:-translate-x-1/2`
                // reverses it under RTL to keep the handle centred on the
                // (now logical) `end-0` boundary instead of drifting a full
                // handle-width off it.
                // rtl-ok: see the note above — translate-x-1/2 is paired
                // with rtl:-translate-x-1/2 to stay centred on end-0.
                'absolute inset-y-0 end-0 hidden w-3 translate-x-1/2 rtl:-translate-x-1/2 cursor-col-resize',
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
                iconLeft={<ArrowLeft aria-hidden className="rtl:rotate-180" />}
                className="-ms-2"
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
            className="hidden min-h-0 min-w-0 flex-col border-s border-border @6xl/page:flex"
          >
            <div className="@container/page flex min-h-0 min-w-0 flex-1 flex-col">{inspector}</div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
