import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Sparkles,
  Zap,
  MessageSquare,
  Globe,
  FileText,
  CreditCard,
  Users,
  Plus,
  Minus,
  Loader2,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  Activity,
  ListOrdered,
  ArrowUpRight,
  Info,
  Bot,
  Clock,
} from 'lucide-react';
import CreditCoin from '../components/icons/CreditCoin';
import {
  getCreditBalance,
  getCreditHistory,
  getCurrentSubscription,
  changeOperatorSeats,
  getBillingPortalUrl,
  verifyStripeTopup,
  verifyStripeSubscription,
  reconcileStripeSubscription,
  cancelScheduledChange,
} from '../services/api';
import PageHeader from '../components/ui/PageHeader';
import Tabs from '../components/ui/Tabs';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import Progress from '../components/ui/Progress';
import { useToast } from '../context/ToastContext';
import { useBotContext } from '../context/BotContext';
import useEntitlements from '../hooks/useEntitlements';
import TopupModal from '../components/credits/TopupModal';
import PlanModal from '../components/billing/PlanModal';
import AddSeatConfirmModal from '../components/billing/AddSeatConfirmModal';
import { cn } from '../lib/utils';

const TRUSTED_REDIRECT_DOMAINS = ['checkout.stripe.com', 'billing.stripe.com'];
function isTrustedRedirectUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      TRUSTED_REDIRECT_DOMAINS.some(
        (d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d),
      )
    );
  } catch {
    return false;
  }
}

const fmtNumber = (n) => Number(n || 0).toLocaleString();

