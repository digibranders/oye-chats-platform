import { useCallback } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { getCreditBalance, getCreditDaily, getCreditHistory } from '../../services/api';
import { keys } from '../../query/keys';
import {
  parseCreditBalance,
  parseLedgerPage,
  parseTrend,
  resolveScopedPool,
  type CreditBalance,
  type LedgerPage,
  type PoolCredit,
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
  /**
   * The pool the ledger and the trend are actually reporting on.
   *
   * Returned so the page LABELS what it QUERIED. It used to resolve this
   * itself, in parallel, and the two answers were not the same: see the note on
   * the hook.
   */
  pool: PoolCredit | null;
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
 *
 * **The scope is the resolved POOL, not the chatbot in the rail**, and the
 * difference is a bug this page shipped. Most chatbots have no ledger of their
 * own: they drain the shared account pool, and their consumption rows carry
 * `bot_id IS NULL`. `resolveScopedPool` already knows that -- it falls back to
 * the account pool, which is why the balance card reads "Shared credits" -- but
 * the ledger and the trend were handed the raw selection and asked the database
 * for a per-bot ledger that does not exist. Both came back empty, so the page
 * said "No credits spent in the last 90 days" and "No credit movements yet" in
 * cards headed "Shared credits", six inches from "Spent this period 1,841"
 * taken from the same table at account scope.
 *
 * Resolving it here rather than in the page is the point. Two independent
 * resolutions of "which pool is this" are what allowed the label and the query
 * to disagree.
 */
export function useUsageData(scope: UsageScope): UseUsageDataResult {
  const client = useQueryClient();

  const balance = useQuery({
    queryKey: keys.billing.credits(null),
    queryFn: async () => parseCreditBalance(await getCreditBalance()),
    staleTime: 15_000,
  });

  const pool = balance.data ? resolveScopedPool(balance.data, scope.botId) : null;
  const ledgerBotId = pool?.botId ?? null;
  // Held until the balance settles, success or failure, because the balance is
  // what says which pool this chatbot drains. Firing first would ask the wrong
  // scope and then refetch, flashing one pool's history under another's name --
  // a smaller version of the bug being fixed. On failure the scope resolves to
  // the account pool, which is a superset rather than a wrong answer, and the
  // page already reports the balance error.
  const scopeSettled = !balance.isPending;

  const ledger = useQuery({
    queryKey: [...keys.billing.creditHistory(ledgerBotId), scope.page] as const,
    queryFn: async () =>
      parseLedgerPage(
        await getCreditHistory({
          page: scope.page,
          limit: HISTORY_PAGE_SIZE,
          botId: ledgerBotId ?? undefined,
        }),
      ),
    enabled: scopeSettled,
    // The previous page stays on screen while the next one loads rather than
    // the table collapsing to a skeleton and back on every click.
    placeholderData: (previous) => previous,
  });

  const trend = useQuery({
    queryKey: [...keys.billing.creditDaily(ledgerBotId), scope.days] as const,
    queryFn: async () => parseTrend(await getCreditDaily({ days: scope.days, botId: ledgerBotId ?? undefined })),
    enabled: scopeSettled,
  });

  const refreshAll = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['billing'] });
  }, [client]);

  return { balance, ledger, trend, pool, refreshAll };
}
