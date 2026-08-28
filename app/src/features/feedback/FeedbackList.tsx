import { useState } from 'react';
import { Button, cn, formatNumber } from '../../ui';
import { FeedbackRow } from './FeedbackRow';
import { type FeedbackItem } from './types';

export interface FeedbackListProps {
  items: readonly FeedbackItem[];
  expandedId: number | null;
  onToggle: (messageId: number) => void;
}

/** Rows revealed at a time. A card that grows without bound is not a list. */
const PAGE_STEP = 25;

/**
 * How tall the list may get before it scrolls inside its own card.
 *
 * The cap on *rows* was not a cap on *height*: twenty-five rows is about
 * 1,125px, and this card sits in a two-up `Grid` beside a five-row priorities
 * panel 428px tall — so the left column ended 900px above the right one and the
 * page carried a dead white rectangle most of a screen high. Bounding the
 * scroller keeps the pair adjacent, which is the entire argument for putting
 * them side by side: pick a question on the left, read its answers on the
 * right, without either leaving the screen.
 */
const LIST_MAX_HEIGHT = 'max-h-[26rem]';

/**
 * The rated answers for the active filter, as one list.
 *
 * `ol` rather than a stack of divs: the order is the data — newest rating
 * first — and a list tells a screen-reader user how many there are before they
 * start walking it.
 *
 * Capped, and it states the cap. A busy workspace has several hundred ratings
 * and this rendered every one as a live `Disclosure`, so the card grew without
 * limit and the reader had no idea how far it went.
 *
 * The reveal count is component state, so the caller keys this on the active
 * filter: a filter change is a different list, and carrying the count over
 * would open a three-row result reading "25 of 3".
 */
export function FeedbackList({ items, expandedId, onToggle }: FeedbackListProps) {
  const [visible, setVisible] = useState(PAGE_STEP);
  const shown = items.slice(0, visible);

  return (
    <>
      {/* The footer stays outside the scroller, so "25 of 312 ratings" and
          "Show 25 more" are on screen without scrolling to the end of a list
          whose length is the thing they are describing. */}
      <div className={cn('overflow-y-auto', LIST_MAX_HEIGHT)}>
        <ol>
          {shown.map((item) => (
            <FeedbackRow
              key={item.message_id}
              item={item}
              expanded={expandedId === item.message_id}
              onToggle={() => onToggle(item.message_id)}
            />
          ))}
        </ol>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border px-cell py-2">
        <p className="text-2xs text-text-tertiary">
          <span className="figure">{formatNumber(shown.length)}</span> of{' '}
          <span className="figure">{formatNumber(items.length)}</span>{' '}
          {items.length === 1 ? 'rating' : 'ratings'}
        </p>
        {items.length > shown.length ? (
          <Button size="sm" variant="ghost" onClick={() => setVisible((count) => count + PAGE_STEP)}>
            Show {formatNumber(Math.min(PAGE_STEP, items.length - shown.length))} more
          </Button>
        ) : null}
      </div>
    </>
  );
}
