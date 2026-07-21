/**
 * useBillingData — loads everything the Workspace ▸ Billing page needs to answer
 * "What am I paying?": the current subscription + plan, the catalog of plans to
 * compare against, issued invoices, and the buyer's tax/billing identity.
 *
 * Resilience: only the current subscription is load-bearing — if it fails the
 * page shows an error. The plan catalog, invoices, and billing details each
 * degrade independently (a down invoices endpoint must never blank the plan
 * summary, and vice-versa) so a partial outage still renders a useful page.
 *
 * Loading is DERIVED (`data === null && error === null`) and no state is written
 * synchronously inside the effect — the fetch resolves first. Matches the
 * codebase pattern (see features/home/useHomeData.ts).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  getBillingDetails,
  getCurrentSubscription,
  getInvoices,
  getSubscriptionPlans,
} from '../../services/api';
import {
  buildBillingDetails,
  buildInvoice,
  buildPlan,
  buildSubscription,
  type BillingDetailsView,
  type InvoiceView,
  type PlanView,
  type SubscriptionView,
} from './billingModel';

export interface BillingData {
  subscription: SubscriptionView;
  /** The customer's current plan, or null when the payload omits it. */
  plan: PlanView | null;
  /** Full catalog for the plan-comparison scaffold. */
  availablePlans: PlanView[];
  invoices: InvoiceView[];
  /** True when the invoices endpoint failed (distinct from "no invoices"). */
  invoicesError: boolean;
  details: BillingDetailsView;
}

export interface UseBillingDataResult {
  loading: boolean;
  error: string | null;
  data: BillingData | null;
  reload: () => void;
}

interface Fetched {
  data: BillingData | null;
  error: string | null;
}

async function loadBillingData(): Promise<BillingData> {
  // Load-bearing: a failure here surfaces the page error state.
  const subscriptionRaw = await getCurrentSubscription();
  const envelope =
    subscriptionRaw && typeof subscriptionRaw === 'object'
      ? (subscriptionRaw as Record<string, unknown>)
      : {};

  // Non-fatal sources fan out in parallel and each degrade on their own.
  const [plansRaw, invoicesResult, detailsRaw] = await Promise.all([
    getSubscriptionPlans().catch((): Array<Record<string, unknown>> => []),
    getInvoices()
      .then((rows) => ({ rows: Array.isArray(rows) ? rows : [], error: false }))
      .catch(() => ({ rows: [] as Array<Record<string, unknown>>, error: true })),
    getBillingDetails().catch((): Record<string, unknown> => ({})),
  ]);

  return {
    subscription: buildSubscription(envelope.subscription),
    plan: buildPlan(envelope.plan),
    availablePlans: plansRaw
      .map((raw) => buildPlan(raw))
      .filter((plan): plan is PlanView => plan !== null),
    invoices: invoicesResult.rows.map((raw, index) => buildInvoice(raw, index)),
    invoicesError: invoicesResult.error,
    details: buildBillingDetails(detailsRaw),
  };
}

export function useBillingData(): UseBillingDataResult {
  const [reloadKey, setReloadKey] = useState(0);
  const [result, setResult] = useState<Fetched>({ data: null, error: null });

  const reload = useCallback(() => {
    // Reset to loading from an event handler — never synchronously in the effect.
    setResult({ data: null, error: null });
    setReloadKey((key) => key + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadBillingData();
        if (!cancelled) setResult({ data, error: null });
      } catch (err) {
        if (!cancelled) {
          setResult({
            data: null,
            error:
              err instanceof Error
                ? err.message
                : 'We couldn’t load your billing information. Please try again.',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return {
    loading: result.data === null && result.error === null,
    error: result.error,
    data: result.data,
    reload,
  };
}
