import { useEffect, useState } from 'react';
import { getCreditBalance, getCreditHistory } from '../../services/api';
import {
  parseCreditBalance,
  parseLedger,
  type CreditBalance,
  type LedgerRow,
} from './usage-model';

/**
 * Loading state machine for the Usage page. `loading` is a genuine derived
 * phase — the first `setState` in the effect always follows an `await`, so we
 * never call `setState` synchronously inside the effect body.
 */
export type UsagePhase =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly balance: CreditBalance; readonly ledger: LedgerRow[] };

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
      try {
        const [balanceRaw, historyRaw] = await Promise.all([
          getCreditBalance(),
          getCreditHistory({ page: 1, limit: 50 }),
        ]);
        if (!active) return;
        setPhase({
          status: 'ready',
          balance: parseCreditBalance(balanceRaw),
          ledger: parseLedger(historyRaw),
        });
      } catch (error) {
        if (!active) return;
        setPhase({
          status: 'error',
          message: toMessage(error, 'We couldn’t load your usage. Please try again.'),
        });
      }
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
