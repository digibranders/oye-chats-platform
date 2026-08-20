import { useState } from 'react';
import { Button, formatNumber } from '../../ui';
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