function fmtCurrency(amountMinor, currency = 'USD') {
  const symbol = currency === 'USD' ? '$' : currency === 'INR' ? '₹' : `${currency} `;
  const major = Number(amountMinor || 0) / 100;
  // Hide decimals on round amounts (e.g. $19 not $19.00) for either currency
  // so plan cards stay clean. Sub-dollar/sub-rupee fractions still show 2dp.
  const useDecimals = !Number.isInteger(major);
  return `${symbol}${major.toLocaleString(undefined, {
    minimumFractionDigits: useDecimals ? 2 : 0,
    maximumFractionDigits: useDecimals ? 2 : 0,
  })}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const REASON_LABEL = {
  plan_grant: 'Plan grant',
  topup: 'Top-up purchase',
  ai_chat: 'AI chat reply',
  document_upload: 'Document upload',
  url_scan: 'URL crawl',
  email_send: 'Customer email',
  manual_adjust: 'Manual adjustment',
  refund: 'Refund',
  expiry: 'Top-up expiry',
};

// The raw `reason` field is the ledger bucket the row belongs to (used by
// FIFO accounting), not how a human should read the row. Two cases need
// disambiguation before display:
//   • `topup` is used for both real purchases AND proration credits issued
//     when a customer upgrades mid-cycle. The backend stamps the latter with
//     a `note` beginning with "Upgrade credit" — we surface that as a
//     distinct label so customers don't think they were charged.
//   • `plan_grant` covers both the +N grant AND the paired -N deduction that
//     zeroes out the previous month's unused plan credits ("use-it-or-lose-it").
//     Reading the deduction as "Plan grant" with a negative amount is
//     contradictory; show it as "Plan reset" instead.
function resolveReasonLabel(row) {
  const reason = row?.reason;
  const note = (row?.note || '').toLowerCase();
  const delta = Number(row?.delta) || 0;

  if (reason === 'topup' && note.startsWith('upgrade credit')) {
    return 'Plan upgrade credit';
  }
  if (reason === 'plan_grant' && delta < 0) {
    return 'Plan reset';
  }
  return REASON_LABEL[reason] || reason;
}

function reasonStyle(reason, delta) {
  if (delta > 0) return 'text-emerald-600 dark:text-emerald-400';
  if (reason === 'expiry') return 'text-amber-600 dark:text-amber-400';
  return 'text-surface-700 dark:text-surface-300';
}

const COST_ROWS = [
  {
    key: 'ai_chat',
    icon: MessageSquare,
    label: 'AI chat reply',
    detail: 'Each completed answer your bot streams to a visitor.',
    iconColor: 'text-amber-500',
  },
  {
    // Knowledge-base document upload — charged at /ingest pre-flight before
    // the file is even written to disk. Refunded if a file fails to save.
    // Cost lives in PricingConfig (default 2) so super-admins can tune it.
    key: 'document_upload',
    icon: FileText,
    label: 'Document upload (per file)',
    detail: 'Charged per file added to your knowledge base. Refunded if a file fails to save.',
    iconColor: 'text-violet-500',
  },
  {
    key: 'url_scan',
    icon: Globe,
    label: 'URL crawl (per page)',
    detail: 'Charged per page actually ingested into your knowledge base.',
    iconColor: 'text-sky-500',
  },
  
  // {
  //   key: 'email_send',
  //   icon: Mail,
  //   label: 'Customer-facing email',
  //   detail: 'Lead alerts, AI summaries, qualification notifications.',
  //   iconColor: 'text-violet-500',
  // },
];

const TABS = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'topups', label: 'Buy credits', icon: CreditCoin },
  { id: 'seats', label: 'Plan & seats', icon: Users },
  { id: 'history', label: 'History', icon: ListOrdered },
];

// Free plan loses the "Buy credits" tab because Free users cannot top up
// (matrix decision — Free is a strict trial tier, must upgrade to keep
// using). We filter here at module-load time then re-filter inside the
// component via entitlements; the constant is used for the type contract.
const TABS_NO_TOPUP = TABS.filter((t) => t.id !== 'topups');

// Self-contained countdown badge for trialing subscriptions. Owns its own
// ``now`` tick so ``Date.now()`` never appears in a render expression of
// the parent — React Compiler flags that as impure. Re-evaluates every
// 60 seconds; granularity is good enough for a day-level countdown and
// also flips "1 day left" → "Trial ends today" automatically when the
// boundary crosses while the user has the page open.
function TrialCountdownBadge({ trialEndIso }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const endMs = Date.parse(trialEndIso);
  if (Number.isNaN(endMs)) return null;

  // Ceil so a trial expiring in 14h still reads "1 day left", not "0 days
  // left" — matches how customers actually count remaining time.
  const daysLeft = Math.ceil((endMs - now) / 86_400_000);

  let label;
  if (daysLeft < 0) label = 'Trial ended';
  else if (daysLeft === 0) label = 'Trial ends today';
  else if (daysLeft === 1) label = '1 day left in trial';
  else label = `${daysLeft} days left in trial`;

  const trialEndsAt = new Date(endMs);
  const tooltip = `Trial ends ${trialEndsAt.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })} at ${trialEndsAt.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })}`;

  const urgent = daysLeft <= 3;

  return (
    <span
      title={tooltip}
      className={`text-[11px] font-medium px-1.5 py-0.5 rounded inline-flex items-center gap-1 ${
        urgent
          ? 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400'
          : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
      }`}
    >
      <Clock className="w-3 h-3" />
      {label}
    </span>
  );
}

export default function Billing() {
  const { showToast } = useToast();
  const navigate = useNavigate();
  // ``selectedBot`` is the bot the user picked in the sidebar — the
  // Overview tab scopes the visible credit cards to just this bot
  // (its per-bot ledger, OR the account pool when the bot is a
  // legacy / Free bot that drains shared credits).
  const { selectedBot } = useBotContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(() => {
    const t = searchParams.get('tab');
    return TABS.some((x) => x.id === t) ? t : 'overview';
  });
  const [balance, setBalance] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [plan, setPlan] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [topupOpen, setTopupOpen] = useState(false);
  // When the Top up button on a per-bot credit card fires, we stash the
  // bot here so the TopupModal knows to scope the purchase to that bot's
  // isolated ledger. ``null`` means an account-pool top-up.
  const [topupTarget, setTopupTarget] = useState(null);
  const [planOpen, setPlanOpen] = useState(false);
  // Entitlements-driven UI: Free users see no topup CTA anywhere on this
  // page; their only path forward when credits run out is "Upgrade to
  // Starter". Matches the matrix decision documented in the plan doc.
  const { entitlements: ent } = useEntitlements();
  const topupAllowed = ent.topupAllowed !== false; // default-true on missing data
  const visibleTabs = topupAllowed ? TABS : TABS_NO_TOPUP;
  const [seatBusy, setSeatBusy] = useState(false);
  // Seat-change confirmation modal state. Stores the pending delta so the
  // same modal handles both add (+1) and remove (-1) — surfaces price,
  // payment provider, and resulting seat count BEFORE the backend call.
  const [seatConfirmDelta, setSeatConfirmDelta] = useState(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [cancelScheduledBusy, setCancelScheduledBusy] = useState(false);

  // Persist tab choice in URL so refreshes / shares land on the right tab.
  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    if (activeTab && activeTab !== 'overview') params.set('tab', activeTab);
    else params.delete('tab');
    setSearchParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Defensive: if someone shares a /billing?tab=topups URL with a Free user,
  // silently bounce them to the overview rather than rendering the topup
  // tab they can't use. Triggered whenever entitlements load AFTER the
  // tab state is hydrated from the URL.
  useEffect(() => {
    if (!topupAllowed && activeTab === 'topups') {
      setActiveTab('overview');
    }
  }, [topupAllowed, activeTab]);

  async function loadAll({ silent = false } = {}) {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const [balRes, subRes, histRes] = await Promise.all([
        getCreditBalance(),
        getCurrentSubscription(),
        getCreditHistory({ page: 1, limit: 50 }),
      ]);
      setBalance(balRes);
      setSubscription(subRes?.subscription || null);
      setPlan(subRes?.plan || null);
      setHistory(Array.isArray(histRes) ? histRes : []);
    } catch (err) {
      showToast(err?.message || 'Failed to load billing data', 'error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadAll();
    const params = new URLSearchParams(window.location.search);
    if (params.get('topup') === 'success') {
      const sessionId = params.get('session_id');
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, '', cleanUrl);

      // Stripe webhooks can't reach localhost during development and may also
      // lag in production. Self-redeem the session synchronously so credits
      // appear the moment the user returns from checkout — the backend is
      // the source of truth on whether the payment actually captured.
      if (sessionId) {
        showToast('Confirming your top-up…', 'info');
        verifyStripeTopup(sessionId)
          .then((res) => {
            if (res?.granted) {
              showToast('Top-up successful — credits added.', 'success');
            } else if (res?.reason === 'Already granted') {
              showToast('Top-up already credited.', 'info');
            } else {
              showToast(res?.reason || 'Top-up pending — credits will appear shortly.', 'info');
            }
            loadAll({ silent: true });
          })
          .catch((err) => {
            showToast(err?.message || 'Could not confirm top-up — credits will appear shortly.', 'warning');
            // Fall back to the original poll loop so a webhook-delivered grant
            // still surfaces if our self-redeem failed for some other reason.
            [1500, 4000, 8000].forEach((ms) => setTimeout(() => loadAll({ silent: true }), ms));
          });
        return undefined;
      }

      showToast('Top-up successful — credits will appear shortly.', 'success');
      const timers = [800, 2500, 5000].map((ms) => setTimeout(() => loadAll({ silent: true }), ms));
      return () => timers.forEach((t) => clearTimeout(t));
    }
    if (params.get('topup') === 'cancel') {
      showToast('Top-up canceled — no charge.', 'info');
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, '', cleanUrl);
    }
    // Subscription checkout return — mirror of the topup verify path.
    // Stripe doesn't reach localhost so the local sub row + credits won't
    // reconcile from the webhook; we self-verify against the session id.
    if (params.get('subscription') === 'success') {
      const sessionId = params.get('session_id');
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, '', cleanUrl);
      if (sessionId) {
        showToast('Confirming your subscription…', 'info');
        verifyStripeSubscription(sessionId)
          .then((res) => {
            if (res?.verified && res?.reason !== 'Already reconciled') {
              showToast(
                `You're now on the ${res.plan_slug?.charAt(0).toUpperCase() + res.plan_slug?.slice(1)} plan.`,
                'success',
              );
            } else if (res?.reason === 'Already reconciled') {
              showToast('Subscription already up to date.', 'info');
            } else {
              showToast(res?.reason || 'Subscription pending — it will appear shortly.', 'info');
            }
            loadAll({ silent: true });
          })
          .catch((err) => {
            showToast(err?.message || 'Could not confirm subscription.', 'warning');
            [1500, 4000, 8000].forEach((ms) => setTimeout(() => loadAll({ silent: true }), ms));
          });
        return undefined;
      }
      showToast('Subscription confirmed — refreshing.', 'success');
      const timers = [800, 2500, 5000].map((ms) => setTimeout(() => loadAll({ silent: true }), ms));
      return () => timers.forEach((t) => clearTimeout(t));
    }
    if (params.get('subscription') === 'cancel') {
      showToast('Checkout canceled — your plan is unchanged.', 'info');
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, '', cleanUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const monthlyGrant = balance?.monthly_grant || 0;
  const planRemaining = balance?.plan || 0;
  const topupRemaining = balance?.topup || 0;
  const totalRemaining = balance?.total || 0;
  const currency = balance?.currency || plan?.currency || 'USD';

  const planUsedPct = useMemo(() => {
    if (!monthlyGrant) return 0;
    const used = Math.max(monthlyGrant - planRemaining, 0);
    return Math.min(Math.round((used / monthlyGrant) * 100), 100);
  }, [monthlyGrant, planRemaining]);

  // The bot stops working when TOTAL credits hit zero, not when the plan
  // bucket hits zero — deductions automatically fall through to top-up
  // credits. So the "below 20%" warning must consider both buckets; a
  // customer who's burned through their plan but has 2,000 top-ups left
  // is in great shape, not in trouble.
  const lowBalance = monthlyGrant > 0 && totalRemaining <= monthlyGrant * 0.2;

  // Operator seat counts honour the plan's actual ``included_operator_seats``
  // (Free = 0, Starter = 1, Standard = 5, ...). For Free plans we force the
  // count to 0 because the Subscription model defaults
  // ``operator_quantity`` to 1 (a legacy default that predates the Free
  // tier shipping with zero seats) — without the clamp the card would
  // claim "1 seat total" on a plan that includes none.
  const includedSeats = plan?.included_operator_seats ?? 0;
  const seatLimit =
    includedSeats === 0 ? 0 : subscription?.operator_quantity ?? includedSeats;
  // Seat-fee fallback for an admin DB that hasn't picked up the new pricing
  // migration yet. Defaults to the current $5 / mo headline so the row reads
  // "+$5/mo" instead of falling back to a stale figure or a blank label.
  const seatPriceLabel = fmtCurrency(plan?.extra_seat_price_cents ?? 500, currency);

  const usage = balance?.usage || {};
  // Merge per-key so a backend payload that hasn't been redeployed since a
  // new cost was added still renders a sensible default instead of "0 credits".
  const costs = { ai_chat: 1, document_upload: 3, url_scan: 5, email_send: 1, ...(balance?.costs || {}) };

  // Total credits consumed this period across every bucket (plan, top-up,
  // manual) — sums the same per-reason ledger tally the rows below render
  // so the big number and the itemized breakdown can never disagree. The
  // plan-bucket progress bar (planUsedPct) is a different question — "how
  // much of your monthly allowance is gone" — and intentionally stays
  // plan-only.
  const periodUsed =
    (usage?.ai_chat?.credits_used || 0)
    + (usage?.url_scan?.credits_used || 0)
    + (usage?.document_upload?.credits_used || 0);

  // Two-step seat change: open the confirmation modal first so the user
  // sees the price + payment provider (Razorpay/Stripe) BEFORE we touch
  // their subscription. The actual API call happens in ``confirmSeatChange``,
  // invoked from the modal's confirm button.
  function handleSeatChange(delta) {
    setSeatConfirmDelta(delta);
  }

  async function confirmSeatChange() {
    const delta = seatConfirmDelta;
    if (!delta) return;
    setSeatBusy(true);
    try {
      // Errors propagate to the modal so it can render the failure inline
      // (e.g. "Razorpay declined the seat update") instead of closing on a
      // toast and losing the context the user needs to fix it.
      const result = await changeOperatorSeats(delta);
      showToast(
        delta > 0
          ? `Added a seat (now ${result?.operator_quantity ?? '?'} total).`
          : `Removed a seat (now ${result?.operator_quantity ?? '?'} total).`,
        'success',
      );
      await loadAll({ silent: true });
    } finally {
      setSeatBusy(false);
    }
  }

  async function handleBillingPortal() {
    setPortalBusy(true);
    try {
      const { portal_url } = await getBillingPortalUrl();
      if (portal_url && isTrustedRedirectUrl(portal_url)) {
        window.location.href = portal_url;
      } else {
        showToast('Billing portal is not available right now.', 'error');
      }
    } catch (err) {
      showToast(err?.message || 'Failed to open billing portal', 'error');
    } finally {
      setPortalBusy(false);
    }
  }

  /**
   * Manual escape-hatch when the local sub didn't auto-reconcile after
   * Stripe checkout (webhook didn't reach the API, success URL dropped
   * the session_id, browser closed mid-redirect). Asks the backend to
   * pull the customer's most recent paid checkout from Stripe and fold
   * it in — idempotent so spamming this button is safe.
   */
  /**
   * Clear a queued downgrade. The backend resets ``scheduled_*`` to NULL
   * but leaves ``cancel_at_period_end`` alone — the gateway mandate was
   * cancelled when the downgrade was scheduled, so the customer needs to
   * re-authorise payment to stay on their current plan past the cycle.
   * We surface that next step in the success toast.
   */
  async function handleCancelScheduledChange() {
    setCancelScheduledBusy(true);
    try {
      const res = await cancelScheduledChange();
      if (res?.status === 'no_change_pending') {
        showToast('Nothing was scheduled.', 'info');
      } else {
        showToast(
          res?.message
            || 'Scheduled change cancelled. Re-authorise payment to stay on your current plan past cycle end.',
          'success',
        );
      }
      loadAll({ silent: true });
    } catch (err) {
      showToast(err?.message || 'Could not cancel the scheduled change.', 'error');
    } finally {
      setCancelScheduledBusy(false);
    }
  }

  async function handleSyncBilling() {
    setSyncBusy(true);
    try {
      const res = await reconcileStripeSubscription();
      if (res?.reconciled) {
        showToast(
          res?.reason === 'Already reconciled (no changes).'
            ? 'Billing already in sync.'
            : `Billing synced — you're on the ${res.plan_slug?.charAt(0).toUpperCase()}${res.plan_slug?.slice(1)} plan.`,
          'success',
        );
        loadAll({ silent: true });
      } else {
        showToast(res?.reason || 'Nothing to reconcile.', 'info');
      }
    } catch (err) {
      showToast(err?.message || 'Could not sync billing', 'error');
    } finally {
      setSyncBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing"
        subtitle="Plan, credits, top-ups, and operator seats all in one place."
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() => loadAll({ silent: true })}
          disabled={loading || refreshing}
        >
          {refreshing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Refresh
        </Button>
        {topupAllowed ? (
          <Button onClick={() => setTopupOpen(true)} disabled={loading}>
            <CreditCoin className="w-4 h-4" />
            Buy more credits
          </Button>
        ) : (
          // Free: route to plan upgrade flow instead of top up. Same CTA
          // slot so the page layout doesn't shift; only the label and
          // handler change.
          <Button onClick={() => setPlanOpen(true)} disabled={loading}>
            <Sparkles className="w-4 h-4" />
            Upgrade to Starter
          </Button>
        )}
      </PageHeader>

      <Tabs tabs={visibleTabs} activeTab={activeTab} onChange={setActiveTab} variant="underline" />

      {/* Scheduled-change banner — surfaces a queued downgrade so the user
          knows what's coming and can back out before cutover. Rendered above
          every tab body since the change applies account-wide, not per tab. */}
      {subscription?.scheduled_change && (
        <ScheduledChangeBanner
          scheduled={subscription.scheduled_change}
          currentPlanName={plan?.name}
          busy={cancelScheduledBusy}
          onCancel={handleCancelScheduledChange}
        />
      )}

      {loading ? (
        <div className="flex items-center justify-center py-24 text-surface-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading billing…
        </div>
      ) : (
        <>
          {activeTab === 'overview' && (
            <OverviewTab
              balance={balance}
              plan={plan}
              subscription={subscription}
              currency={currency}
              monthlyGrant={monthlyGrant}
              planRemaining={planRemaining}
              topupRemaining={topupRemaining}
              totalRemaining={totalRemaining}
              planUsedPct={planUsedPct}
              periodUsed={periodUsed}
              usage={usage}
              costs={costs}
              lowBalance={lowBalance}
              topupAllowed={topupAllowed}
              selectedBot={selectedBot}
              onTopup={() => {
                setTopupTarget(null);
                if (topupAllowed) setTopupOpen(true);
                else setPlanOpen(true);
              }}
              onTopupBot={(botLedger) => {
                setTopupTarget(botLedger);
                setTopupOpen(true);
              }}
            />
          )}

          {activeTab === 'topups' && (
            <TopupsTab
              currency={currency}
              onTopup={() => setTopupOpen(true)}
              recentTopups={history.filter((h) => h.reason === 'topup').slice(0, 5)}
            />
          )}

          {activeTab === 'seats' && (
            <SeatsTab
              plan={plan}
              subscription={subscription}
              currency={currency}
              seatLimit={seatLimit}
              includedSeats={includedSeats}
              seatPriceLabel={seatPriceLabel}
              seatBusy={seatBusy}
              portalBusy={portalBusy}
              syncBusy={syncBusy}
              onSeatChange={handleSeatChange}
              onBillingPortal={handleBillingPortal}
              onChangePlan={() => setPlanOpen(true)}
              onCreateBot={() => navigate('/chatbot?create=true')}
              onSyncBilling={handleSyncBilling}
            />
          )}

          {activeTab === 'history' && (
            <HistoryTab history={history} totalRemaining={totalRemaining} />
          )}
        </>
      )}

      <TopupModal
        open={topupOpen}
        onClose={() => { setTopupOpen(false); setTopupTarget(null); }}
        botId={topupTarget?.bot_id ?? null}
        botName={topupTarget?.bot_name ?? null}
        onSuccess={() => {
          setTimeout(() => loadAll({ silent: true }), 1500);
          setTimeout(() => loadAll({ silent: true }), 4500);
        }}
      />

      <AddSeatConfirmModal
        open={seatConfirmDelta !== null}
        onClose={() => setSeatConfirmDelta(null)}
        delta={seatConfirmDelta ?? 0}
        seatPriceCents={plan?.extra_seat_price_cents ?? 500}
        currency={currency}
        paymentProvider={subscription?.payment_provider}
        currentSeatCount={
          subscription?.operator_quantity ?? plan?.included_operator_seats ?? 1
        }
        includedSeats={plan?.included_operator_seats ?? 1}
        // Only count subscriptions we can actually charge against — Razorpay
        // or Stripe. Manual/seeded subs (``payment_provider='manual'``) have
        // no upstream record to update, so the backend's
        // ``subscription.edit`` call would no-op or fail. Falling through to
        // the upgrade CTA here is the honest behavior — the user must pick
        // a real plan before they can add billable seats.
        hasSubscription={
          (subscription?.status === 'active' || subscription?.status === 'trialing') &&
          ['razorpay', 'stripe'].includes(
            (subscription?.payment_provider || '').toLowerCase(),
          )
        }
        onConfirm={confirmSeatChange}
        onUpgradeClick={() => setPlanOpen(true)}
      />

      <PlanModal
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        currentPlanSlug={plan?.slug || 'free'}
        currentSubscriptionStatus={subscription?.status || null}
        currentBillingCycle={subscription?.billing_cycle || 'monthly'}
        // ``hasActiveSubscription`` is the "do they have any sub row at all"
        // signal (covers manual seeds too); ``hasStripeSubscription`` is the
        // narrower "do we have a real Stripe link we can modify in place"
        // signal. Together they let the modal pick between three CTAs:
        // Start trial / Upgrade (redirect) / Switch (silent prorate).
        hasActiveSubscription={
          subscription?.status === 'active' || subscription?.status === 'trialing'
        }
        hasStripeSubscription={subscription?.payment_provider === 'stripe'}
        onSuccess={(evt) => {
          // Map every PlanModal outcome kind to its own toast so users get
          // accurate feedback instead of a generic "Plan updated." for
          // distinct outcomes (trial-start vs subscribe vs prorated swap).
          let toastMsg = 'Plan updated.';
          if (evt.kind === 'switched') {
            const credit = Number(evt.response?.proration_credit_cents || 0);
            toastMsg = credit > 0
              ? `Switched to ${evt.plan.name}. Unused time credited (${fmtCurrency(credit, currency)}).`
              : `Switched to ${evt.plan.name} — the new pricing is being prorated.`;
          } else if (evt.kind === 'downgraded') {
            toastMsg = `Downgrade to ${evt.plan.name} scheduled at period end.`;
          } else if (evt.kind === 'downgrade_scheduled') {
            const when = evt.effectiveAt
              ? new Date(evt.effectiveAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
              : 'the end of this billing cycle';
            toastMsg = `Downgrade to ${evt.plan.name} scheduled for ${when}. You'll keep your current plan until then.`;
          } else if (evt.kind === 'trial_started') {
            toastMsg = `Trial started — ${evt.plan.name} unlocked for ${evt.trial_days || 14} days.`;
          } else if (evt.kind === 'subscribed') {
            const credit = Number(evt.response?.proration_credit_cents || 0);
            toastMsg = credit > 0
              ? `Subscribed to ${evt.plan.name}. Unused previous-plan time credited (${fmtCurrency(credit, currency)}).`
              : `Subscribed to ${evt.plan.name}. Welcome aboard!`;
          }
          showToast(toastMsg, 'success');
          // Refetch a few times because the provider webhook can lag the
          // change-plan response by a couple seconds.
          setTimeout(() => loadAll({ silent: true }), 500);
          setTimeout(() => loadAll({ silent: true }), 3500);
        }}
      />
    </div>
  );
}

// ── Scheduled-change banner ──

/**
 * Surfaces a queued downgrade so the user always knows what's coming and
 * can back out before cutover. Renders amber to match the existing "low
 * balance" warning aesthetic without being as loud as a destructive red.
 *
 * @param {{plan_name, plan_slug, effective_at}} scheduled - From /current's
 *   ``subscription.scheduled_change`` payload. ``effective_at`` is ISO-8601.
 * @param {string} currentPlanName - For copy: "You're on Standard until …".
 * @param {boolean} busy - Disables the cancel button while the API call is in flight.
 * @param {function} onCancel - Click handler that calls cancelScheduledChange().
 */
function ScheduledChangeBanner({ scheduled, currentPlanName, busy, onCancel }) {
  const when = scheduled?.effective_at
    ? new Date(scheduled.effective_at).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;
  const targetName = scheduled?.plan_name || 'a different plan';
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 py-3 rounded-xl border',
        'border-amber-300/60 dark:border-amber-500/30',
        'bg-amber-50/80 dark:bg-amber-500/10',
        'text-amber-900 dark:text-amber-200',
      )}
    >
      <div className="text-[13px] leading-snug">
        <p className="font-semibold">
          Scheduled downgrade to {targetName}
          {when ? ` on ${when}` : ''}.
        </p>
        <p className="text-amber-800/90 dark:text-amber-200/80 mt-0.5">
          You’ll keep {currentPlanName || 'your current plan'} until then. The autopay mandate was
          cancelled — you can re-authorise to stay on {currentPlanName || 'your current plan'} past
          cycle end.
        </p>
      </div>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className={cn(
          'shrink-0 inline-flex items-center justify-center px-3 py-1.5 rounded-lg text-[12px] font-semibold',
          'border border-amber-400/70 dark:border-amber-500/40',
          'bg-white/70 dark:bg-amber-500/10 text-amber-900 dark:text-amber-100',
          'hover:bg-white dark:hover:bg-amber-500/20 transition-colors',
          'disabled:opacity-60 disabled:cursor-not-allowed',
        )}
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
        Cancel scheduled change
      </button>
    </div>
  );
}


