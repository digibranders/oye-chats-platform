import { FeedbackRow } from './FeedbackRow';
import { type FeedbackItem } from './types';

export interface FeedbackListProps {
  items: readonly FeedbackItem[];
  expandedId: number | null;
  onToggle: (messageId: number) => void;
}

/**
 * The rated answers for the active filter, as one list.
 *
 * `ol` rather than a stack of divs: the order is the data — newest rating
 * first — and a list tells a screen-reader user how many there are before they
 * start walking it.
 */
export function FeedbackList({ items, expandedId, onToggle }: FeedbackListProps) {
  return (
    <ol>
      {items.map((item) => (
        <FeedbackRow
          key={item.message_id}
          item={item}
          expanded={expandedId === item.message_id}
          onToggle={() => onToggle(item.message_id)}
        />
      ))}
    </ol>
  );
}
