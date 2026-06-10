import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Sparkles,
  Zap,
  Globe,
  Mail,
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
} from 'lucide-react';
import {
  getCreditBalance,
  getCreditHistory,
  getCurrentSubscription,
  changeOperatorSeats,
  getBillingPortalUrl,
  verifyStripeTopup,
} from '../services/api';
import PageHeader from '../components/ui/PageHeader';
import Tabs from '../components/ui/Tabs';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import Progress from '../components/ui/Progress';
import { useToast } from '../context/ToastContext';
import TopupModal from '../components/credits/TopupModal';
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
  url_scan: 'URL crawl',
  email_send: 'Customer email',
  manual_adjust: 'Manual adjustment',
  refund: 'Refund',
  expiry: 'Top-up expiry',
};

function reasonStyle(reason, delta) {
  if (delta > 0) return 'text-emerald-600 dark:text-emerald-400';
  if (reason === 'expiry') return 'text-amber-600 dark:text-amber-400';
  return 'text-surface-700 dark:text-surface-300';
}

const COST_ROWS = [
  {
    key: 'ai_chat',
    icon: Zap,
    label: 'AI chat reply',
    detail: 'Each completed answer your bot streams to a visitor.',
    iconColor: 'text-amber-500',
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
  { id: 'topups', label: 'Buy credits', icon: Sparkles },
  { id: 'seats', label: 'Plan & seats', icon: Users },
  { id: 'history', label: 'History', icon: ListOrdered },
];

export default function Billing() {
  const { showToast } = useToast();
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
  const [seatBusy, setSeatBusy] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);

  // Persist tab choice in URL so refreshes / shares land on the right tab.
  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    if (activeTab && activeTab !== 'overview') params.set('tab', activeTab);
    else params.delete('tab');
    setSearchParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const monthlyGrant = balance?.monthly_grant || 0;
  const planRemaining = balance?.plan || 0;
  const topupRemaining = balance?.topup || 0;
  const totalRemaining = balance?.total || 0;
  const currency = balance?.currency || plan?.currency || 'USD';
  const currencySymbol = balance?.currency_symbol || (currency === 'USD' ? '$' : currency === 'INR' ? '₹' : currency);

  const planUsedPct = useMemo(() => {
    if (!monthlyGrant) return 0;
    const used = Math.max(monthlyGrant - planRemaining, 0);
    return Math.min(Math.round((used / monthlyGrant) * 100), 100);
  }, [monthlyGrant, planRemaining]);

  const lowBalance = monthlyGrant > 0 && planRemaining <= monthlyGrant * 0.2;

  const seatLimit = subscription?.operator_quantity ?? plan?.included_operator_seats ?? 1;
  const includedSeats = plan?.included_operator_seats ?? 1;
  const seatPriceLabel = fmtCurrency(plan?.extra_seat_price_cents ?? 119900, currency);

  const usage = balance?.usage || {};
  const costs = balance?.costs || { ai_chat: 1, url_scan: 3, email_send: 1 };

  // Plan credits consumed this period = grant minus what's left. Top-up
  // consumption isn't bucketed by period (top-ups span 12 months) so we
  // surface only the plan-bucket usage here.
  const periodUsed = Math.max(monthlyGrant - planRemaining, 0);

  async function handleSeatChange(delta) {
    setSeatBusy(true);
    try {
      const result = await changeOperatorSeats(delta);
      showToast(
        delta > 0
          ? `Added a seat (now ${result?.operator_quantity ?? '?'} total).`
          : `Removed a seat (now ${result?.operator_quantity ?? '?'} total).`,
        'success',
      );
      await loadAll({ silent: true });
    } catch (err) {
      showToast(err?.message || 'Failed to update seats', 'error');
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing"
        subtitle="Plan, credits, top-ups, and operator seats — all in one place."
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
        <Button onClick={() => setTopupOpen(true)} disabled={loading}>
          <Sparkles className="w-4 h-4" />
          Buy more credits
        </Button>
      </PageHeader>

      <Tabs tabs={TABS} activeTab={activeTab} onChange={setActiveTab} variant="underline" />

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
              currencySymbol={currencySymbol}
              monthlyGrant={monthlyGrant}
              planRemaining={planRemaining}
              topupRemaining={topupRemaining}
              totalRemaining={totalRemaining}
              planUsedPct={planUsedPct}
              periodUsed={periodUsed}
              usage={usage}
              costs={costs}
              lowBalance={lowBalance}
              onTopup={() => setTopupOpen(true)}
            />
          )}

          {activeTab === 'topups' && (
            <TopupsTab
              currency={currency}
              currencySymbol={currencySymbol}
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
              onSeatChange={handleSeatChange}
              onBillingPortal={handleBillingPortal}
            />
          )}

          {activeTab === 'history' && (
            <HistoryTab history={history} totalRemaining={totalRemaining} />
          )}
        </>
      )}

      <TopupModal
        open={topupOpen}
        onClose={() => setTopupOpen(false)}
        onSuccess={() => {
          setTimeout(() => loadAll({ silent: true }), 1500);
          setTimeout(() => loadAll({ silent: true }), 4500);
        }}
      />
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
  planUsedPct,
  periodUsed,
  usage,
  costs,
  lowBalance,
  balance,
  onTopup,
}) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                {fmtNumber(planRemaining)}
              </span>
              <span className="text-sm text-surface-500">/ {fmtNumber(monthlyGrant)}</span>
            </div>
            <Progress value={planUsedPct} className="mt-3" />
            <div className="mt-3 flex items-center justify-between text-xs text-surface-500 dark:text-surface-400">
              <span>{planUsedPct}% used this period</span>
              <span>Resets {fmtDate(balance?.resets_at)}</span>
            </div>
            {lowBalance && (
              <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>Below 20% of your monthly allowance. Top up to keep your bot running.</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <span className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-primary-500" /> Top-up credits
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold tracking-tight text-surface-900 dark:text-surface-50">
                {fmtNumber(topupRemaining)}
              </span>
              <span className="text-sm text-surface-500">credits</span>
            </div>
            <div className="mt-3 text-xs text-surface-500 dark:text-surface-400">
              {topupRemaining > 0
                ? `Oldest expires ${fmtDate(balance?.soonest_expiry)}`
                : 'No top-up credits yet — they roll over for 12 months.'}
            </div>
            <div className="mt-4">
              <Button variant="outline" size="sm" onClick={onTopup}>
                <Sparkles className="w-3.5 h-3.5" />
                Top up
              </Button>
            </div>
          </CardContent>
        </Card>

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
              {fmtNumber(periodUsed)}
            </div>
            <div className="text-xs text-surface-500 mt-1">credits consumed</div>
            <div className="mt-3 space-y-1.5 text-xs">
              <UsageRow label="AI chats" credits={usage?.ai_chat?.credits_used || 0} count={usage?.ai_chat?.event_count || 0} />
              <UsageRow label="URL pages" credits={usage?.url_scan?.credits_used || 0} count={usage?.url_scan?.event_count || 0} />
              {/* <UsageRow label="Customer emails" credits={usage?.email_send?.credits_used || 0} count={usage?.email_send?.event_count || 0} /> */}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Plan summary */}
      <Card>
        <CardContent>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-surface-500" />
                <span className="text-sm font-semibold text-surface-900 dark:text-surface-50">
                  {plan?.name || 'Free'} plan
                </span>
                {subscription?.status && (
                  <span className="text-[11px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-300">
                    {subscription.status}
                  </span>
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
                Total credits: <strong className="text-surface-700 dark:text-surface-200">{fmtNumber(totalRemaining)}</strong>
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
              <Sparkles className="w-4 h-4" />
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
  onSeatChange,
  onBillingPortal,
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
                <strong>{seatLimit}</strong> {seatLimit === 1 ? 'seat' : 'seats'} total ·{' '}
                {includedSeats} included with your plan
              </div>
              <div className="text-xs text-surface-500 dark:text-surface-400 mt-1">
                Extra seats: {seatPriceLabel} each / month. Live chat is free of credit charges
                — covered by the seat fee.
              </div>
            </div>
            <div className="flex items-center gap-2">
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
            </div>
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
                      {REASON_LABEL[row.reason] || row.reason}
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
