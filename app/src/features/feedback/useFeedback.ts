import { useQuery } from '@tanstack/react-query';
import { getFeedbackData } from '../../services/api';
import { keys } from '../../query/keys';
import { type FeedbackItem } from './types';

export interface UseFeedbackResult {
  items: FeedbackItem[];
  loading: boolean;
  error: unknown;
  /** Re-run the fetch. Safe to wire to a "Try again" button. */
  refetch: () => void;
}

/**
 * The itemized thumbs-up/down feedback log for one chatbot.
 *
 * On react-query, under `keys.analytics.feedback`, for one reason that is not
 * tidiness: `useAnalyticsRefresh` invalidates the whole `['analytics']` subtree
 * from the page header, and while this panel held its own `useState`/`useEffect`
 * fetch it was the one tab on `/analytics` that the page's Refresh button did
 * not refresh. Nothing on screen said so.
 *
 * Filtering and bucketing still happen entirely client-side (see
 * `feedback-helpers.ts`) — `/analytics/feedback` has no pagination and no
 * server-side filters, so the window the page selects is applied to the full
 * set here rather than being sent.
 *
 * No `locked` flag, unlike the sibling analytics hooks: the endpoint carries no
 * entitlement check, so a refusal from it is a failure and not a plan answer.
 * See the note on `FeedbackPanel`.
 */
export function useFeedback(botId: number | null): UseFeedbackResult {
  const query = useQuery({
    queryKey: keys.analytics.feedback(botId),
    queryFn: () => getFeedbackData(botId ?? undefined),
    enabled: botId != null,
  });

  return {
    items: query.data ?? [],
    // `isPending` is true for a disabled query too, which is right: with no
    // chatbot selected there is nothing to show yet, and the panel would
    // otherwise flash "no feedback" at a workspace that simply has not
    // resolved its agent list.
    loading: query.isPending,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}