// ── Tabs ──

function OverviewTab({
  plan,
  subscription,
  currency,
  monthlyGrant,
  planRemaining,
  topupRemaining,
  totalRemaining,
  periodUsed,
  usage,
  costs,
  topupAllowed = true,
  lowBalance,
  balance,
  selectedBot,
  onTopup,
  onTopupBot,
}) {
  // Per-bot ledgers — one entry per bot with its own paid subscription.
  // The Overview tab is scoped to the bot currently selected in the
  // sidebar: switching to bot 1 shows bot 1's ledger only, switching to
  // bot 2 shows bot 2's, and so on. The page never shows two bots'
  // credits side-by-side anymore.
  const perBotLedgers = balance?.bots || [];
  const selectedBotLedger = selectedBot
    ? perBotLedgers.find((b) => b.bot_id === selectedBot.id)
    : null;
  const isBotView = !!selectedBotLedger;

  // ── Display-source switching ──
  // When the selected bot has its own paid subscription, the 3-card
  // grid below pulls every number from that bot's isolated ledger.
  // Otherwise (Free / legacy-pooled bot, or no selection yet) it falls
  // back to the account-level client-pool numbers passed in as props.
  // Keeps the JSX single-sourced regardless of which view is active.
  const dPlanRemaining = isBotView ? Number(selectedBotLedger.plan || 0) : planRemaining;
  const dMonthlyGrant = isBotView ? Number(selectedBotLedger.monthly_grant || 0) : monthlyGrant;
  const dTopupRemaining = isBotView ? Number(selectedBotLedger.topup || 0) : topupRemaining;
  const dUsage = isBotView ? (selectedBotLedger.usage || {}) : (usage || {});
  // FIX: derive "used this period" from the actual sum of negative
  // ledger deltas in the scope, not from ``monthlyGrant - planRemaining``.
  // The old math broke for any scope where no grant landed (e.g. a per-
  // bot subscription that activated via a legacy code path before
  // Phase 4.5) — it would show ``10,000 used`` with all per-reason
  // counters at 0, which is a contradiction. Summing the actual usage
  // rows is always honest.
  const dPeriodUsed = isBotView
    ? Object.values(dUsage).reduce((sum, u) => sum + (u?.credits_used || 0), 0)
    : periodUsed;
  const dSoonestExpiry = isBotView ? selectedBotLedger.soonest_expiry : balance?.soonest_expiry;
  const dResetsAt = isBotView ? selectedBotLedger.resets_at : balance?.resets_at;
  const dPlanUsedPct = dMonthlyGrant > 0
    ? Math.min(100, Math.round((Math.max(0, dMonthlyGrant - dPlanRemaining) / dMonthlyGrant) * 100))
    : 0;
  const dBalancePct = Math.max(0, 100 - dPlanUsedPct);
  const dLowBalance = isBotView
    ? dMonthlyGrant > 0 && dPlanRemaining / dMonthlyGrant < 0.2
    : lowBalance;
  // Top-ups always available on a per-bot subscription card (paid sub
  // → can top up). For the account pool, defer to the entitlement-
  // driven ``topupAllowed`` flag (Free plan blocks top-ups).
  const dTopupAllowed = isBotView ? true : topupAllowed;
  const handleTopupClick = () => {
    if (isBotView) {
      onTopupBot?.(selectedBotLedger);
    } else {
      onTopup?.();
    }
  };

  return (
    <div className="space-y-6">
      {selectedBot && (
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-50">
            {isBotView ? `${selectedBotLedger.bot_name} credits` : `${selectedBot.name} credits`}
          </h3>
          <span className="text-[11px] text-surface-500 dark:text-surface-400">
            {isBotView
              ? 'Isolated from your other bots — switch bot in the sidebar to view its credits.'
              : 'This bot uses your account’s shared credit pool (Free or legacy).'}
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Card 1 — Plan credits */}
        <Card>
          <CardHeader>
            <CardTitle>
              <span className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-amber-500" /> Plan credits
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold tracking-tight text-surface-900 dark:text-surface-50">
                {fmtNumber(dPlanRemaining)}
              </span>
              <span className="text-sm text-surface-500">/ {fmtNumber(dMonthlyGrant)}</span>
            </div>
            <Progress value={dPlanUsedPct} className="mt-3" />
            <div className="mt-3 flex items-center justify-between text-xs text-surface-500 dark:text-surface-400">
              <span>{dBalancePct}% balance</span>
              <span>Resets {fmtDate(dResetsAt)}</span>
            </div>
            {/* Two-state footer: amber low-balance warning when *total* runway
                is thin, emerald reassurance when plan is low but top-ups are
                covering the gap. Both states are mutually exclusive. */}
            {dLowBalance ? (
              <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  {dTopupAllowed
                    ? 'Below 20% of your monthly allowance. Top up to keep your bot running.'
                    : 'Below 20% of your monthly allowance. Upgrade to Starter to keep your bot running.'}
                </span>
              </div>
            ) : dPlanUsedPct >= 80 && dTopupRemaining > 0 ? (
              <div className="mt-3 flex items-start gap-2 rounded-md bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">
                <Sparkles className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  Plan low — your {fmtNumber(dTopupRemaining)} top-up credit{dTopupRemaining === 1 ? '' : 's'} will be used next, so your bot stays online.
                </span>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Card 2 — Used this period */}
        <Card>
          <CardHeader>
            <CardTitle>
              <span className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-500" /> Used this period
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-surface-900 dark:text-surface-50">
              {fmtNumber(dPeriodUsed)}
            </div>
            <div className="text-xs text-surface-500 mt-1">credits consumed</div>
            <div className="mt-3 space-y-1.5 text-xs">
              <UsageRow label="AI chats" credits={dUsage?.ai_chat?.credits_used || 0} count={dUsage?.ai_chat?.event_count || 0} />
              <UsageRow label="Documents uploaded" credits={dUsage?.document_upload?.credits_used || 0} count={dUsage?.document_upload?.event_count || 0} />
              <UsageRow label="URL pages" credits={dUsage?.url_scan?.credits_used || 0} count={dUsage?.url_scan?.event_count || 0} />
            </div>
          </CardContent>
        </Card>

        {/* Card 3 — Top-up credits */}
        <Card>
          <CardHeader>
            <CardTitle>
              <div className="flex items-center justify-between w-full">
                <span className="flex items-center gap-2">
                  <CreditCoin className="w-4 h-4 text-primary-500" /> Top-up credits
                </span>
                <div className="relative group">
                  <Info className="w-3.5 h-3.5 text-surface-400 dark:text-surface-500 cursor-help" />
                  <div
                    className={cn(
                      'absolute right-0 top-5 z-10 w-64 rounded-xl border p-3 shadow-lg',
                      'border-surface-200 dark:border-surface-700',
                      'bg-white dark:bg-surface-900',
                      'text-xs text-surface-600 dark:text-surface-300 leading-relaxed',
                      'opacity-0 invisible group-hover:opacity-100 group-hover:visible',
                      'transition-all duration-150',
                    )}
                  >
                    <p className="font-semibold text-surface-900 dark:text-surface-50 mb-1.5">What are top-up credits?</p>
                    <p className="mb-2">
                      Top-up credits are extra credits you purchase on top of your monthly plan allowance. They work just like plan credits — each AI reply or URL page crawled deducts from your balance.
                    </p>
                    <p className="font-medium text-surface-700 dark:text-surface-200 mb-1">Why top up?</p>
                    <ul className="space-y-1 pl-3 list-disc marker:text-primary-400">
                      <li>Keep your bot online when your monthly allowance runs out</li>
                      <li>Roll over for 12 months — no use-it-or-lose-it pressure</li>
                      <li>Larger packs come with bonus credits</li>
                      <li>Used after plan credits are exhausted (FIFO order)</li>
                    </ul>
                  </div>
                </div>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold tracking-tight text-surface-900 dark:text-surface-50">
                {fmtNumber(dTopupRemaining)}
              </span>
              <span className="text-sm text-surface-500">credits</span>
            </div>
            <div className="mt-3 text-xs text-surface-500 dark:text-surface-400">
              {!dTopupAllowed
                ? 'Free plan — top-ups not available. Upgrade to Starter to keep going past your monthly limit.'
                : dTopupRemaining > 0
                  ? `Oldest expires ${fmtDate(dSoonestExpiry)}`
                  : 'No top-up credits yet — they roll over for 12 months.'}
            </div>
            <div className="mt-4">
              <Button variant="outline" size="sm" onClick={handleTopupClick}>
                {dTopupAllowed ? (
                  <>
                    <CreditCoin className="w-3.5 h-3.5" />
                    Top up
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    Upgrade
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Plan summary */}
      <Card>
        <CardContent>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <CreditCard className="w-4 h-4 text-surface-500" />
                <span className="text-sm font-semibold text-surface-900 dark:text-surface-50">
                  {plan?.name || 'Free'} plan
                </span>
                {subscription?.status && (
                  <span
                    className={`text-[11px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                      subscription.status === 'trialing'
                        ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
                        : subscription.status === 'active'
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                        : 'bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-300'
                    }`}
                  >
                    {subscription.status}
                  </span>
                )}
                {subscription?.status === 'trialing' && subscription?.trial_end && (
                  <TrialCountdownBadge trialEndIso={subscription.trial_end} />
                )}
              </div>
              <div className="mt-1 text-xs text-surface-500 dark:text-surface-400">
                {plan?.monthly_price_cents > 0
                  ? `${fmtCurrency(plan.monthly_price_cents, currency)} / month`
                  : 'No paid subscription'}
                {' · '}
                {fmtNumber(monthlyGrant)} credits / month
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-surface-500 dark:text-surface-400">
                Total credits Remaining: <strong className="text-surface-700 dark:text-surface-200">{fmtNumber(totalRemaining)}</strong>
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* How credits work */}
      <Card>
        <CardHeader>
          <CardTitle>How credits work</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-surface-500 dark:text-surface-400 mb-4">
            Every action your bot performs uses credits. System emails (auth, password reset,
            operator notifications) and live-chat operator messages are always free.
          </p>
          <div className="space-y-3">
            {COST_ROWS.map((row) => {
              const Icon = row.icon;
              const cost = costs?.[row.key] ?? 0;
              return (
                <div
                  key={row.key}
                  className="flex items-center justify-between rounded-xl border border-surface-200 dark:border-surface-800 bg-surface-50/50 dark:bg-surface-900/40 px-4 py-3"
                >
                  <div className="flex items-start gap-3">
                    <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', row.iconColor)} />
                    <div>
                      <div className="text-sm font-medium text-surface-900 dark:text-surface-50">
                        {row.label}
                      </div>
                      <div className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
                        {row.detail}
                      </div>
                    </div>
                  </div>
                  <div className="text-sm font-semibold text-surface-700 dark:text-surface-200 whitespace-nowrap pl-4">
                    {cost === 1 ? '1 credit' : `${cost} credits`}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function BotCreditCard({ bot, currency, onTopup }) {
  const planRemaining = Number(bot.plan || 0);
  const monthlyGrant = Number(bot.monthly_grant || 0);
  const usedThisPeriod = Math.max(0, monthlyGrant - planRemaining);
  const usedPct = monthlyGrant > 0 ? Math.min(100, Math.round((usedThisPeriod / monthlyGrant) * 100)) : 0;
  const balancePct = Math.max(0, 100 - usedPct);
  const lowBalance = monthlyGrant > 0 && planRemaining / monthlyGrant < 0.2;

  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-primary-500 shrink-0" />
              <span className="text-sm font-semibold text-surface-900 dark:text-surface-50 truncate">
                {bot.bot_name}
              </span>
              {bot.subscription_status && (
                <span
                  className={cn(
                    'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded',
                    bot.subscription_status === 'active'
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                      : 'bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-300',
                  )}
                >
                  {bot.subscription_status}
                </span>
              )}
            </div>
            <div className="text-[11px] text-surface-500 dark:text-surface-400 mt-0.5">
              {bot.plan_name || 'No plan'}
              {bot.billing_cycle ? ` · ${bot.billing_cycle}` : ''}
            </div>
          </div>
        </div>

        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold tracking-tight text-surface-900 dark:text-surface-50">
            {fmtNumber(planRemaining)}
          </span>
          <span className="text-xs text-surface-500">/ {fmtNumber(monthlyGrant)} credits</span>
        </div>
        <Progress value={usedPct} className="mt-2" />
        <div className="mt-2 flex items-center justify-between text-[11px] text-surface-500 dark:text-surface-400">
          <span>{balancePct}% balance</span>
          <span>Resets {fmtDate(bot.resets_at)}</span>
        </div>

        {lowBalance && (
          <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 px-2.5 py-1.5 text-[11px] text-amber-800 dark:text-amber-200">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
            <span>Below 20% — this bot will pause when it hits zero.</span>
          </div>
        )}

        <div className="mt-3 space-y-1 text-[11px]">
          <UsageRow label="AI chats" credits={bot.usage?.ai_chat?.credits_used || 0} count={bot.usage?.ai_chat?.event_count || 0} />
          <UsageRow label="Documents" credits={bot.usage?.document_upload?.credits_used || 0} count={bot.usage?.document_upload?.event_count || 0} />
          <UsageRow label="URL pages" credits={bot.usage?.url_scan?.credits_used || 0} count={bot.usage?.url_scan?.event_count || 0} />
        </div>
        {bot.topup > 0 && (
          <div className="mt-2 text-[11px] text-surface-500 dark:text-surface-400">
            + {fmtNumber(bot.topup)} top-up credits ({currency})
          </div>
        )}

        {onTopup && (
          <div className="mt-3 pt-3 border-t border-surface-200 dark:border-surface-800">
            <Button variant="outline" size="sm" onClick={onTopup}>
              <CreditCoin className="w-3.5 h-3.5" />
              Top up {bot.bot_name}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UsageRow({ label, credits, count }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-surface-500 dark:text-surface-400">
        {label}{' '}
        <span className="text-surface-400 dark:text-surface-500">({fmtNumber(count)})</span>
      </span>
      <span className="font-medium text-surface-700 dark:text-surface-200 tabular-nums">
        −{fmtNumber(credits)}
      </span>
    </div>
  );
}

function TopupsTab({ currency, onTopup, recentTopups }) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Buy credit packs</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-surface-500 dark:text-surface-400 mb-4">
            Larger packs include bonus credits. All top-up credits roll over for 12 months from
            purchase, oldest first.
          </p>
          <div className="flex">
            <Button onClick={onTopup}>
              <CreditCoin className="w-4 h-4" />
              Open top-up packs
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent top-ups</CardTitle>
        </CardHeader>
        <CardContent>
          {recentTopups.length === 0 ? (
            <div className="text-sm text-surface-500 dark:text-surface-400 py-4">
              No top-up purchases yet.
            </div>
          ) : (
            <div className="overflow-x-auto -mx-2">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-surface-500 dark:text-surface-400">
                    <th className="px-3 py-2 font-semibold">When</th>
                    <th className="px-3 py-2 font-semibold">Note</th>
                    <th className="px-3 py-2 font-semibold text-right">Credits</th>
                    <th className="px-3 py-2 font-semibold text-right">Expires</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-100 dark:divide-surface-800">
                  {recentTopups.map((row) => (
                    <tr key={row.id}>
                      <td className="px-3 py-2 whitespace-nowrap text-surface-600 dark:text-surface-300">
                        {fmtDateTime(row.created_at)}
                      </td>
                      <td className="px-3 py-2 text-surface-500 dark:text-surface-400">
                        {row.note || '—'}
                      </td>
                      <td className="px-3 py-2 text-right text-emerald-600 dark:text-emerald-400 font-semibold">
                        +{fmtNumber(row.delta)}
                      </td>
                      <td className="px-3 py-2 text-right text-surface-500 dark:text-surface-400">
                        {fmtDate(row.expires_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <p className="text-[11px] text-surface-500 dark:text-surface-400 text-center">
        Currency: {currency}. We accept UPI, cards, and NetBanking via Razorpay.
      </p>
    </div>
  );
}

function SeatsTab({
  plan,
  subscription,
  currency,
  seatLimit,
  includedSeats,
  seatPriceLabel,
  seatBusy,
  portalBusy,
  syncBusy,
  onSeatChange,
  onBillingPortal,
  onChangePlan,
  onCreateBot,
  onSyncBilling,
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <span className="flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-surface-500" /> Current plan
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-surface-900 dark:text-surface-50">
                {plan?.name || 'Free'}
              </div>
              <div className="text-xs text-surface-500 dark:text-surface-400 mt-1">
                {plan?.monthly_price_cents > 0
                  ? `${fmtCurrency(plan.monthly_price_cents, currency)} / month · ${fmtNumber(plan.credits_per_month)} credits / month`
                  : 'No paid subscription'}
                {subscription?.payment_provider ? ` · billed via ${subscription.payment_provider}` : ''}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button onClick={onChangePlan} size="sm">
                <ArrowUpRight className="w-3.5 h-3.5" />
                {plan?.monthly_price_cents > 0 ? 'Change plan' : 'Choose a plan'}
              </Button>
              {/* Sync billing — manual fallback for the rare case where the
                  customer paid via Stripe but the local row didn't reconcile
                  (webhook didn't reach us, success URL got mangled, browser
                  closed mid-redirect). Asks Stripe for the latest paid
                  checkout on this customer and folds it in. Idempotent. */}
              <Button
                variant="outline"
                size="sm"
                onClick={onSyncBilling}
                disabled={syncBusy}
                title="Refresh billing state from Stripe"
              >
                {syncBusy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                Sync billing
              </Button>
              {subscription?.payment_provider === 'stripe' && (
                <Button variant="outline" size="sm" onClick={onBillingPortal} disabled={portalBusy}>
                  {portalBusy ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <ExternalLink className="w-3.5 h-3.5" />
                  )}
                  Stripe billing portal
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <span className="flex items-center gap-2">
              <Users className="w-4 h-4 text-surface-500" /> Operator seats
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <div className="text-sm text-surface-700 dark:text-surface-200">
                <strong>{seatLimit}</strong> {seatLimit === 1 ? 'seat' : 'seats'} total
                {includedSeats > 0
                  ? ` · ${includedSeats} included with your plan`
                  : ' · Free plan does not include operator seats'}
              </div>
              <div className="text-xs text-surface-500 dark:text-surface-400 mt-1">
                {includedSeats > 0
                  ? `Extra seats: ${seatPriceLabel} each / month. Live chat is free of credit charges — covered by the seat fee.`
                  : 'Upgrade to Starter to unlock live chat and invite operators to handle conversations.'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* On Free (includedSeats === 0) the Add/Remove buttons are
                  meaningless — there's nothing to add against and nothing
                  to remove. Replace with a single Upgrade CTA that opens
                  the plan-selector, same pattern as the Bot Seats card. */}
              {includedSeats === 0 ? (
                <Button onClick={onChangePlan} size="sm">
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  Upgrade to add seats
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onSeatChange(-1)}
                    disabled={seatBusy || seatLimit <= includedSeats}
                    title={
                      seatLimit <= includedSeats
                        ? `You can’t go below the ${includedSeats} included with your plan`
                        : ''
                    }
                  >
                    <Minus className="w-3.5 h-3.5" />
                    Remove seat
                  </Button>
                  <Button onClick={() => onSeatChange(1)} disabled={seatBusy} size="sm">
                    <Plus className="w-3.5 h-3.5" />
                    Add seat ({seatPriceLabel}/mo)
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Per-bot billing note — each additional chatbot lives under its
          own subscription. Compact single-row layout (no CardHeader split)
          so the title, blurb, and CTA all line up tightly. */}
      <Card>
        <CardContent className="py-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <Bot className="w-4 h-4 text-surface-500 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-surface-900 dark:text-surface-50">
                  Chatbots
                </div>
                <div className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
                  Each chatbot is its own subscription with isolated credits.
                  Free includes one bot; subscribe again to add more.
                </div>
              </div>
            </div>
            <Button onClick={onCreateBot} size="sm" className="shrink-0">
              <Plus className="w-3.5 h-3.5" />
              Create a bot
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function HistoryTab({ history, totalRemaining }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity history</CardTitle>
      </CardHeader>
      <CardContent>
        {history.length === 0 ? (
          <div className="text-sm text-surface-500 dark:text-surface-400 py-6 text-center">
            No credit activity yet.
          </div>
        ) : (
          <div className="overflow-x-auto -mx-2">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-surface-500 dark:text-surface-400">
                  <th className="px-3 py-2 font-semibold">When</th>
                  <th className="px-3 py-2 font-semibold">Reason</th>
                  <th className="px-3 py-2 font-semibold">Note</th>
                  <th className="px-3 py-2 font-semibold text-right">Δ Credits</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-100 dark:divide-surface-800">
                {history.map((row) => (
                  <tr key={row.id}>
                    <td className="px-3 py-2 text-surface-600 dark:text-surface-300 whitespace-nowrap">
                      {fmtDateTime(row.created_at)}
                    </td>
                    <td className="px-3 py-2 text-surface-700 dark:text-surface-200">
                      {resolveReasonLabel(row)}
                    </td>
                    <td className="px-3 py-2 text-surface-500 dark:text-surface-400 max-w-md truncate">
                      {row.note || '—'}
                    </td>
                    <td
                      className={cn(
                        'px-3 py-2 text-right font-semibold tabular-nums',
                        reasonStyle(row.reason, row.delta),
                      )}
                    >
                      {row.delta > 0 ? '+' : ''}
                      {fmtNumber(row.delta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-4 text-xs text-surface-500 dark:text-surface-400 text-center">
          Plan credits reset monthly · Top-up credits last 12 months from purchase (FIFO) · Total
          remaining: <strong className="text-surface-700 dark:text-surface-200">{fmtNumber(totalRemaining)}</strong>
        </p>
      </CardContent>
    </Card>
  );
}
