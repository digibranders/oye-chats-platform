import { type ReactElement } from 'react';
import { FeedbackRow } from './FeedbackRow';
import { type FeedbackItem } from './types';

interface FeedbackListProps {
  items: FeedbackItem[];
  expandedId: number | null;
  onToggle: (messageId: number) => void;
}

/** FeedbackList — the itemized, expandable feedback cards for the active filter. */
export function FeedbackList({ items, expandedId, onToggle }: FeedbackListProps): ReactElement {
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <FeedbackRow
          key={item.message_id}
          item={item}
          expanded={expandedId === item.message_id}
          onToggle={() => onToggle(item.message_id)}
        />
      ))}
    </div>
  );
}
