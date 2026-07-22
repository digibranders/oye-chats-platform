import { useEffect, useState } from 'react';
import { getCreditBalance, getCreditHistory } from '../../services/api';
import {
  parseCreditBalance,
  parseLedger,
  type CreditBalance,
  type LedgerRow,
} from './usage-model';

/**
 * The consumption ledger loads independently of the balance: a history-only
 * failure must not blank the (already-loaded) balance and metrics, so it
 * carries its own success/error surface within the `ready` phase.
 */
export type LedgerState =
  | { readonly status: 'ready'; readonly rows: LedgerRow[] }
  | { readonly status: 'error'; readonly message: string };

/**
 * Loading state machine for the Usage page. `loading` is a genuine derived
 * phase — the first `setState` in the effect always follows an `await`, so we
 * never call `setState` synchronously inside the effect body.
 */
export type UsagePhase =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly balance: CreditBalance; readonly ledger: LedgerState };

export interface UsageData {
  readonly phase: UsagePhase;
  /** Re-fetch balance + ledger, returning to the loading state first. */
  readonly retry: () => void;
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * useUsageData — fetches the account credit balance and the recent consumption
 * ledger in parallel. Owns the loading/error/ready state machine so the page
 * can stay declarative.
 */
export function useUsageData(): UsageData {
  const [phase, setPhase] = useState<UsagePhase>({ status: 'loading' });
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      // Settle both independently: the balance is the page's primary answer,
      // so a history-only failure degrades to an inline error on the ledger
      // section rather than blanking the whole page.
      const [balanceResult, historyResult] = await Promise.allSettled([
        getCreditBalance(),
        getCreditHistory({ page: 1, limit: 50 }),
      ]);
      if (!active) return;

      if (balanceResult.status === 'rejected') {
        setPhase({
          status: 'error',
          message: toMessage(
            balanceResult.reason,
            'We couldn’t load your usage. Please try again.',
          ),
        });
        return;
      }

      const ledger: LedgerState =
        historyResult.status === 'fulfilled'
          ? { status: 'ready', rows: parseLedger(historyResult.value) }
          : {
              status: 'error',
              message: toMessage(
                historyResult.reason,
                'We couldn’t load your consumption history.',
              ),
            };

      setPhase({
        status: 'ready',
        balance: parseCreditBalance(balanceResult.value),
        ledger,
      });
    })();
    return () => {
      active = false;
    };
  }, [refreshToken]);

  const retry = (): void => {
    setPhase({ status: 'loading' });
    setRefreshToken((token) => token + 1);
  };

  return { phase, retry };
}
