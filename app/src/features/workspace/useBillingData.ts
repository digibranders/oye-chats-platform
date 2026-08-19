import { useCallback } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  getActivePromotion,
  getBillingDetails,
  getBillingGeo,
  getCreditBalance,
  getCurrentSubscription,
  getInvoices,
  getPaymentRecovery,
  getSubscriptionPlans,
} from '../../services/api';
import { keys } from '../../query/keys';
import { parseCreditBalance, type CreditBalance } from './usage-model';
import type { BillingDetailsRaw } from './billing/billingDetailsForm';
import {
  buildBillingDetails,
  buildDunning,
  buildGeo,
  buildInvoice,
  buildPlan,
  buildPromotion,
  buildReauth,
  buildSubscription,
  type BillingDetailsView,
  type BillingGeoView,
  type DunningView,
  type InvoiceView,
  type PlanView,
  type PromotionView,
  type ReauthView,
  type SubscriptionView,
} from './billingModel';

/**
 * Everything `/billing` reads, on the shared cache.
 *
 * Seven endpoints, seven queries. They are deliberately NOT one `Promise.all`
 * behind one loading flag, which is what the page this replaces did: a slow
 * invoice list held back the plan summary, a failed one blanked it, and nothing
 * on the page could be retried on its own. Each section here has its own state,
 * so a down invoices endpoint costs the customer the invoice table and nothing
 * else.
 *
 * Only two reads are load-bearing. Without the subscription there is no plan to
 * describe, and without geo there is no currency to describe it in - and a
 * money surface that guesses the currency is worse than one that admits it
 * cannot load. Everything else degrades in place.
 */

export interface BillingData {
  subscription: SubscriptionView;
  plan: PlanView | null;
  /** True once the client has consumed their lifetime free trial. Gates the trial CTA. */
  trialUsed: boolean;
  /** The downgrade re-auth grace row, which is `past_due` but is NOT a failed payment. */
  reauth: ReauthView | null;
}

/** The tax identity, in both the shape the panel renders and the shape the form edits. */
export interface BillingDetails {
  view: BillingDetailsView;
  raw: BillingDetailsRaw;
}

export interface UseBillingDataResult {
  /** The subscription + plan. The page's error state keys on this alone. */
  core: UseQueryResult<BillingData>;
  geo: UseQueryResult<BillingGeoView>;
  plans: UseQueryResult<PlanView[]>;
  invoices: UseQueryResult<InvoiceView[]>;
  details: UseQueryResult<BillingDetails>;
  promotion: UseQueryResult<PromotionView | null>;
  dunning: UseQueryResult<DunningView>;
  credits: UseQueryResult<CreditBalance>;
  /** Re-read every billing query. Wire to a post-mutation refresh, not to a button per panel. */
  refreshAll: () => void;
}

function envelope(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

/**
 * The geo/currency profile on its own.
 *
 * Split out because any surface that renders a price needs it and almost none
 * of them need the other six reads. The Usage page used to pull the whole
 * billing bundle - subscription, plans, invoices, tax identity, promotion,
 * dunning - to find out which currency symbol to print.
 */
export function useBillingGeo(): UseQueryResult<BillingGeoView> {
  return useQuery({
    queryKey: keys.billing.geo(),
    queryFn: async () => buildGeo(await getBillingGeo()),
    // Geo is an account fact, not a live figure. Refetching it every thirty
    // seconds would re-price a page under a customer mid-decision.
    staleTime: 10 * 60_000,
  });
}

export function useBillingData(botId: number | null = null): UseBillingDataResult {
  const client = useQueryClient();

  const core = useQuery({
    queryKey: [...keys.billing.subscription(), botId],
    queryFn: async (): Promise<BillingData> => {
      const raw = envelope(await getCurrentSubscription(botId ?? undefined));
      return {
        subscription: buildSubscription(raw.subscription),
        plan: buildPlan(raw.plan),
        trialUsed: raw.trial_used === true,
        reauth: buildReauth(raw.reauth),
      };
    },
  });

  const geo = useBillingGeo();

  const plans = useQuery({
    queryKey: keys.billing.plans(),
    queryFn: async () => {
      const rows = await getSubscriptionPlans();
      return (Array.isArray(rows) ? rows : [])
        .map((row) => buildPlan(row))
        .filter((plan): plan is PlanView => plan !== null)
        .sort((a, b) => a.sortOrder - b.sortOrder);
    },
    staleTime: 10 * 60_000,
  });

  const invoices = useQuery({
    queryKey: [...keys.billing.invoices(), botId],
    queryFn: async () => {
      const rows = await getInvoices(botId ?? undefined);
      const now = Date.now();
      return (Array.isArray(rows) ? rows : []).map((row, index) => buildInvoice(row, index, now));
    },
  });

  const details = useQuery({
    queryKey: keys.billing.details(),
    queryFn: async (): Promise<BillingDetails> => {
      const raw = await getBillingDetails();
      // Both shapes travel together. The view is what the panel reads; the raw
      // record is what the edit form seeds from and diffs against, because
      // `formToPatch` builds a minimal PATCH by comparing against the stored
      // snake_case payload. Handing it the camelCase view instead produced a
      // form that looked empty and then cleared every field it "changed".
      return { view: buildBillingDetails(raw), raw: raw as BillingDetailsRaw };
    },
  });

  const promotion = useQuery({
    queryKey: keys.billing.promo(),
    queryFn: async () => buildPromotion(await getActivePromotion()),
    staleTime: 10 * 60_000,
  });

  const dunning = useQuery({
    queryKey: ['billing', 'payment-recovery', botId] as const,
    queryFn: async () => buildDunning(await getPaymentRecovery(botId ?? undefined)),
    // Safe to poll by contract: the endpoint resolves Razorpay's EXISTING
    // hosted page and never mints a second mandate.
    staleTime: 60_000,
  });

  const credits = useQuery({
    queryKey: keys.billing.credits(null),
    queryFn: async () => parseCreditBalance(await getCreditBalance()),
    staleTime: 15_000,
  });

  // One key prefix, so a plan change re-reads the subscription, the invoices,
  // the credit balance and the dunning state together. A panel-by-panel refresh
  // is how a page ends up showing a new plan beside the old plan's credits.
  const refreshAll = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['billing'] });
  }, [client]);

  return { core, geo, plans, invoices, details, promotion, dunning, credits, refreshAll };
}
