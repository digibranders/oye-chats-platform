import { type ReactElement, type ReactNode, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Building2,
  CalendarClock,
  Check,
  CreditCard,
  Download,
  ExternalLink,
  FileText,
  Info,
  Minus,
  Plus,
  ReceiptText,
  RefreshCw,
  Sparkles,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  PageContainer,
  SectionHeader,
  Skeleton,
  StatusBadge,
  cn,
} from '../../design-system';
import { MetricCard } from '../../design-system/components/MetricCard';
import { DataTable, type Column } from '../../design-system/components/DataTable';
import { Tabs } from '../../design-system/components/Tabs';
import { useBillingData } from './useBillingData';
import { PlanModal } from './billing/PlanModal';
import { TopupModal } from './billing/TopupModal';
import { SeatChangeDialog } from './billing/SeatChangeDialog';
import { BillingDetailsModal } from './billing/BillingDetailsModal';
import type { BillingCycle } from './billing/planMath';
import {
  formatCredits,
  formatDate,
  formatMoneyMinor,
  humanizeStatus,
  INVOICE_KIND_LABEL,
  statusTone,
  type BillingDetailsView,
  type InvoiceView,
  type PlanView,
  type SubscriptionView,
} from './billingModel';

type TabKey = 'plan' | 'invoices' | 'details';

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'plan', label: 'Plan & seats' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'details', label: 'Billing details' },
];

/**
 * BillingPage — the Workspace ▸ Billing surface. One job: answer
 * "What am I paying?". Shows the current plan and its cost, operator seats,
 * the payment method on file, issued invoices (real, downloadable), and the
 * buyer's tax/billing identity.
 *
 * Credit balance and usage live on the separate Workspace ▸ Usage page — this
 * page is deliberately about money owed and paid, not consumption.
 *
 * Plan-change, seat, top-up, and billing-detail mutations open the redesigned
 * checkout modals (`billing/`), which reuse the legacy money-path logic against
 * the real Razorpay + subscription endpoints. Every success reloads the page
 * and surfaces a status message in the aria-live notice region.
 */
