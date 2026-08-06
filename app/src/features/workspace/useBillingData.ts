/**
 * useBillingData - loads everything the Workspace ▸ Billing page needs to answer
 * "What am I paying?": the current subscription + plan, the catalog of plans to
 * compare against, issued invoices, and the buyer's tax/billing identity.
 *
 * Resilience: only the current subscription is load-bearing - if it fails the
 * page shows an error. The plan catalog, invoices, and billing details each
 * degrade independently (a down invoices endpoint must never blank the plan
 * summary, and vice-versa) so a partial outage still renders a useful page.
 *
 * Loading is DERIVED (`data === null && error === null`) and no state is written
 * synchronously inside the effect - the fetch resolves first. Matches the
 * codebase pattern (see features/home/useHomeData.ts).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  getActivePromotion,
  getBillingDetails,
  getCurrentSubscription,
  getInvoices,
  getSubscriptionPlans,
} from '../../services/api';
import {
  buildBillingDetails,
  buildInvoice,
  buildPlan,
  buildPromotion,
  buildSubscription,
  type BillingDetailsView,
  type InvoiceView,
  type PlanView,
  type PromotionView,
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
  /** True once the client has consumed their lifetime free trial - gates the trial CTA. */
  trialUsed: boolean;
  /** Active launch promotion the client qualifies for, else null. Display only. */
  promotion: PromotionView | null;
}

export interface UseBillingDataResult {
  loading: boolean;
  error: string | null;
  data: BillingData | null;
  reload: () => void;
  /**
   * Increments on every `reload()`. Panels that own an independent fetch (the
   * credits meter) take this as a dep so they converge with the page instead of
   * showing pre-mutation numbers next to updated ones.
   */
  reloadKey: number;
}

interface Fetched {
  data: BillingData | null;
  error: string | null;
}

async function loadBillingData(botId?: number | null): Promise<BillingData> {
  // Fire all four requests together so the three independent fetches overlap
  // the load-bearing subscription round-trip instead of queuing behind it.
  // getCurrentSubscription has no `.catch`, so a rejection propagates through
  // Promise.all and surfaces the page error state; the other three each carry
  // their own catch and degrade independently.
  //
  // `botId` scopes the subscription + invoices to the selected agent (the
  // per-agent Billing overview); plans (catalog) and billing details are
  // account-level and stay unscoped.
  const scope = botId ?? undefined;
  const [subscriptionRaw, plansRaw, invoicesResult, detailsRaw, promotionRaw] = await Promise.all([
    getCurrentSubscription(scope),
    getSubscriptionPlans().catch((): Array<Record<string, unknown>> => []),
    getInvoices(scope)
      .then((rows) => ({ rows: Array.isArray(rows) ? rows : [], error: false }))
      .catch(() => ({ rows: [] as Array<Record<string, unknown>>, error: true })),
    getBillingDetails().catch((): Record<string, unknown> => ({})),
    // Promo is a decorative overlay — a failure must never blank the page, so it
    // degrades to "no promotion" independently like plans/invoices/details.
    getActivePromotion().catch((): Record<string, unknown> => ({ active: false })),
  ]);

  const envelope =
    subscriptionRaw && typeof subscriptionRaw === 'object'
      ? (subscriptionRaw as Record<string, unknown>)
      : {};

  return {
    subscription: buildSubscription(envelope.subscription),
    plan: buildPlan(envelope.plan),
    availablePlans: plansRaw
      .map((raw) => buildPlan(raw))
      .filter((plan): plan is PlanView => plan !== null),
    invoices: invoicesResult.rows.map((raw, index) => buildInvoice(raw, index)),
    invoicesError: invoicesResult.error,
    details: buildBillingDetails(detailsRaw),
    trialUsed: envelope.trial_used === true,
    promotion: buildPromotion(promotionRaw),
  };
}

export function useBillingData(botId?: number | null): UseBillingDataResult {
  const [reloadKey, setReloadKey] = useState(0);
  const [result, setResult] = useState<Fetched>({ data: null, error: null });

  const reload = useCallback(() => {
    // Reset to loading from an event handler - never synchronously in the effect.
    setResult({ data: null, error: null });
    setReloadKey((key) => key + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadBillingData(botId);
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
  }, [reloadKey, botId]);

  return {
    loading: result.data === null && result.error === null,
    error: result.error,
    data: result.data,
    reload,
    reloadKey,
  };
}
