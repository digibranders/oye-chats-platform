import { SegmentedControl, type SegmentedItem } from '../../ui';
import { type FeedbackStats } from './feedback-helpers';
import { type FeedbackFilter } from './types';

export interface FeedbackFilterTabsProps {
  stats: FeedbackStats;
  value: FeedbackFilter;
  onChange: (filter: FeedbackFilter) => void;
}

/**
 * All / Positive / Negative, each carrying its live count.
 *
 * A `SegmentedControl`, not `Tabs`. It filters a list that is already on
 * screen; it does not switch between panels, so a `tablist` role would promise
 * `aria-controls` targets that do not exist. The counts are part of the control
 * because "Negative (0)" and a disabled-looking segment are different answers,
 * and a filter that silently matches nothing is the most common way a reader
 * concludes the data is missing.
 */
export function FeedbackFilterTabs({ stats, value, onChange }: FeedbackFilterTabsProps) {
  const items: readonly SegmentedItem<FeedbackFilter>[] = [
    { value: 'all', label: 'All', count: stats.total },
    { value: 'positive', label: 'Helpful', count: stats.positive },
    { value: 'negative', label: 'Not helpful', count: stats.negative },
  ];

  return (
    <SegmentedControl<FeedbackFilter>
      size="sm"
      label="Filter rated answers"
      items={items}
      value={value}
      onChange={onChange}
    />
  );
}