export function BillingPage(): ReactElement {
  const { loading, error, data, reload } = useBillingData();
  const [tab, setTab] = useState<TabKey>('plan');
  const [notice, setNotice] = useState<string | null>(null);

  // Checkout modal state.
  const [planModal, setPlanModal] = useState<{ open: boolean; initialSlug: string | null }>({
    open: false,
    initialSlug: null,
  });
  const [topupOpen, setTopupOpen] = useState(false);
  const [seatDialog, setSeatDialog] = useState<{ open: boolean; delta: number }>({
    open: false,
    delta: 1,
  });
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Every successful mutation lands here: surface the message, refetch billing.
  const handleSuccess = (message: string): void => {
    setNotice(message);
    reload();
  };

  const openPlanModal = (initialSlug: string | null = null): void =>
    setPlanModal({ open: true, initialSlug });

  const subscription = data?.subscription ?? null;
  const plan = data?.plan ?? null;

  // Seat math mirrors legacy pages/Billing.jsx: a plan with zero included seats
  // (Free) always shows 0 total, ignoring the Subscription model's legacy
  // default of operator_quantity = 1.
  const includedSeats = plan?.includedSeats ?? 0;
  const totalSeats = useMemo(() => {
    if (includedSeats === 0) return 0;
    return subscription && subscription.seats > 0 ? subscription.seats : includedSeats;
  }, [includedSeats, subscription]);

  const cycleLabel = subscription?.billingCycle === 'annual' ? 'year' : 'month';
  const priceMinor =
    plan && plan.isPaid
      ? subscription?.billingCycle === 'annual'
        ? plan.annualPriceMinor
        : plan.monthlyPriceMinor
      : 0;
  const priceLabel = plan?.isPaid ? `${formatMoneyMinor(priceMinor)}/${cycleLabel}` : 'Free';

  // A subscription set to cancel at period end will NOT renew — surfacing it as
  // "Renews" would be dishonest. scheduledChange (a downgrade) takes precedence
  // since it has its own banner; a bare pending cancellation is otherwise
  // invisible on the page.
  const pendingCancel = Boolean(
    subscription?.cancelAtPeriodEnd && !subscription.scheduledChange,
  );
  const renewalLabel = subscription?.trialEnd
    ? formatDate(subscription.trialEnd)
    : formatDate(subscription?.currentPeriodEnd ?? null);
  const renewalCaption = subscription?.trialEnd
    ? 'Trial ends'
    : pendingCancel
      ? 'Plan ends'
      : 'Renews';

  return (
    <PageContainer
      title="Billing"
      description="Your plan, seats, invoices, and payment method — everything you're paying for."
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setTopupOpen(true)}>
            <Wallet size={16} aria-hidden="true" />
            Buy credits
          </Button>
          <Button variant="outline" onClick={reload} disabled={loading}>
            <RefreshCw size={16} aria-hidden="true" />
            Refresh
          </Button>
        </div>
      }
    >
      {/* Scaffold notice for Razorpay-gated actions. Kept permanently mounted
          (no `empty:hidden`) so the aria-live region is in the a11y tree before
          content is injected — several screen readers skip announcing regions
          that were display:none at mutation time. */}
      <div aria-live="polite">
        {notice && (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-[var(--ds-info)] bg-[var(--ds-info-soft)] px-4 py-3 text-[13px] text-[var(--ds-text)]">
            <span className="flex items-start gap-2">
              <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-info)]" />
              {notice}
            </span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss message"
              className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {loading && <LoadingState />}

      {error && !loading && (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn’t load your billing"
          description={error}
          action={<Button onClick={reload}>Try again</Button>}
        />
      )}

      {data && !loading && subscription && (
        <>
          {/* At-a-glance money summary — always visible above the tabs. */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard label="Current plan" value={plan?.name ?? 'Free'} icon={Sparkles} />
            <MetricCard
              label={plan?.isPaid ? `Cost per ${cycleLabel}` : 'Cost'}
              value={priceLabel}
              icon={Wallet}
            />
            <MetricCard label="Operator seats" value={totalSeats} icon={Users} />
            <MetricCard label={renewalCaption} value={renewalLabel} icon={CalendarClock} />
          </div>

          {/* Scheduled downgrade — applies account-wide, so it sits above tabs. */}
          {subscription.scheduledChange && (
            <ScheduledChangeBanner
              planName={subscription.scheduledChange.planName}
              effectiveAt={subscription.scheduledChange.effectiveAt}
              currentPlanName={plan?.name ?? 'your current plan'}
            />
          )}

          {/* Pending full cancellation — the plan ends and won't renew. */}
          {pendingCancel && (
            <CancellationBanner
              endsAt={subscription.currentPeriodEnd}
              planName={plan?.name ?? 'your current plan'}
            />
          )}

          <Tabs
            ariaLabel="Billing sections"
            value={tab}
            onChange={(key) => setTab(key as TabKey)}
            tabs={TABS.map((item) => ({ key: item.key, label: item.label }))}
          />

          {/* All three panels stay mounted (inactive ones `hidden`) so every
              tab's aria-controls target resolves in the DOM, per the WAI-ARIA
              tabs contract. */}
          <TabPanel tabKey="plan" active={tab === 'plan'}>
            <PlanAndSeatsTab
              plan={plan}
              subscription={subscription}
              totalSeats={totalSeats}
              includedSeats={includedSeats}
              availablePlans={data.availablePlans}
              onChangePlan={() => openPlanModal(null)}
              onSelectPlan={(slug) => openPlanModal(slug)}
              onAddSeat={() => setSeatDialog({ open: true, delta: 1 })}
              onRemoveSeat={() => setSeatDialog({ open: true, delta: -1 })}
            />
          </TabPanel>

          <TabPanel tabKey="invoices" active={tab === 'invoices'}>
            <InvoicesTab invoices={data.invoices} hasError={data.invoicesError} onRetry={reload} />
          </TabPanel>

          <TabPanel tabKey="details" active={tab === 'details'}>
            <BillingDetailsTab details={data.details} onEdit={() => setDetailsOpen(true)} />
          </TabPanel>
        </>
      )}

      {/* Checkout modals — reuse the legacy money-path against real endpoints. */}
      {planModal.open && (
        <PlanModal
          open={planModal.open}
          onClose={() => setPlanModal({ open: false, initialSlug: null })}
          currentPlanSlug={plan?.slug ?? 'free'}
          currentSubscriptionStatus={subscription?.status ?? null}
          currentBillingCycle={(subscription?.billingCycle as BillingCycle) ?? 'monthly'}
          hasActiveSubscription={Boolean(subscription?.hasActive)}
          trialEndIso={subscription?.trialEnd ?? null}
          initialSlug={planModal.initialSlug}
          onSuccess={handleSuccess}
        />
      )}

      <TopupModal open={topupOpen} onClose={() => setTopupOpen(false)} onSuccess={handleSuccess} />

      {seatDialog.open && (
        <SeatChangeDialog
          open={seatDialog.open}
          onClose={() => setSeatDialog({ open: false, delta: seatDialog.delta })}
          delta={seatDialog.delta}
          currentSeats={totalSeats}
          seatPriceLabel={plan ? `${formatMoneyMinor(plan.extraSeatPriceMinor)}/mo` : '—'}
          onSuccess={handleSuccess}
        />
      )}

      <BillingDetailsModal
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        onSuccess={handleSuccess}
      />
    </PageContainer>
  );
}

