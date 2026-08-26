import { type ReactElement } from 'react';
import { Check, Minus } from 'lucide-react';
import { Button, StatusBadge, cn } from '../../../design-system';
import {
  UNLIMITED_LIMIT,
  formatCredits,
  formatMoneyMinor,
  maxAnnualSavingPercent,
  type PlanView,
} from '../billingModel';
import type { BillingCycle } from './planPricing';
import {
  planIncludesEmailVerification,
  planIncludesVisitorIntelligence,
} from '../../../lib/planGates';

/** Standard is the value pick - matches MOST_POPULAR_SLUG on the marketing site. */
const MOST_POPULAR_SLUG = 'standard';

type FeatureRow = { group: string; label: string } & (
  | { kind: 'bool'; value: (plan: PlanView) => boolean }
  | { kind: 'text'; value: (plan: PlanView) => string }
);

function limitText(value: number | undefined): string {
  if (value === -1) return 'Unlimited';
  if (value == null) return '-';
  return value.toLocaleString();
}

function historyText(value: number | undefined): string {
  if (value === -1) return 'Unlimited';
  if (!value) return '-';
  return value >= 365 && value % 365 === 0
    ? `${value / 365} year${value === 365 ? '' : 's'}`
    : `${value} days`;
}

// Data-driven from the live plan payload (`features` flags + `limits` counters)
// so the matrix stays correct as plans change - nothing here is hardcoded per
// tier. Rows are grouped; group headers render once as a spanning row.
const FEATURE_ROWS: readonly FeatureRow[] = [
  {
    group: 'Usage',
    // Leads the table: the agent is the unit of the product - credits, seats
    // and crawl pages all meter something an agent does - and this is the only
    // row on which the top tier differs from every other, which is the whole
    // reason that tier exists. Below the fold it would have been invisible on
    // the one surface built for comparing tiers.
    //
    // "included" is load-bearing, not filler. `limits.bots` is a per-
    // SUBSCRIPTION quota, not an account ceiling: `bot_routes.create_bot`
    // denies the second agent and then re-allows it through
    // `_plan_bots_limit_allows` only while the plan's quota still covers the
    // count, and every agent past that is sold its own subscription via
    // `POST /bots/checkout`. A bare "AI agents / 1" would therefore advertise a
    // hard cap of one agent that the server does not enforce.
    //
    // But "included" alone only carries that caveat for a reader who already
    // knows there is something to be caveated, and this row LEADS the table,
    // which maximises the misread. The concrete failure is an under-sell, and
    // it hits the exact customer this catalogue's top tier was written for: an
    // agency needing three agents reads `1 / 1 / 1 / 1 / Unlimited`, concludes
    // that more than one agent requires Enterprise, and either overpays for it
    // or leaves - when three Standard subscriptions cost roughly half of one
    // Enterprise and are a path the server fully supports. So the label states
    // the extension outright rather than implying it.
    //
    // The over-sell direction stays clean: "1" on Free is honest (one agent is
    // what a free account is granted, and the extension is a purchase), and
    // "Unlimited" on Enterprise is honest for the account-scoped subscription
    // Launch Studio mints. Both qualifiers sit in the LABEL so the cells stay
    // bare values, like every other row - the matrix has no footnote mechanism
    // and one row does not justify inventing one.
    label: 'AI chatbots included (add more anytime)',
    kind: 'text',
    // Same `limitText` the crawl-pages row uses, so the `-1` UNLIMITED sentinel
    // renders as "Unlimited" rather than as a count of minus one, and a plan
    // row carrying no `bots` quota at all renders "-" instead of claiming a
    // number the backend would read as zero.
    value: (p) => limitText(p.limits.bots),
  },
  { group: 'Usage', label: 'Credits / month', kind: 'text', value: (p) => formatCredits(p.creditsPerMonth) },
  {
    group: 'Usage',
    label: 'Operator seats',
    kind: 'text',
    // `-1` is the UNLIMITED sentinel, not a count, a bare `> 0` test filed the
    // unlimited-seat tier under "None", i.e. the exact opposite of what it sells.
    value: (p) =>
      p.includedSeats === UNLIMITED_LIMIT
        ? 'Unlimited'
        : p.includedSeats > 0
          ? String(p.includedSeats)
          : 'None',
  },
  { group: 'Usage', label: 'Crawl pages / month', kind: 'text', value: (p) => limitText(p.limits.max_crawl_pages) },
  { group: 'Usage', label: 'Chat history', kind: 'text', value: (p) => historyText(p.limits.chat_history_days) },
  { group: 'Features', label: 'Grounded AI answers', kind: 'bool', value: () => true },
  { group: 'Features', label: 'Live chat & handoff', kind: 'bool', value: (p) => Boolean(p.features.live_chat) },
  { group: 'Features', label: 'BANT lead qualification', kind: 'bool', value: (p) => Boolean(p.features.bant) },
  { group: 'Features', label: 'Webhooks + REST API', kind: 'bool', value: (p) => Boolean(p.features.webhooks) },
  // No "Remove OyeChats branding" row. Branding removal is a paid add-on bought
  // on top of any paid plan, not a plan inclusion, so a row here would compare
  // tiers on something no tier carries - a column of crosses that reads as "you
  // cannot have this", next to a Billing card that sells it on every paid plan.
  { group: 'Features', label: 'Online support', kind: 'bool', value: (p) => Boolean(p.features.online_support) },
  // These two are gated by SLUG on the server (`plan_entitlements_service`),
  // not by a `features` flag, no plan row carries a key for either, so reading
  // `p.features.*` here would render an empty column on every tier. Without
  // them the matrix showed Standard and Professional as identical on every
  // boolean, which is what the plan payload literally says: the only thing
  // Professional actually adds over Standard is the company lookup, and a
  // customer comparing the two could not see it.
  {
    group: 'Features',
    label: 'Email verification',
    kind: 'bool',
    value: (p) => planIncludesEmailVerification(p.slug),
  },
  {
    group: 'Features',
    label: 'Visitor company intelligence',
    kind: 'bool',
    value: (p) => planIncludesVisitorIntelligence(p.slug),
  },
];

