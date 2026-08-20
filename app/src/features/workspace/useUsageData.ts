import { useCallback } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { getCreditBalance, getCreditDaily, getCreditHistory } from '../../services/api';
import { keys } from '../../query/keys';
import {
  parseCreditBalance,
  parseLedgerPage,
  parseTrend,
  type CreditBalance,
  type LedgerPage,
  type TrendPoint,
} from './usage-model';

/** The trailing windows the consumption trend offers. The API caps at 90. */
export const TREND_WINDOWS = [7, 30, 90] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];
export const DEFAULT_TREND_WINDOW: TrendWindow = 30;

export interface UsageScope {
  /** `null` = the whole workspace; a bot id = that agent's own ledger. */
  botId: number | null;
  days: TrendWindow;
  /** 1-based page of the credit history. */
  page: number;
}

/**
 * Rows per page of the credit ledger.
 *
 * `GET /credits/history` now reports a `total`, so the pager knows how many
 * pages exist instead of inferring it. It keeps the full-page heuristic as a
 * fallback for a backend that predates the count — asking for one extra row to
 * detect a next page is not an option, because the endpoint offsets by
 * `(page - 1) * limit` and a stride mismatch would skip a movement at every
 * boundary.
 */
export const HISTORY_PAGE_SIZE = 25;

export interface UseUsageDataResult {
  balance: UseQueryResult<CreditBalance>;
  ledger: UseQueryResult<LedgerPage>;
  trend: UseQueryResult<TrendPoint[]>;
  refreshAll: () => void;
}

/**
 * The Usage page's three reads, each scoped and each independently retryable.
 *
 * The balance is the page's primary answer and is workspace-wide by
 * construction (it carries every pool), so it is fetched once and sliced
 * client-side. The ledger and the trend are the two reads the backend can
 * genuinely scope to one agent - `GET /credits/history` and `GET /credits/daily`
 * both take `bot_id` - and until now neither ever received it, so a customer
 * with per-agent subscriptions read a workspace-wide history under an agent's
 * name and had no way to see which agent had spent what.
 */
export function useUsageData(scope: UsageScope): UseUsageDataResult {
  const client = useQueryClient();

  const balance = useQuery({
    queryKey: keys.billing.credits(null),
    queryFn: async () => parseCreditBalance(await getCreditBalance()),
    staleTime: 15_000,
  });

  const ledger = useQuery({
    queryKey: [...keys.billing.creditHistory(scope.botId), scope.page] as const,
    queryFn: async () =>
      parseLedgerPage(
        await getCreditHistory({
          page: scope.page,
          limit: HISTORY_PAGE_SIZE,
          botId: scope.botId ?? undefined,
        }),
      ),
    // The previous page stays on screen while the next one loads rather than
    // the table collapsing to a skeleton and back on every click.
    placeholderData: (previous) => previous,
  });

  const trend = useQuery({
    queryKey: [...keys.billing.creditDaily(scope.botId), scope.days] as const,
    queryFn: async () => parseTrend(await getCreditDaily({ days: scope.days, botId: scope.botId ?? undefined })),
  });

  const refreshAll = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['billing'] });
  }, [client]);

  return { balance, ledger, trend, refreshAll };
}
