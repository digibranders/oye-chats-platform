/**
 * ReferralsModal — the per-code referral detail.
 *
 * Rebuilt from the legacy `components/affiliate/ReferralsModal.jsx` in the new
 * design language. Shows how each referred bill splits (commission breakdown),
 * the aggregate monthly-equivalent money the code pulls in (all INR now — the
 * backend reports the billed currency, finding #8), and the list of customers
 * who signed up through the code (emails masked on the affiliate route).
 *
 * Loads on open through getAffiliateCodeReferrals; a 4xx/5xx surfaces inline so
 * the rest of the dashboard is unaffected.
 *
 * Backend reused verbatim (typed in services/api.d.ts): getAffiliateCodeReferrals.
 */
import { type ReactElement, useEffect, useState } from 'react';
import { AlertTriangle, Users } from 'lucide-react';
import { EmptyState, Modal, Skeleton, StatusBadge } from '../../design-system';
import { getAffiliateCodeReferrals } from '../../services/api';
import {
  type ReferralCustomer,
  type ReferralDetailView,
  formatInrMinor,
  formatPct,
  toReferralDetail,
} from './affiliateModel';

export interface ReferralsModalProps {
  open: boolean;
  onClose: () => void;
  codeId: number | null;
  codeName: string | null;
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function initials(name: string | null, email: string | null): string {
  const source = (name || email || '?').trim();
  return source.slice(0, 1).toUpperCase();
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function BreakdownStat({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--ds-text-subtle)]">{label}</div>
      <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-[var(--ds-text)]">{value}</div>
    </div>
  );
}

function MoneyStat({ label, value, accent }: { label: string; value: string; accent?: boolean }): ReactElement {
  return (
    <div className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 py-2.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--ds-text-subtle)]">{label}</div>
      <div
        className={
          accent
            ? 'mt-0.5 text-[16px] font-bold tabular-nums text-[var(--ds-accent-text)]'
            : 'mt-0.5 text-[16px] font-bold tabular-nums text-[var(--ds-text)]'
        }
      >
        {value}
      </div>
    </div>
  );
}

function CustomerRow({ customer }: { customer: ReferralCustomer }): ReactElement {
  return (
    <li className="flex items-center gap-3 py-3">
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--ds-accent-soft)] text-[12px] font-semibold text-[var(--ds-accent-text)]"
      >
        {initials(customer.name, customer.email)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-[var(--ds-text)]">{customer.name || 'Customer'}</span>
          {customer.planSlug && customer.planSlug !== 'free' && (
            <StatusBadge tone="neutral">{customer.planSlug}</StatusBadge>
          )}
        </div>
        {customer.email && <div className="truncate text-[12px] text-[var(--ds-text-subtle)]">{customer.email}</div>}
      </div>
      <div className="shrink-0 text-right">
        {customer.fullPriceMinor > 0 ? (
          <div className="text-[13px] font-semibold tabular-nums text-[var(--ds-text)]">
            {formatInrMinor(customer.affiliateEarnsMinor)}
            <span className="ml-1 text-[11px] font-normal text-[var(--ds-text-subtle)]">/mo to you</span>
          </div>
        ) : (
          <div className="text-[12px] text-[var(--ds-text-subtle)]">No active plan</div>
        )}
      </div>
    </li>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

export function ReferralsModal({ open, onClose, codeId, codeName }: ReferralsModalProps): ReactElement | null {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReferralDetailView | null>(null);
  const [requestedId, setRequestedId] = useState<number | null>(null);

  // Reset to the loading state during render (not in the effect) when a new
  // code opens — synchronous setState in an effect body triggers cascading
  // renders (and the react-hooks lint rule). This is the "adjust state during
  // render" pattern; the effect below only sets state after an await.
  if (open && codeId != null && requestedId !== codeId) {
    setRequestedId(codeId);
    setLoading(true);
    setError(null);
    setDetail(null);
  } else if (!open && requestedId !== null) {
    setRequestedId(null);
  }

  useEffect(() => {
    if (!open || codeId == null) return undefined;
    let cancelled = false;
    getAffiliateCodeReferrals(codeId)
      .then((raw) => {
        if (!cancelled) setDetail(toReferralDetail(raw));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(toMessage(err, 'Could not load referrals for this code.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, codeId]);

  if (!open || codeId == null) return null;

  const dist = detail?.distribution;
  const hasPayers = (dist?.payingReferrals ?? 0) > 0;

  return (
    <Modal open={open} onClose={onClose} size="lg" title={`Referrals — ${codeName ?? ''}`} description="Who signed up, and what each one earns you.">
      {loading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
          <Skeleton className="h-40 w-full" />
        </div>
      ) : error ? (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-3 py-2.5 text-[13px] text-[var(--ds-text)]">
          <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-danger)]" />
          {error}
        </div>
      ) : detail ? (
        <div className="space-y-6">
          {/* Commission split */}
          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold text-[var(--ds-text)]">How each bill splits</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <BreakdownStat label="You earn" value={formatPct(detail.breakdown.affiliatePct)} />
              <BreakdownStat label="Friend saves" value={formatPct(detail.breakdown.customerDiscountPct)} />
              <BreakdownStat label="Your pool" value={formatPct(detail.breakdown.poolPct)} />
              <BreakdownStat label="Unallocated" value={formatPct(detail.breakdown.codeUnusedPoolPct)} />
            </div>
          </section>

          {/* Monthly money */}
          {hasPayers && dist && (
            <section className="space-y-2">
              <h3 className="text-[13px] font-semibold text-[var(--ds-text)]">
                Monthly run-rate{' '}
                <span className="font-normal text-[var(--ds-text-subtle)]">
                  · {dist.payingReferrals} paying {dist.payingReferrals === 1 ? 'referral' : 'referrals'}
                </span>
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <MoneyStat label="Total billed" value={formatInrMinor(dist.monthlyTotalMinor)} />
                <MoneyStat label="You earn" value={formatInrMinor(dist.monthlyAffiliateMinor)} accent />
                <MoneyStat label="Customers save" value={formatInrMinor(dist.monthlyCustomerSavedMinor)} />
              </div>
              <p className="text-[11px] text-[var(--ds-text-subtle)]">
                Estimated at current plan prices; annual plans shown as their monthly equivalent.
              </p>
            </section>
          )}

          {/* Customers */}
          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold text-[var(--ds-text)]">
              Signed up{' '}
              <span className="font-normal text-[var(--ds-text-subtle)]">· {detail.referrals.length}</span>
            </h3>
            {detail.referrals.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No signups yet"
                description="Share this code’s link — the customers who subscribe through it will appear here."
              />
            ) : (
              <ul className="divide-y divide-[var(--ds-border)]">
                {detail.referrals.map((customer) => (
                  <CustomerRow key={customer.clientId} customer={customer} />
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </Modal>
  );
}
