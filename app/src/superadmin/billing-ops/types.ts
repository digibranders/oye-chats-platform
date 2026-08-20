/**
 * Shapes returned by the platform's billing-operations endpoints.
 *
 * As with the revenue types, every field name below was read out of the handler
 * rather than assumed. Two of these responses are notably *not* what a caller
 * would guess: the reconciliation brief carries an amount with no currency, and
 * the dunning row's "at risk" figure is the plan's monthly price regardless of
 * whether the customer is billed annually.
 */

/* ------------------------------------------------ /superadmin/billing/dunning */

/** One past-due subscription. `superadmin_routes_v2.dunning_overview`. */
export interface DunningItem {
  subscription_id: number;
  client_id: number;
  client_email: string | null;
  plan_name: string | null;
  billing_cycle: string | null;
  past_due_since: string | null;
  /** Whole days since the first failed charge. Null when `past_due_since` is. */
  days_elapsed: number | null;
  /** Days of grace remaining, floored at zero. Null when `days_elapsed` is. */
  days_left: number | null;
  /** Which steps of the automated cadence have already been sent. */
  emails_sent: string[];
  /**
   * One billing cycle's price in `currency`'s minor units.
   *
   * Cycle-aware and rail-aware: annual subscriptions carry the annual price,
   * and a USD-rail customer carries the plan's USD column. It used to be the
   * monthly INR price for everyone, which understated every annual row and
   * mislabelled every USD one.
   *
   * `null` when the plan has no price recorded on the customer's rail — a data
   * defect. Such a row is excluded from the totals rather than falling back to
   * the other currency's number.
   *
   * It is one cycle *at risk*, not an amount owed: Razorpay does not re-attempt
   * the missed cycle.
   */
  cycle_at_risk_minor: number | null;
  /** The rail this customer is charged on, from their billing country. */
  currency: string;
}

export interface DunningResponse {
  count: number;
  /**
   * One total per currency, from the server.
   *
   * It replaced a single scalar that added paise to cents — a number that was
   * not an amount of anything. There is deliberately no converted grand total:
   * a dunning screen showing one invites somebody to book it as revenue.
   */
  at_risk_by_currency: { currency: string; minor: number }[];
  grace_days: number;
  items: DunningItem[];
}

/* ----------------------------------------- /superadmin/billing/reconciliation */

/**
 * One offending document. `invoice_reports._brief`.
 *
 * Note what is missing: **there is no `currency` field**. `amount_cents` is a
 * bare minor-unit integer whose denomination this endpoint does not report, so
 * it cannot honestly be rendered as money. The console shows the document and
 * links through to the invoice, which does carry its currency.
 */
export interface AnomalyBrief {
  id: number;
  invoice_number: string | null;
  invoice_type: string | null;
  status: string | null;
  client_id: number;
  amount_cents: number | null;
  issued_at: string | null;
}

export type AnomalyKey =
  | 'refunds_without_credit_note'
  | 'pdfs_pending'
  | 'emails_pending'
  | 'broken_totals'
  | 'unnumbered_charges'
  | 'exports_without_fx';

export type ReconciliationResponse = {
  counts: Record<AnomalyKey, number>;
} & Record<AnomalyKey, AnomalyBrief[]>;

/* ------------------------------------- /superadmin/reconciliation/gateway */

/** One nightly gateway-reconciliation run. `gateway_reconciliation_runs`. */
export interface GatewayRun {
  id: number;
  ran_at: string | null;
  delta_count: number;
  /** Free-form; `report.deltas` names what disagreed. Shape is not contractual. */
  report: { deltas?: unknown[] } & Record<string, unknown>;
}

/* ------------------------------------ /superadmin/billing/seller-profile */

/** `superadmin_routes_v2._profile_dict`. */
export interface SellerProfile {
  /** False until the profile has been saved once. */
  configured: boolean;
  /** Derived server-side: true exactly when a GSTIN is stored. Read-only. */
  gst_enabled: boolean;
  legal_name: string;
  trade_name: string;
  gstin: string | null;
  address_lines: string[];
  state_code: string | null;
  country: string;
  sac_code: string;
  tax_rate_bps: number;
  /** Always true — the service rejects `false` outright. Read-only here. */
  price_inclusive: boolean;
  lut_active: boolean;
  lut_number: string | null;
  invoice_prefix: string;
  logo_url: string | null;
  cin: string | null;
  phone: string | null;
  website: string | null;
  support_email: string | null;
}

/** The fields `PUT /superadmin/billing/seller-profile` will accept. */
export type SellerProfilePatch = Partial<
  Pick<
    SellerProfile,
    | 'legal_name'
    | 'trade_name'
    | 'gstin'
    | 'address_lines'
    | 'state_code'
    | 'country'
    | 'sac_code'
    | 'tax_rate_bps'
    | 'lut_active'
    | 'lut_number'
    | 'invoice_prefix'
    | 'logo_url'
    | 'cin'
    | 'phone'
    | 'website'
    | 'support_email'
  >
>;

/* --------------------------------------- /superadmin/processed-webhooks */

/** `superadmin_ops_routes.list_processed_webhooks` — capped at 500. */
export interface ProcessedWebhookRow {
  event_id: string;
  provider: string;
  processed_at: string | null;
}
