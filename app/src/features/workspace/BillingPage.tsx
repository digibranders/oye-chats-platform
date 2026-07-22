import { type ReactElement, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  CreditCard,
  Download,
  ExternalLink,
  FileText,
  Info,
  Minus,
  Plus,
  ReceiptText,
  RefreshCw,
  Users,
  Wallet,
  X,
  type LucideIcon,
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
import { DataTable, type Column } from '../../design-system/components/DataTable';
import { useBillingData } from './useBillingData';
import { TopupModal } from './billing/TopupModal';
import { SeatChangeDialog } from './billing/SeatChangeDialog';
import { BillingDetailsModal } from './billing/BillingDetailsModal';
import { BillingSummaryCards } from './billing/BillingSummaryCards';
import { PlansPanel } from './billing/PlansPanel';
import { PlanConfirmDrawer } from './billing/PlanConfirmDrawer';
import type { BillingCycle } from './billing/planMath';
import {
  formatDate,
  formatMoneyMinor,
  INVOICE_KIND_LABEL,
  statusTone,
  type BillingDetailsView,
  type InvoiceView,
  type PlanView,
} from './billingModel';

/**
 * BillingPage — the Workspace ▸ Billing surface: a subscription-management
 * dashboard answering "what am I paying for?". Four summary cards
 * (Subscription · Renewal · Payment · Credits) lead; issued invoices and the
 * buyer's tax identity follow; the full plan comparison lives in a collapsed
 * disclosure at the bottom (users come here to manage, not to re-shop).
 *
 * Credit balance and consumption live on the separate Workspace ▸ Usage page.
 * Choosing a plan opens the slim {@link PlanConfirmDrawer}, which runs the
 * shared checkout money-path against the real Razorpay + subscription
 * endpoints. Every success reloads and surfaces a message in the aria-live
 * notice region.
 */
export function BillingPage(): ReactElement {
  const { loading, error, data, reload } = useBillingData();
  const navigate = useNavigate();
  const [notice, setNotice] = useState<string | null>(null);

  const subscription = data?.subscription ?? null;
  const plan = data?.plan ?? null;

  // Comparison billing cycle — seeded to the customer's own cadence.
  const [cycle, setCycle] = useState<BillingCycle>('monthly');
  const [activeTab, setActiveTab] = useState<BillingTab>('plans');
  const [confirmPlan, setConfirmPlan] = useState<PlanView | null>(null);
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
  const pendingCancel = Boolean(subscription?.cancelAtPeriodEnd && !subscription.scheduledChange);
  const renewalLabel = subscription?.trialEnd
    ? formatDate(subscription.trialEnd)
    : formatDate(subscription?.currentPeriodEnd ?? null);
  const renewalCaption = subscription?.trialEnd ? 'Trial ends' : pendingCancel ? 'Plan ends' : 'Renews';

  const autoRenew = Boolean(subscription?.hasActive && !subscription.cancelAtPeriodEnd);
  // A Free plan isn't billed, so it has no payment method regardless of the
  // subscription's default provider value.
  const provider = plan?.isPaid ? subscription?.paymentProvider ?? null : null;
  const paymentLabel = provider ? capitalize(provider) : 'None';
  const paymentSub = provider
    ? provider.toLowerCase() === 'razorpay'
      ? 'UPI, card, or NetBanking via Razorpay.'
      : 'Billed manually by our team.'
    : 'Added when you start a paid plan.';

  return (
    <PageContainer
      title="Billing"
      description="Manage your subscription, payment methods and invoices."
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
          {/* Persistent context — the state of the subscription at a glance,
              never scrolls away as you move between tabs. */}
          <BillingSummaryCards
            planName={plan?.name ?? 'Free'}
            status={subscription.status}
            priceLabel={priceLabel}
            isPaid={Boolean(plan?.isPaid)}
            renewalCaption={renewalCaption}
            renewalLabel={renewalLabel}
            autoRenew={autoRenew}
            paymentLabel={paymentLabel}
            paymentSub={paymentSub}
            creditsPerMonth={plan?.creditsPerMonth ?? 0}
            onChangePlan={() => setActiveTab('plans')}
            onViewUsage={() => void navigate('/workspace/usage')}
          />

          {/* Segmented sub-tabs — a pill control, distinct from the underline
              Workspace tabs above, so the two nav levels read as a hierarchy. */}
          <BillingTabs active={activeTab} onChange={setActiveTab} />

          {activeTab === 'plans' && (
            <div className="space-y-6">
              {/* Scheduled downgrade — applies account-wide. */}
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

              {/* Operator seats — only meaningful once the plan includes them. */}
              {includedSeats > 0 && (
                <SeatManager
                  totalSeats={totalSeats}
                  includedSeats={includedSeats}
                  seatPriceLabel={plan ? `${formatMoneyMinor(plan.extraSeatPriceMinor)}/mo` : '—'}
                  onAddSeat={() => setSeatDialog({ open: true, delta: 1 })}
                  onRemoveSeat={() => setSeatDialog({ open: true, delta: -1 })}
                />
              )}

              {data.availablePlans.length > 0 && (
                <PlansPanel
                  plans={data.availablePlans}
                  currentSlug={plan?.slug ?? 'free'}
                  cycle={cycle}
                  onCycleChange={setCycle}
                  onSelect={(candidate) => setConfirmPlan(candidate)}
                />
              )}
            </div>
          )}

          {activeTab === 'invoices' && (
            <InvoicesTab invoices={data.invoices} hasError={data.invoicesError} onRetry={reload} />
          )}

          {activeTab === 'details' && (
            <BillingDetailsTab details={data.details} onEdit={() => setDetailsOpen(true)} />
          )}
        </>
      )}

      {/* Slim confirm drawer — runs the shared checkout money-path. */}
      <PlanConfirmDrawer
        open={confirmPlan !== null}
        onClose={() => setConfirmPlan(null)}
        plan={confirmPlan}
        cycle={cycle}
        currentPlanSlug={plan?.slug ?? 'free'}
        currentSubscriptionStatus={subscription?.status ?? null}
        hasActiveSubscription={Boolean(subscription?.hasActive)}
        currentMonthlyPriceMinor={plan?.monthlyPriceMinor ?? 0}
        onSuccess={handleSuccess}
      />

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

// ── Sub-tabs ──────────────────────────────────────────────────────────────────

type BillingTab = 'plans' | 'invoices' | 'details';

const BILLING_TABS: readonly { readonly id: BillingTab; readonly label: string; readonly icon: LucideIcon }[] = [
  { id: 'plans', label: 'Plans', icon: CreditCard },
  { id: 'invoices', label: 'Invoices', icon: ReceiptText },
  { id: 'details', label: 'Billing details', icon: Building2 },
];

/**
 * BillingTabs — a segmented pill control switching the Billing sub-sections. A
 * raised active segment on a sunken track (vs. the underline Workspace tabs)
 * makes the two navigation levels read as a clear hierarchy.
 */
function BillingTabs({
  active,
  onChange,
}: {
  active: BillingTab;
  onChange: (tab: BillingTab) => void;
}): ReactElement {
  return (
    <div
      role="tablist"
      aria-label="Billing sections"
      className="inline-flex items-center gap-1 self-start rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-1"
    >
      {BILLING_TABS.map(({ id, label, icon: Icon }) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(id)}
            className={cn(
              'inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors',
              'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
              isActive
                ? 'bg-[var(--ds-bg-surface)] text-[var(--ds-text)] shadow-[var(--ds-shadow-sm)]'
                : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
            )}
          >
            <Icon size={15} aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ── Operator seats ────────────────────────────────────────────────────────────

function SeatManager({
  totalSeats,
  includedSeats,
  seatPriceLabel,
  onAddSeat,
  onRemoveSeat,
}: {
  totalSeats: number;
  includedSeats: number;
  seatPriceLabel: string;
  onAddSeat: () => void;
  onRemoveSeat: () => void;
}): ReactElement {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-subtle)] text-[var(--ds-text-muted)]">
            <Users size={18} aria-hidden="true" />
          </span>
          <div>
            <p className="text-[15px] font-semibold text-[var(--ds-text)]">
              {totalSeats} operator seat{totalSeats === 1 ? '' : 's'}
            </p>
            <p className="text-[13px] text-[var(--ds-text-muted)]">
              {includedSeats} included with your plan · {seatPriceLabel} per extra seat
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
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
            Remove
          </Button>
          <Button variant="outline" onClick={onAddSeat}>
            <Plus size={16} aria-hidden="true" />
            Add seat
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
            invoice.kind === 'credit_note' ? 'text-[var(--ds-text-muted)]' : 'text-[var(--ds-text)]',
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
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ds-accent-text)] transition-colors hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
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
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ds-accent-text)] transition-colors hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
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
      <CalendarClock size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-warning)]" />
      <div>
        <p className="font-semibold text-[var(--ds-text)]">
          Scheduled downgrade to {planName ?? 'a different plan'}
          {effectiveAt ? ` on ${formatDate(effectiveAt)}` : ''}.
        </p>
        <p className="mt-0.5 text-[var(--ds-text-muted)]">You’ll keep {currentPlanName} until then.</p>
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
      <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-warning)]" />
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
      <Skeleton className="h-28 rounded-xl" />
      <Skeleton className="h-9 w-72 rounded-lg" />
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}