const GROUP_ORDER: readonly string[] = ['Usage', 'Features'];

// On the annual cycle, lead with the monthly-EQUIVALENT (annual ÷ 12) and
// caption the annual total billed - mirroring the public pricing page so the
// headline stays comparable across cycles.
function priceLabel(
  plan: PlanView,
  cycle: BillingCycle,
): { amount: string; suffix: string | null; billed: string | null } {
  if (plan.isContactSales) return { amount: 'Custom', suffix: null, billed: null };
  if (!plan.isPaid) return { amount: 'Free', suffix: null, billed: null };
  const useAnnual = cycle === 'annual' && plan.annualPriceMinor > 0;
  if (useAnnual) {
    return {
      amount: formatMoneyMinor(Math.round(plan.annualPriceMinor / 12)),
      suffix: '/mo',
      billed: `Billed ${formatMoneyMinor(plan.annualPriceMinor)}/yr`,
    };
  }
  return { amount: formatMoneyMinor(plan.monthlyPriceMinor), suffix: '/mo', billed: null };
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
  /** Current subscription status - a trialing current column offers activation. */
  currentStatus?: string | null;
  /** Retires every column CTA while a paid plan is still activating. */
  selectionDisabled?: boolean;
}

/**
 * PlanMatrix - the plan-comparison surface: a single dense feature table
 * (rows = features, columns = plans) that replaces the old space-hungry card
 * grid. The current plan's column is highlighted, Standard carries a "Most
 * popular" marker, and a monthly/annual toggle switches the header prices.
 * Every value is read from the live plan payload - no hardcoded tiers.
 */
export function PlanMatrix({
  plans,
  currentSlug,
  cycle,
  onCycleChange,
  onSelect,
  hideToggle = false,
  currentStatus = null,
  selectionDisabled = false,
}: PlanMatrixProps): ReactElement {
  const ordered = [...plans].sort((a, b) => a.sortOrder - b.sortOrder);
  const maxSavingPercent = maxAnnualSavingPercent(plans);
  // A trialing/post-trial current column can convert to paid from its own CTA.
  const trialing = currentStatus === 'trialing' || currentStatus === 'trial_expired';

  const colClass = (plan: PlanView): string =>
    cn('px-4', plan.slug === currentSlug && 'bg-[var(--ds-accent-soft)]');

  return (
    <div className="space-y-4">
      {/* Monthly / Annual toggle */}
      {!hideToggle && (
        <div className="flex justify-end">
          <CycleToggle
            cycle={cycle}
            maxSavingPercent={maxSavingPercent}
            onCycleChange={onCycleChange}
          />
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
                const isTrialingCurrent = isCurrent && trialing;
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
                    {price.billed && (
                      <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-[var(--ds-text-subtle)]">
                        {price.billed}
                      </div>
                    )}
                    <div className="mt-3">
                      <Button
                        variant={
                          isTrialingCurrent ? 'primary' : isCurrent ? 'outline' : popular ? 'primary' : 'outline'
                        }
                        size="sm"
                        className="w-full"
                        disabled={selectionDisabled || (isCurrent && !isTrialingCurrent)}
                        title={
                          selectionDisabled
                            ? 'Your plan is activating - no need to pay again.'
                            : undefined
                        }
                        onClick={() => onSelect(plan)}
                      >
                        {isTrialingCurrent
                          ? 'Subscribe'
                          : isCurrent
                            ? 'Current'
                            : plan.isContactSales
                              ? 'Contact'
                              : 'Select'}
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
  maxSavingPercent,
  onCycleChange,
}: {
  cycle: BillingCycle;
  /**
   * Best annual saving across the plan set, from {@link maxAnnualSavingPercent}
   * - i.e. derived from the displayed prices, in the displayed currency, and
   * rounded down. Rendered as "save up to X%" because it is a maximum, not a
   * discount every plan in the set grants. 0 drops the saving copy entirely.
   */
  maxSavingPercent: number;
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
          {key === 'monthly'
            ? 'Monthly'
            : maxSavingPercent > 0
              ? `Annual · save up to ${maxSavingPercent}%`
              : 'Annual'}
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