// ── Tab panel wrapper (a11y association with the Tabs pattern) ────────────────

function TabPanel({
  tabKey,
  active,
  children,
}: {
  tabKey: TabKey;
  active: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      role="tabpanel"
      id={`tabpanel-${tabKey}`}
      aria-labelledby={`tab-${tabKey}`}
      hidden={!active}
      tabIndex={active ? 0 : -1}
      className="space-y-6 focus-visible:outline-none"
    >
      {children}
    </div>
  );
}

// ── Plan & seats ──────────────────────────────────────────────────────────────

interface PlanAndSeatsTabProps {
  plan: PlanView | null;
  subscription: SubscriptionView;
  totalSeats: number;
  includedSeats: number;
  availablePlans: PlanView[];
  onChangePlan: () => void;
  onSelectPlan: (slug: string) => void;
  onAddSeat: () => void;
  onRemoveSeat: () => void;
}

function PlanAndSeatsTab({
  plan,
  subscription,
  totalSeats,
  includedSeats,
  availablePlans,
  onChangePlan,
  onSelectPlan,
  onAddSeat,
  onRemoveSeat,
}: PlanAndSeatsTabProps): ReactElement {
  const isPaid = Boolean(plan?.isPaid);
  const cycleLabel = subscription.billingCycle === 'annual' ? 'year' : 'month';
  const priceMinor =
    plan && plan.isPaid
      ? subscription.billingCycle === 'annual'
        ? plan.annualPriceMinor
        : plan.monthlyPriceMinor
      : 0;
  const seatPriceLabel = plan ? `${formatMoneyMinor(plan.extraSeatPriceMinor)}/mo` : '—';

  const paymentDescription = subscription.paymentProvider
    ? `Billed securely via ${capitalize(subscription.paymentProvider)} — UPI, card, or NetBanking.`
    : 'No payment method on file yet. Choose a paid plan to add one.';

  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Current plan */}
        <Card className="flex flex-col">
          <CardContent className="flex flex-1 flex-col pt-5">
            <div className="flex items-center gap-2">
              <CreditCard size={16} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
              <h3 className="text-[15px] font-semibold text-[var(--ds-text)]">Current plan</h3>
            </div>
            <div className="mt-4 flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight text-[var(--ds-text)]">
                {plan?.name ?? 'Free'}
              </span>
              <StatusBadge tone={statusTone(subscription.status)}>
                {humanizeStatus(subscription.status)}
              </StatusBadge>
            </div>
            <dl className="mt-4 space-y-2 text-[13px]">
              <DetailRow
                label="Cost"
                value={isPaid ? `${formatMoneyMinor(priceMinor)} / ${cycleLabel}` : 'No paid subscription'}
              />
              <DetailRow
                label="Credits"
                value={
                  plan && plan.creditsPerMonth > 0
                    ? `${formatCredits(plan.creditsPerMonth)} / month`
                    : '—'
                }
              />
              <DetailRow label="Billing cycle" value={capitalize(subscription.billingCycle)} />
            </dl>
            <div className="mt-auto pt-5">
              <Button onClick={onChangePlan}>
                <ArrowUpRight size={16} aria-hidden="true" />
                {isPaid ? 'Change plan' : 'Choose a plan'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Operator seats */}
        <Card className="flex flex-col">
          <CardContent className="flex flex-1 flex-col pt-5">
            <div className="flex items-center gap-2">
              <Users size={16} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
              <h3 className="text-[15px] font-semibold text-[var(--ds-text)]">Operator seats</h3>
            </div>
            <div className="mt-4 flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight text-[var(--ds-text)]">
                {totalSeats}
              </span>
              <span className="text-[13px] text-[var(--ds-text-muted)]">total seats</span>
            </div>
            <dl className="mt-4 space-y-2 text-[13px]">
              <DetailRow
                label="Included"
                value={
                  includedSeats > 0
                    ? `${includedSeats} with your plan`
                    : 'Free plan includes none'
                }
              />
              <DetailRow label="Extra seat" value={includedSeats > 0 ? `${seatPriceLabel} each` : '—'} />
            </dl>
            <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
              {includedSeats === 0 ? (
                <Button onClick={onChangePlan}>
                  <ArrowUpRight size={16} aria-hidden="true" />
                  Upgrade to add seats
                </Button>
              ) : (
                <>
                  <Button variant="outline" onClick={onAddSeat}>
                    <Plus size={16} aria-hidden="true" />
                    Add seat
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={onRemoveSeat}
                    disabled={totalSeats <= includedSeats}
                    title={
                      totalSeats <= includedSeats
                        ? `You can’t go below the ${includedSeats} included with your plan`
                        : undefined
                    }
                  >
                    <Minus size={16} aria-hidden="true" />
                    Remove seat
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Payment method */}
        <Card className="flex flex-col">
          <CardContent className="flex flex-1 flex-col pt-5">
            <div className="flex items-center gap-2">
              <Wallet size={16} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
              <h3 className="text-[15px] font-semibold text-[var(--ds-text)]">Payment method</h3>
            </div>
            <div className="mt-4 flex items-baseline gap-2">
              <span className="text-2xl font-bold tracking-tight text-[var(--ds-text)]">
                {subscription.paymentProvider ? capitalize(subscription.paymentProvider) : 'None'}
              </span>
            </div>
            <p className="mt-4 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
              {paymentDescription}
            </p>
            <div className="mt-auto pt-5">
              <Button
                variant="outline"
                onClick={onChangePlan}
                disabled={!subscription.paymentProvider}
              >
                <CreditCard size={16} aria-hidden="true" />
                Manage payment method
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Plan comparison — real catalog from getSubscriptionPlans. */}
      {availablePlans.length > 0 && (
        <section aria-label="Available plans" className="space-y-4">
          <SectionHeader
            title="Compare plans"
            description="Pick the plan that matches how much you expect your AI to handle."
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {availablePlans.map((candidate) => (
              <PlanOption
                key={candidate.slug}
                plan={candidate}
                current={candidate.slug === plan?.slug}
                cycle={subscription.billingCycle}
                onSelect={() => onSelectPlan(candidate.slug)}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function PlanOption({
  plan,
  current,
  cycle,
  onSelect,
}: {
  plan: PlanView;
  current: boolean;
  cycle: string;
  onSelect: () => void;
}): ReactElement {
  // Match the pricing shown in the summary card above: when the customer bills
  // annually, compare on the annual figure (falling back to monthly for plans
  // that carry no annual price) so the current tier's number is consistent.
  const useAnnual = cycle === 'annual' && plan.annualPriceMinor > 0;
  const priceMinor = useAnnual ? plan.annualPriceMinor : plan.monthlyPriceMinor;
  const cycleSuffix = useAnnual ? '/yr' : '/mo';
  return (
    <Card
      className={cn(
        'flex flex-col',
        current ? 'border-[var(--ds-accent)] ring-1 ring-[var(--ds-accent)]' : '',
      )}
    >
      <CardContent className="flex flex-1 flex-col pt-5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[15px] font-semibold text-[var(--ds-text)]">{plan.name}</span>
        {current && (
          <StatusBadge tone="accent" dot>
            Current
          </StatusBadge>
        )}
      </div>
      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-2xl font-bold tracking-tight text-[var(--ds-text)]">
          {plan.isPaid ? formatMoneyMinor(priceMinor) : 'Free'}
        </span>
        {plan.isPaid && <span className="text-[13px] text-[var(--ds-text-muted)]">{cycleSuffix}</span>}
      </div>
      <ul className="mt-4 flex-1 space-y-2 text-[13px] text-[var(--ds-text-muted)]">
        <li className="flex items-center gap-2">
          <Check size={14} aria-hidden="true" className="shrink-0 text-[var(--ds-success)]" />
          {plan.creditsPerMonth > 0 ? `${formatCredits(plan.creditsPerMonth)} credits / month` : 'Trial credits'}
        </li>
        <li className="flex items-center gap-2">
          <Check size={14} aria-hidden="true" className="shrink-0 text-[var(--ds-success)]" />
          {plan.includedSeats > 0
            ? `${plan.includedSeats} operator seat${plan.includedSeats === 1 ? '' : 's'}`
            : 'No operator seats'}
        </li>
      </ul>
      <div className="mt-5">
        <Button
          variant={current ? 'outline' : 'primary'}
          onClick={onSelect}
          disabled={current}
          className="w-full"
        >
          {current ? 'Your plan' : 'Select plan'}
        </Button>
      </div>
      </CardContent>
    </Card>
  );
}

// ── Invoices ──────────────────────────────────────────────────────────────────

function InvoicesTab({
  invoices,
  hasError,
  onRetry,
}: {
  invoices: InvoiceView[];
  hasError: boolean;
  onRetry: () => void;
}): ReactElement {
  if (hasError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn’t load your invoices"
        description="Your tax invoices and receipts couldn’t be reached. Check your connection and try again."
        action={<Button onClick={onRetry}>Try again</Button>}
      />
    );
  }

  const columns: Column<InvoiceView>[] = [
    {
      key: 'number',
      header: 'Invoice',
      render: (invoice) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-[var(--ds-text)]">
            {invoice.number ?? INVOICE_KIND_LABEL[invoice.kind]}
          </p>
          {invoice.description && (
            <p className="truncate text-[12px] text-[var(--ds-text-subtle)]">{invoice.description}</p>
          )}
        </div>
      ),
    },
    {
      key: 'kind',
      header: 'Type',
      render: (invoice) => (
        <span className="text-[var(--ds-text-muted)]">{INVOICE_KIND_LABEL[invoice.kind]}</span>
      ),
    },
    {
      key: 'date',
      header: 'Date',
      render: (invoice) => <span className="text-[var(--ds-text-muted)]">{formatDate(invoice.date)}</span>,
    },
    {
      key: 'amountMinor',
      header: 'Amount',
      align: 'right',
      render: (invoice) => (
        <span
          className={cn(
            'tabular-nums font-medium',
            invoice.kind === 'credit_note'
              ? 'text-[var(--ds-text-muted)]'
              : 'text-[var(--ds-text)]',
          )}
        >
          {formatMoneyMinor(invoice.amountMinor, invoice.currency)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (invoice) => (
        <StatusBadge tone={statusTone(invoice.status)} className="capitalize">
          {invoice.status}
        </StatusBadge>
      ),
    },
    {
      key: 'id',
      header: <span className="sr-only">Download</span>,
      align: 'right',
      width: '9rem',
      render: (invoice) => <InvoiceDownload invoice={invoice} />,
    },
  ];

  return (
    <>
      <SectionHeader
        title="Invoices & receipts"
        description="Every payment produces a numbered tax document you can download for your records."
      />
      <DataTable
        caption="Invoices"
        columns={columns}
        rows={invoices}
        rowKey={(invoice) => invoice.id}
        empty={
          <EmptyState
            className="border-0 py-6"
            icon={ReceiptText}
            title="No invoices yet"
            description="Your tax invoices and receipts appear here after each payment."
          />
        }
      />
    </>
  );
}

function InvoiceDownload({ invoice }: { invoice: InvoiceView }): ReactElement {
  if (invoice.pdfUrl) {
    return (
      <a
        href={invoice.pdfUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ds-accent-text)] transition-colors hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]"
      >
        <Download size={14} aria-hidden="true" />
        PDF
      </a>
    );
  }
  if (invoice.invoiceUrl) {
    return (
      <a
        href={invoice.invoiceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ds-accent-text)] transition-colors hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]"
      >
        <ExternalLink size={14} aria-hidden="true" />
        View
      </a>
    );
  }
  // A numbered invoice without a PDF yet is still rendering (worker enqueues it
  // seconds after payment; see legacy InvoicesCard). Communicate, don't hide.
  return (
    <span className="text-[12px] text-[var(--ds-text-subtle)]">
      {invoice.number ? 'Preparing…' : '—'}
    </span>
  );
}

// ── Billing details ───────────────────────────────────────────────────────────

function BillingDetailsTab({
  details,
  onEdit,
}: {
  details: BillingDetailsView;
  onEdit: () => void;
}): ReactElement {
  if (details.isEmpty) {
    return (
      <EmptyState
        icon={Building2}
        title="No billing details yet"
        description="Add your legal name and tax identity so your invoices carry the right business information."
        action={
          <Button onClick={onEdit}>
            <Plus size={16} aria-hidden="true" />
            Add billing details
          </Button>
        }
      />
    );
  }

  const addressLines = details.address
    ? [
        details.address.line1,
        details.address.line2,
        [details.address.city, details.address.state, details.address.postal_code]
          .filter(Boolean)
          .join(', '),
      ].filter((line): line is string => Boolean(line && line.trim()))
    : [];

  return (
    <>
      <SectionHeader
        title="Billing details"
        description="The legal identity printed on your invoices and used for tax."
        actions={
          <Button variant="outline" onClick={onEdit}>
            <FileText size={16} aria-hidden="true" />
            Edit details
          </Button>
        }
      />
      <Card>
        <CardContent className="pt-5">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailBlock label="Legal name" value={details.legalName} />
            <DetailBlock label="Billing email" value={details.email} />
            <DetailBlock label="GSTIN" value={details.gstin} mono />
            <DetailBlock label="Country" value={details.country} />
            {details.stateCode && <DetailBlock label="GST state code" value={details.stateCode} />}
            {addressLines.length > 0 && (
              <div className="sm:col-span-2">
                <dt className="text-[12px] font-medium text-[var(--ds-text-muted)]">Billing address</dt>
                <dd className="mt-1 text-[13px] leading-relaxed text-[var(--ds-text)]">
                  {addressLines.map((line) => (
                    <span key={line} className="block">
                      {line}
                    </span>
                  ))}
                </dd>
              </div>
            )}
          </dl>
        </CardContent>
      </Card>
    </>
  );
}

function DetailBlock({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}): ReactElement {
  return (
    <div>
      <dt className="text-[12px] font-medium text-[var(--ds-text-muted)]">{label}</dt>
      <dd
        className={cn(
          'mt-1 text-[13px] text-[var(--ds-text)]',
          mono && value ? 'font-mono tracking-wide' : '',
        )}
      >
        {value ?? <span className="text-[var(--ds-text-subtle)]">Not set</span>}
      </dd>
    </div>
  );
}

// ── Shared bits ───────────────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: ReactNode }): ReactElement {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-[var(--ds-text-muted)]">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-[var(--ds-text)]">{value}</dd>
    </div>
  );
}

