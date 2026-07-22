import { type ReactElement } from 'react';
import { Check, Minus } from 'lucide-react';
import { Button, StatusBadge, cn } from '../../../design-system';
import { formatCredits, formatMoneyMinor, type PlanView } from '../billingModel';
import type { BillingCycle } from './planMath';

/** Standard is the value pick — matches MOST_POPULAR_SLUG on the marketing site. */
const MOST_POPULAR_SLUG = 'standard';

type FeatureRow = { group: string; label: string } & (
  | { kind: 'bool'; value: (plan: PlanView) => boolean }
  | { kind: 'text'; value: (plan: PlanView) => string }
);

function limitText(value: number | undefined): string {
  if (value === -1) return 'Unlimited';
  if (value == null) return '—';
  return value.toLocaleString();
}

function historyText(value: number | undefined): string {
  if (value === -1) return 'Unlimited';
  if (!value) return '—';
  return value >= 365 && value % 365 === 0
    ? `${value / 365} year${value === 365 ? '' : 's'}`
    : `${value} days`;
}

// Data-driven from the live plan payload (`features` flags + `limits` counters)
// so the matrix stays correct as plans change — nothing here is hardcoded per
// tier. Rows are grouped; group headers render once as a spanning row.
const FEATURE_ROWS: readonly FeatureRow[] = [
  { group: 'Usage', label: 'Credits / month', kind: 'text', value: (p) => formatCredits(p.creditsPerMonth) },
  {
    group: 'Usage',
    label: 'Operator seats',
    kind: 'text',
    value: (p) => (p.includedSeats > 0 ? String(p.includedSeats) : 'None'),
  },
  { group: 'Usage', label: 'Crawl pages / month', kind: 'text', value: (p) => limitText(p.limits.max_crawl_pages) },
  { group: 'Usage', label: 'Chat history', kind: 'text', value: (p) => historyText(p.limits.chat_history_days) },
  { group: 'Features', label: 'Grounded AI answers', kind: 'bool', value: () => true },
  { group: 'Features', label: 'Live chat & handoff', kind: 'bool', value: (p) => Boolean(p.features.live_chat) },
  { group: 'Features', label: 'BANT lead qualification', kind: 'bool', value: (p) => Boolean(p.features.bant) },
  { group: 'Features', label: 'Webhooks + REST API', kind: 'bool', value: (p) => Boolean(p.features.webhooks) },
  { group: 'Features', label: 'Remove OyeChats branding', kind: 'bool', value: (p) => Boolean(p.features.branding_removable) },
  { group: 'Features', label: 'Online support', kind: 'bool', value: (p) => Boolean(p.features.online_support) },
];

const GROUP_ORDER: readonly string[] = ['Usage', 'Features'];

function priceLabel(plan: PlanView, cycle: BillingCycle): { amount: string; suffix: string | null } {
  if (!plan.isPaid) return { amount: 'Free', suffix: null };
  const useAnnual = cycle === 'annual' && plan.annualPriceMinor > 0;
  const minor = useAnnual ? plan.annualPriceMinor : plan.monthlyPriceMinor;
  return { amount: formatMoneyMinor(minor), suffix: useAnnual ? '/yr' : '/mo' };
}

function CellValue({ row, plan }: { row: FeatureRow; plan: PlanView }): ReactElement {
  if (row.kind === 'bool') {
    return row.value(plan) ? (
      <Check size={16} aria-label="Included" className="mx-auto text-[var(--ds-success)]" />
    ) : (
      <Minus size={16} aria-label="Not included" className="mx-auto text-[var(--ds-text-subtle)]" />
    );
  }
  return <span className="tabular-nums">{row.value(plan)}</span>;
}

export interface PlanMatrixProps {
  plans: PlanView[];
  currentSlug: string;
  cycle: BillingCycle;
  onCycleChange: (cycle: BillingCycle) => void;
  onSelect: (plan: PlanView) => void;
  /** Suppress the built-in cycle toggle when a parent already renders one. */
  hideToggle?: boolean;
}

/**
 * PlanMatrix — the plan-comparison surface: a single dense feature table
 * (rows = features, columns = plans) that replaces the old space-hungry card
 * grid. The current plan's column is highlighted, Standard carries a "Most
 * popular" marker, and a monthly/annual toggle switches the header prices.
 * Every value is read from the live plan payload — no hardcoded tiers.
 */
