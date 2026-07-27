import { type ReactElement, useEffect, useState } from 'react';
import { ArrowUpRight, CreditCard, Sparkles, Wallet, Zap } from 'lucide-react';
import { Button, Card, StatusBadge, cn } from '../../../design-system';
import { getCreditBalance } from '../../../services/api';
import { formatCredits, humanizeStatus, statusTone } from '../billingModel';
import { parseCreditBalance, type CreditBalance } from '../usage-model';

export interface BillingOverviewProps {
  planName: string;
  status: string;
  priceLabel: string;
  isPaid: boolean;
  renewalCaption: string;
  renewalLabel: string;
  /** Derived from `!cancelAtPeriodEnd` — false when the plan is set to end. */
  autoRenew: boolean;
  paymentLabel: string;
  paymentSub: string;
  /** The plan's monthly entitlement — the meter's fallback when the live balance can't load. */
  creditsPerMonth: number;
  onChangePlan: () => void;
  onBuyCredits: () => void;
  onViewUsage: () => void;
}

/**
 * BillingOverview — the Billing ▸ Overview tab. A management surface, not a
 * pricing page: it leads with the current subscription as a single authoritative
 * panel (plan · status · price · renewal · payment), paired with a real credits
 * meter (used / granted · reset date). The plan grid lives one tab over — this
 * answers "what am I on, what am I paying, how much have I used" at a glance.
 *
 * The credits meter is loaded here (not part of `useBillingData`) so the tab owns
 * its own async without blocking the rest of the page; a load failure degrades to
 * the plan's stated monthly entitlement rather than an empty bar.
 */
export function BillingOverview({
  planName,
  status,
  priceLabel,
  isPaid,
  renewalCaption,
  renewalLabel,
  autoRenew,
  paymentLabel,
  paymentSub,
  creditsPerMonth,
  onChangePlan,
  onBuyCredits,
  onViewUsage,
}: BillingOverviewProps): ReactElement {
  const [balance, setBalance] = useState<CreditBalance | null>(null);

  // Live credit position for the meter. setState only after the await, so there's
  // no synchronous set in the effect body. A failure leaves `balance` null and the
  // meter falls back to the plan entitlement below.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await getCreditBalance();
        if (!cancelled) setBalance(parseCreditBalance(raw));
      } catch {
        /* fall back to the plan entitlement */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Meter figures: prefer the live balance, else show the plan's monthly grant
  // with nothing consumed yet (honest — we don't invent a usage number).
  const grant = balance?.monthlyGrant || creditsPerMonth;
  const used = balance?.periodCreditsUsed ?? 0;
  const usedPct = grant > 0 ? Math.min(Math.round((used / grant) * 100), 100) : 0;
  const remaining = balance?.totalRemaining ?? grant;
  const low = balance?.lowBalance ?? false;
  const barColor = low ? 'var(--ds-danger)' : usedPct >= 80 ? 'var(--ds-warning)' : 'var(--ds-accent)';

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* ── Current-plan panel (the commercial relationship, in one place) ── */}
      <Card className="lg:col-span-2">
        <div className="flex h-full flex-col p-5 sm:p-6">
          <div className="mb-4 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-[var(--ds-text-subtle)]">
            <Sparkles size={14} aria-hidden="true" />
            Current plan
          </div>

          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
            {/* Plan + price */}
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <span className="text-2xl font-bold tracking-tight text-[var(--ds-text)]">{planName}</span>
                <StatusBadge tone={statusTone(status)}>{humanizeStatus(status)}</StatusBadge>
              </div>
              <p className="mt-1 text-[14px] text-[var(--ds-text-muted)]">{priceLabel}</p>
            </div>

            {/* Renewal + auto-renew */}
            <div className="text-left sm:text-right">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--ds-text-subtle)]">
                {renewalCaption}
              </p>
              <p className="mt-0.5 text-[15px] font-semibold text-[var(--ds-text)]">{renewalLabel}</p>
              {isPaid ? (
                <div className="mt-1.5">
                  <StatusBadge tone={autoRenew ? 'success' : 'warning'} dot>
                    Auto-renewal {autoRenew ? 'on' : 'off'}
                  </StatusBadge>
                </div>
              ) : (
                <p className="mt-1 text-[12px] text-[var(--ds-text-subtle)]">No paid subscription</p>
              )}
            </div>
          </div>

          {/* Payment reference — one honest line; the editable UI lives elsewhere. */}
          <div className="mt-4 flex items-start gap-2 border-t border-[var(--ds-border)] pt-4 text-[13px] text-[var(--ds-text-muted)]">
            <Wallet size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]" />
            <span>
              <span className="font-medium text-[var(--ds-text)]">{paymentLabel}</span>
              {' — '}
              {paymentSub}
            </span>
          </div>

          {/* Actions — one primary (change plan), one secondary (buy credits). */}
          <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
            <Button onClick={onChangePlan}>
              <ArrowUpRight size={15} aria-hidden="true" />
              {isPaid ? 'Change plan' : 'Choose a plan'}
            </Button>
            <Button variant="outline" onClick={onBuyCredits}>
              <CreditCard size={15} aria-hidden="true" />
              Buy credits
            </Button>
          </div>
        </div>
      </Card>

      {/* ── Credits meter (used / granted · reset) — a correctness surface ── */}
      <Card>
        <div className="flex h-full flex-col p-5 sm:p-6">
          <div className="mb-4 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-[var(--ds-text-subtle)]">
            <Zap size={14} aria-hidden="true" />
            Monthly credits
          </div>

          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-bold tabular-nums tracking-tight text-[var(--ds-text)]">
              {grant > 0 ? formatCredits(remaining) : '—'}
            </span>
            {grant > 0 && <span className="text-[13px] text-[var(--ds-text-muted)]">left</span>}
          </div>

          {grant > 0 ? (
            <>
              <div
                className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]"
                role="progressbar"
                aria-valuenow={usedPct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Monthly credits used"
              >
                <div
                  className="h-full rounded-full transition-[width]"
                  style={{ width: `${usedPct}%`, backgroundColor: barColor }}
                />
              </div>
              <p className={cn('mt-2 text-[12px]', low ? 'text-[var(--ds-danger)]' : 'text-[var(--ds-text-muted)]')}>
                {formatCredits(used)} of {formatCredits(grant)} used
                {balance?.resetsAt ? ` · resets ${formatMeterDate(balance.resetsAt)}` : ''}
              </p>
            </>
          ) : (
            <p className="mt-2 text-[13px] text-[var(--ds-text-muted)]">
              Credits are included once you start a paid plan.
            </p>
          )}

          <button
            type="button"
            onClick={onViewUsage}
            className="mt-auto inline-flex items-center gap-1 pt-5 text-[13px] font-medium text-[var(--ds-accent-text)] transition-colors hover:text-[var(--ds-accent)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
          >
            View usage
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        </div>
      </Card>
    </div>
  );
}

/** Compact date for the meter caption ("resets 1 Aug"). */
function formatMeterDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
