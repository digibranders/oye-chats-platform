import { type ReactElement } from 'react';
import { Tabs } from '../../design-system';
import { type FeedbackStats } from './feedback-helpers';
import { type FeedbackFilter } from './types';

interface FeedbackFilterTabsProps {
  stats: FeedbackStats;
  value: FeedbackFilter;
  onChange: (filter: FeedbackFilter) => void;
}

const FILTERS: readonly FeedbackFilter[] = ['all', 'positive', 'negative'];

function isFeedbackFilter(key: string): key is FeedbackFilter {
  return (FILTERS as readonly string[]).includes(key);
}

/**
 * FeedbackFilterTabs — All / Positive / Negative, each labelled with its live
 * count. Thin wrapper over the design-system `Tabs` primitive.
 */
export function FeedbackFilterTabs({ stats, value, onChange }: FeedbackFilterTabsProps): ReactElement {
  return (
    <Tabs
      ariaLabel="Filter feedback"
      value={value}
      onChange={(key) => {
        if (isFeedbackFilter(key)) onChange(key);
      }}
      tabs={[
        { key: 'all', label: `All (${stats.total})` },
        { key: 'positive', label: `Positive (${stats.positive})` },
        { key: 'negative', label: `Negative (${stats.negative})` },
      ]}
    />
  );
}