export function PlanMatrix({
  plans,
  currentSlug,
  cycle,
  onCycleChange,
  onSelect,
  hideToggle = false,
}: PlanMatrixProps): ReactElement {
  const ordered = [...plans].sort((a, b) => a.sortOrder - b.sortOrder);
  const maxDiscount = Math.max(0, ...plans.map((p) => p.annualDiscountPercent));

  const colClass = (plan: PlanView): string =>
    cn('px-4', plan.slug === currentSlug && 'bg-[var(--ds-accent-soft)]');

  return (
    <div className="space-y-4">
      {/* Monthly / Annual toggle */}
      {!hideToggle && (
        <div className="flex justify-end">
          <CycleToggle cycle={cycle} maxDiscount={maxDiscount} onCycleChange={onCycleChange} />
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-[var(--ds-border)]">
        <table className="w-full min-w-[720px] border-collapse text-[13px]">
          <caption className="sr-only">Compare plans</caption>
          {/* Header: plan name, price, CTA per column */}
          <thead>
            <tr>
              <th scope="col" className="w-[26%] px-4 py-5 text-left align-bottom" />
              {ordered.map((plan) => {
                const price = priceLabel(plan, cycle);
                const isCurrent = plan.slug === currentSlug;
                const popular = plan.slug === MOST_POPULAR_SLUG;
                return (
                  <th
                    key={plan.slug}
                    scope="col"
                    className={cn('py-5 text-left align-bottom', colClass(plan))}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[15px] font-semibold text-[var(--ds-text)]">{plan.name}</span>
                      {popular && (
                        <StatusBadge tone="accent" dot>
                          Popular
                        </StatusBadge>
                      )}
                    </div>
                    <div className="mt-2 flex items-baseline gap-1">
                      <span className="text-xl font-bold tracking-tight text-[var(--ds-text)]">{price.amount}</span>
                      {price.suffix && <span className="text-[12px] text-[var(--ds-text-muted)]">{price.suffix}</span>}
                    </div>
                    <div className="mt-3">
                      <Button
                        variant={isCurrent ? 'outline' : popular ? 'primary' : 'outline'}
                        size="sm"
                        className="w-full"
                        disabled={isCurrent}
                        onClick={() => onSelect(plan)}
                      >
                        {isCurrent ? 'Current' : 'Select'}
                      </Button>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {GROUP_ORDER.map((group) => (
              <GroupRows
                key={group}
                group={group}
                rows={FEATURE_ROWS.filter((row) => row.group === group)}
                plans={ordered}
                colClass={colClass}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The Monthly / Annual segmented control, shared by the matrix and the
 *  Compare-plans disclosure so both drive one cycle. */
export function CycleToggle({
  cycle,
  maxDiscount,
  onCycleChange,
}: {
  cycle: BillingCycle;
  maxDiscount: number;
  onCycleChange: (cycle: BillingCycle) => void;
}): ReactElement {
  return (
    <div
      role="group"
      aria-label="Billing cycle"
      className="inline-flex rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-subtle)] p-0.5 text-[13px]"
    >
      {(['monthly', 'annual'] as const).map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={cycle === key}
          onClick={() => onCycleChange(key)}
          className={cn(
            'rounded-md px-3 py-1.5 font-medium transition-colors',
            cycle === key
              ? 'bg-[var(--ds-bg-surface)] text-[var(--ds-text)] shadow-[var(--ds-shadow-sm)]'
              : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
          )}
        >
          {key === 'monthly' ? 'Monthly' : maxDiscount > 0 ? `Annual · save ${maxDiscount}%` : 'Annual'}
        </button>
      ))}
    </div>
  );
}

function GroupRows({
  group,
  rows,
  plans,
  colClass,
}: {
  group: string;
  rows: readonly FeatureRow[];
  plans: PlanView[];
  colClass: (plan: PlanView) => string;
}): ReactElement {
  return (
    <>
      <tr>
        <th
          scope="colgroup"
          colSpan={plans.length + 1}
          className="border-t border-[var(--ds-border)] bg-[var(--ds-bg-subtle)] px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-muted)]"
        >
          {group}
        </th>
      </tr>
      {rows.map((row) => (
        <tr key={row.label} className="border-t border-[var(--ds-border)]">
          <th
            scope="row"
            className="px-4 py-2.5 text-left font-medium text-[var(--ds-text-muted)]"
          >
            {row.label}
          </th>
          {plans.map((plan) => (
            <td
              key={plan.slug}
              className={cn('py-2.5 text-center text-[var(--ds-text)]', colClass(plan))}
            >
              <CellValue row={row} plan={plan} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
