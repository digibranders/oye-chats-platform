import { describe, expect, it } from 'vitest';
import {
  CHARGE_CURRENCY,
  INVOICE_RENDER_GRACE_MS,
  UNLIMITED_LIMIT,
  buildDunning,
  buildGeo,
  buildInvoice,
  buildPlan,
  buildReauth,
  buildSubscription,
  cancellationConsequence,
  chargeDisclosure,
  dunningMessage,
  formatAgentAllowance,
  formatOverageRate,
  formatTrialOffer,
  invoiceDocumentState,
  resolvePlanPrice,
  statusTone,
  type PlanView,
} from './billingModel';

/**
 * The money rules, pinned.
 *
 * Everything here is something that, got wrong, either tells a customer an
 * untrue thing about their own money or renders a sentinel as a quantity. They
 * are pure functions precisely so they can be held to that standard without a
 * browser.
 */

const STANDARD = buildPlan({
  id: 3,
  slug: 'standard',
  name: 'Standard',
  monthly_price_cents: 94900,
  annual_price_cents: 949000,
  monthly_price_usd_cents: 1900,
  annual_price_usd_cents: 19000,
  credits_per_month: 3000,
  included_operator_seats: 2,
  extra_seat_price_cents: 29900,
  overage_rate_cents: 50,
  trial_days: 7,
  limits: { bots: 1, operators: 2 },
}) as PlanView;

const AGENCY = buildPlan({
  id: 5,
  slug: 'enterprise',
  name: 'Enterprise',
  monthly_price_cents: 599900,
  annual_price_cents: 5758800,
  credits_per_month: 10000,
  included_operator_seats: -1,
  limits: { bots: UNLIMITED_LIMIT },
}) as PlanView;

const INDIA = buildGeo({
  country: 'IN',
  country_source: 'stored',
  display_currency: 'INR',
  display_rate: 94.67,
  checkout_available: true,
});

const ABROAD = buildGeo({
  country: 'US',
  country_source: 'stored',
  display_currency: 'USD',
  display_rate: 94.67,
  checkout_available: true,
});

describe('price display against the charge currency', () => {
  it('shows and charges rupees for a domestic buyer, with nothing to disclose', () => {
    const price = resolvePlanPrice(STANDARD, 'monthly', INDIA);
    expect(price.displayCurrency).toBe('INR');
    expect(price.chargeCurrency).toBe(CHARGE_CURRENCY);
    expect(price.displayMinor).toBe(94900);
    expect(price.chargeMinor).toBe(94900);
    expect(price.crossCurrency).toBe(false);
    expect(chargeDisclosure(price)).toBeNull();
  });

  it('shows dollars to a foreign buyer while still charging rupees', () => {
    const price = resolvePlanPrice(STANDARD, 'monthly', ABROAD);
    expect(price.displayCurrency).toBe('USD');
    expect(price.displayMinor).toBe(1900);
    // The charge is the INR column, unconverted. This is the whole point:
    // Razorpay debits rupees whatever the page says.
    expect(price.chargeMinor).toBe(94900);
    expect(price.chargeCurrency).toBe('INR');
    expect(price.crossCurrency).toBe(true);
    expect(price.converted).toBe(false);
    expect(chargeDisclosure(price)).toContain('₹949');
  });

  it('derives the display figure from the rate only when the plan has no USD column, and says so', () => {
    const noUsd = buildPlan({
      id: 9,
      slug: 'legacy',
      name: 'Legacy',
      monthly_price_cents: 94670,
      limits: {},
    }) as PlanView;
    const price = resolvePlanPrice(noUsd, 'monthly', ABROAD);
    expect(price.converted).toBe(true);
    expect(price.displayMinor).toBe(1000);
    expect(price.chargeMinor).toBe(94670);
    expect(chargeDisclosure(price)).toContain("today's rate");
  });

  it('falls back to quoting the rupee charge rather than inventing a rate', () => {
    const noRate = buildGeo({ country: 'US', display_currency: 'USD', display_rate: 0 });
    const price = resolvePlanPrice(STANDARD, 'monthly', {
      ...noRate,
      // A plan with no USD column and no usable rate has no honest conversion.
    });
    const stripped = { ...STANDARD, monthlyPriceUsdMinor: null };
    const fallback = resolvePlanPrice(stripped, 'monthly', noRate);
    expect(price.displayCurrency).toBe('USD');
    expect(fallback.displayCurrency).toBe('INR');
    expect(fallback.crossCurrency).toBe(false);
  });

  it('treats an unresolved country as domestic, never as USD', () => {
    // The opposite default was a live money bug: the top-up modal rendered
    // $13/$50/$125 while Razorpay debited ₹1,000/₹4,000/₹10,000.
    const unresolved = buildGeo({ country: null, country_source: null, display_currency: null });
    expect(unresolved.displayCurrency).toBe('INR');
    expect(unresolved.countrySource).toBeNull();
  });

  it('never reports an IP-detected country as a stored one', () => {
    const detected = buildGeo({ country: 'DE', country_source: 'detected', display_currency: 'USD' });
    expect(detected.countrySource).toBe('detected');
  });
});