function ScheduledChangeBanner({
  planName,
  effectiveAt,
  currentPlanName,
}: {
  planName: string | null;
  effectiveAt: string | null;
  currentPlanName: string;
}): ReactElement {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-xl border border-[var(--ds-warning)] bg-[var(--ds-warning-soft)] px-4 py-3 text-[13px] text-[var(--ds-text)]"
    >
      <CalendarClock
        size={16}
        aria-hidden="true"
        className="mt-0.5 shrink-0 text-[var(--ds-warning)]"
      />
      <div>
        <p className="font-semibold text-[var(--ds-text)]">
          Scheduled downgrade to {planName ?? 'a different plan'}
          {effectiveAt ? ` on ${formatDate(effectiveAt)}` : ''}.
        </p>
        <p className="mt-0.5 text-[var(--ds-text-muted)]">
          You’ll keep {currentPlanName} until then.
        </p>
      </div>
    </div>
  );
}

function CancellationBanner({
  endsAt,
  planName,
}: {
  endsAt: string | null;
  planName: string;
}): ReactElement {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-xl border border-[var(--ds-warning)] bg-[var(--ds-warning-soft)] px-4 py-3 text-[13px] text-[var(--ds-text)]"
    >
      <AlertTriangle
        size={16}
        aria-hidden="true"
        className="mt-0.5 shrink-0 text-[var(--ds-warning)]"
      />
      <div>
        <p className="font-semibold text-[var(--ds-text)]">
          {planName} ends{endsAt ? ` on ${formatDate(endsAt)}` : ' at the end of the current period'} and
          won’t renew.
        </p>
        <p className="mt-0.5 text-[var(--ds-text-muted)]">
          You’ll keep access until then. Reactivate any time before it ends to stay on the plan.
        </p>
      </div>
    </div>
  );
}

function capitalize(value: string): string {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function LoadingState(): ReactElement {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-9 w-72 rounded-lg" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-56 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