describe('the UNLIMITED sentinel', () => {
  it('is never rendered as a number in the chatbot allowance', () => {
    const label = formatAgentAllowance(AGENCY);
    expect(label).toBe('Unlimited chatbots');
    expect(label).not.toMatch(/-?1\b/);
  });

  it('distinguishes a plan that declares no allowance from one that allows none', () => {
    const silent = buildPlan({ id: 1, slug: 'bespoke', name: 'Bespoke', limits: {} }) as PlanView;
    const zero = buildPlan({ id: 2, slug: 'none', name: 'None', limits: { bots: 0 } }) as PlanView;
    expect(formatAgentAllowance(silent)).toBe('Not set');
    expect(formatAgentAllowance(zero)).toBe('No chatbots included');
  });

  it('pluralises a finite allowance', () => {
    expect(formatAgentAllowance(STANDARD)).toBe('1 chatbot');
  });
});

describe('overage and trial, both configured per plan and never shown before', () => {
  it('quotes the overage rate per credit', () => {
    expect(formatOverageRate(STANDARD.overageRateMinor)).toContain('per extra credit');
    expect(formatOverageRate(STANDARD.overageRateMinor)).toContain('0.50');
  });

  it('says nothing at all when the plan bills no overage', () => {
    expect(formatOverageRate(0)).toBeNull();
    expect(formatOverageRate(Number.NaN)).toBeNull();
  });

  it('quotes the trial length, or nothing for a plan with no trial', () => {
    expect(formatTrialOffer(STANDARD.trialDays)).toBe('7-day free trial');
    expect(formatTrialOffer(0)).toBeNull();
  });
});

describe('dunning', () => {
  it('reads a recoverable past-due subscription and offers the real deadline', () => {
    const dunning = buildDunning({
      past_due: true,
      recoverable: true,
      recovery_url: 'https://rzp.io/i/abc',
      days_left: 3,
      plan_name: 'Standard',
    });
    expect(dunning.recovery).toBe('recoverable');
    const message = dunningMessage(dunning);
    expect(message).toContain('could not take your last payment');
    expect(message).toContain('in 3 days');
    expect(message).toContain('Pay the outstanding amount');
  });

  it('does not offer a retry once the mandate is settled', () => {
    const dunning = buildDunning({ past_due: true, recoverable: false, days_left: 0 });
    expect(dunning.recovery).toBe('settled');
    expect(dunning.recoveryUrl).toBeNull();
    expect(dunningMessage(dunning)).toContain('pick a plan again');
  });

  it('says we could not check when the gateway did not answer, rather than claiming either way', () => {
    const dunning = buildDunning({ past_due: true, recoverable: null, days_left: 5 });
    expect(dunning.recovery).toBe('unknown');
    const message = dunningMessage(dunning);
    expect(message).toContain('could not reach the payment gateway');
    expect(message).not.toContain('no longer be retried');
  });

  it('is not past due when the endpoint says so', () => {
    expect(buildDunning({ past_due: false, recoverable: false }).pastDue).toBe(false);
  });
});

describe('the downgrade re-auth grace row, which is past_due but is not a failed payment', () => {
  it('is only built when the server marks it required', () => {
    expect(buildReauth(null)).toBeNull();
    expect(buildReauth({ required: false })).toBeNull();
  });

  it('carries the target plan and the grace deadline', () => {
    const reauth = buildReauth({
      required: true,
      reason: 'downgrade_reauth',
      target_plan_name: 'Starter',
      grace_until: '2026-09-01T00:00:00Z',
      days_left: 4,
    });
    expect(reauth?.targetPlanName).toBe('Starter');
    expect(reauth?.daysLeft).toBe(4);
  });
});

describe('invoice documents', () => {
  const NOW = Date.parse('2026-08-19T12:00:00Z');

  it('is ready when a rendered PDF exists', () => {
    expect(invoiceDocumentState('https://cdn/x.pdf', '2026-08-19T11:00:00Z', NOW)).toBe('ready');
  });

  it('is still preparing inside the render window', () => {
    const justIssued = new Date(NOW - INVOICE_RENDER_GRACE_MS / 2).toISOString();
    expect(invoiceDocumentState(null, justIssued, NOW)).toBe('preparing');
  });

  it('admits the PDF is not coming once the window has passed', () => {
    // The render is an ARQ job that can silently never run. A button that waits
    // forever is worse than one that says so.
    const older = new Date(NOW - INVOICE_RENDER_GRACE_MS * 2).toISOString();
    expect(invoiceDocumentState(null, older, NOW)).toBe('unavailable');
  });

  it('is unavailable, not preparing, for a row with no issue date at all', () => {
    expect(invoiceDocumentState(null, null, NOW)).toBe('unavailable');
  });
});

describe('invoice GST breakdown', () => {
  it('carries the components India requires', () => {
    const invoice = buildInvoice(
      {
        id: 12,
        amount_cents: 112000,
        currency: 'inr',
        status: 'paid',
        invoice_number: 'DB/26-27/000012',
        invoice_type: 'tax_invoice',
        issued_at: '2026-08-01T00:00:00Z',
        period_start: '2026-08-01T00:00:00Z',
        period_end: '2026-08-31T00:00:00Z',
        taxable_value_minor: 94900,
        total_tax_minor: 17082,
        cgst_minor: 8541,
        sgst_minor: 8541,
        igst_minor: 0,
        tax_rate_bps: 1800,
        hsn_sac: '998314',
        supply_kind: 'intra_state',
        is_export: false,
      },
      0,
      Date.parse('2026-08-19T00:00:00Z'),
    );
    expect(invoice.tax).not.toBeNull();
    expect(invoice.tax?.cgstMinor).toBe(8541);
    expect(invoice.tax?.rateBps).toBe(1800);
    expect(invoice.periodEnd).toBe('2026-08-31T00:00:00Z');
  });

  it('reports no breakdown at all on a legacy row, rather than a zero-rated one', () => {
    const invoice = buildInvoice({ id: 1, amount_cents: 94900, status: 'paid' }, 0);
    expect(invoice.tax).toBeNull();
  });

  it('negates a credit note so it cannot read as another charge', () => {
    const note = buildInvoice({ id: 2, amount_cents: 94900, invoice_type: 'credit_note' }, 0);
    expect(note.amountMinor).toBe(-94900);
  });
});

describe('status tones', () => {
  it('never asks for an info hue, which this system does not have', () => {
    const tones = ['active', 'trialing', 'past_due', 'paused', 'canceled', 'paid', 'pending', 'failed']
      .map(statusTone);
    expect(tones).not.toContain('info');
  });

  it('treats a trial as an entitlement state rather than a status colour', () => {
    expect(statusTone('trialing')).toBe('plan');
  });

  it('keeps paused and cancelled apart - one can resume and one has ended', () => {
    expect(statusTone('paused')).toBe('warning');
    expect(statusTone('canceled')).toBe('neutral');
  });
});

describe('what cancelling actually does', () => {
  const subscription = buildSubscription({
    status: 'active',
    billing_cycle: 'monthly',
    current_period_end: '2026-09-14T00:00:00Z',
  });

  it('names the real end date rather than saying it cannot be undone', () => {
    const consequence = cancellationConsequence(subscription, 'Standard', 0);
    expect(consequence.endsAt).toBe('2026-09-14T00:00:00Z');
    expect(consequence.lines[0]).toMatch(/14 Sept? 2026/);
    expect(consequence.lines.join(' ')).not.toContain('cannot be undone');
  });

  it('says the plan credit grant stops and unused plan credits are lost', () => {
    const consequence = cancellationConsequence(subscription, 'Standard', 0);
    expect(consequence.lines[1]).toContain('credit grant stops');
  });

  it('promises purchased top-up credits survive, and only when there are some', () => {
    const withTopup = cancellationConsequence(subscription, 'Standard', 1200);
    expect(withTopup.lines.join(' ')).toContain('1,200 purchased top-up credits');
    const without = cancellationConsequence(subscription, 'Standard', 0);
    expect(without.lines.join(' ')).not.toContain('purchased top-up');
  });

  it('still says something useful when the API gave no period end', () => {
    const open = cancellationConsequence(
      buildSubscription({ status: 'active' }),
      null,
      0,
    );
    expect(open.endsAt).toBeNull();
    expect(open.lines[0]).toContain('already paid for');
  });
});
