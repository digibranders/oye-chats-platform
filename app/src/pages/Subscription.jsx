import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  CreditCard, Zap, ArrowUpRight, MessageSquare, Globe, Users, HardDrive,
  Mail, Shield, Crown, CheckCircle, XCircle, AlertTriangle, ExternalLink,
  Receipt, Sparkles, Bot, Headphones,
} from 'lucide-react';
import {
  getCurrentSubscription, getSubscriptionUsage, getSubscriptionPlans,
  getInvoices, createCheckoutSession, getBillingPortalUrl,
  cancelSubscription, resumeSubscription,
} from '../services/api';
import { useToast } from '../context/ToastContext';
import PageHeader from '../components/ui/PageHeader';
import Progress from '../components/ui/Progress';
import { cn } from '../lib/utils';

/** Validate that a URL points to a trusted payment domain before redirecting. */
const TRUSTED_REDIRECT_DOMAINS = ['checkout.stripe.com', 'billing.stripe.com'];
const isTrustedRedirectUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && TRUSTED_REDIRECT_DOMAINS.some(
      (d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d)
    );
  } catch {
    return false;
  }
};

const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } },
};

const UNLIMITED = -1;

function formatLimit(used, limit) {
  if (limit === UNLIMITED || limit < 0) return `${used.toLocaleString()} / Unlimited`;
  return `${used.toLocaleString()} / ${limit.toLocaleString()}`;
}

function usagePercent(used, limit) {
  if (limit === UNLIMITED || limit <= 0) return 0;
  return Math.min((used / limit) * 100, 100);
}

function usageColor(pct) {
  if (pct >= 90) return 'error';
  if (pct >= 75) return 'warning';
  return 'primary';
}

function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS_BADGES = {
  active: { label: 'Active', color: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  trialing: { label: 'Trial', color: 'bg-sky-500/10 text-sky-600 dark:text-sky-400' },
  past_due: { label: 'Past Due', color: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  canceled: { label: 'Canceled', color: 'bg-rose-500/10 text-rose-600 dark:text-rose-400' },
  paused: { label: 'Paused', color: 'bg-surface-500/10 text-surface-600 dark:text-surface-400' },
};

export default function Subscription() {
  const { showToast } = useToast();
  const [subscription, setSubscription] = useState(null);
  const [plan, setPlan] = useState(null);
  const [usage, setUsage] = useState(null);
  const [plans, setPlans] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showPlans, setShowPlans] = useState(false);
  const [billingCycle, setBillingCycle] = useState('monthly');
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [subData, usageData, plansData, invoiceData] = await Promise.all([
        getCurrentSubscription().catch(() => null),
        getSubscriptionUsage().catch(() => null),
        getSubscriptionPlans().catch(() => []),
        getInvoices().catch(() => []),
      ]);
      if (subData) {
        setSubscription(subData.subscription);
        setPlan(subData.plan);
      }
      setUsage(usageData);
      setPlans(plansData);
      setInvoices(invoiceData);
    } catch (error) {
      showToast('error', error.message || 'Failed to load billing data');
    } finally {
      setLoading(false);
    }
  };

  const handleUpgrade = async (targetPlanId) => {
    setActionLoading(true);
    try {
      const result = await createCheckoutSession(targetPlanId, billingCycle);
      if (result.checkout_url && isTrustedRedirectUrl(result.checkout_url)) {
        window.location.href = result.checkout_url;
      } else if (result.checkout_url) {
        showToast('error', 'Received an untrusted checkout URL. Please contact support.');
      }
    } catch (error) {
      showToast('error', error.message || 'Failed to start checkout');
    } finally {
      setActionLoading(false);
    }
  };

  const handleManageBilling = async () => {
    try {
      const result = await getBillingPortalUrl();
      if (result.portal_url && isTrustedRedirectUrl(result.portal_url)) {
        window.open(result.portal_url, '_blank');
      } else if (result.portal_url) {
        showToast('error', 'Received an untrusted billing URL. Please contact support.');
      }
    } catch (error) {
      showToast('error', error.message || 'Failed to open billing portal');
    }
  };

  const handleCancel = async () => {
    if (!window.confirm('Are you sure you want to cancel your subscription? It will remain active until the end of the current billing period.')) return;
    setActionLoading(true);
    try {
      await cancelSubscription('User requested cancellation from dashboard');
      showToast('success', 'Subscription will be canceled at the end of the billing period.');
      fetchData();
    } catch (error) {
      showToast('error', error.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleResume = async () => {
    setActionLoading(true);
    try {
      await resumeSubscription();
      showToast('success', 'Subscription resumed successfully.');
      fetchData();
    } catch (error) {
      showToast('error', error.message);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <PageHeader title="Subscription" subtitle="Manage your plan and billing" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-48 bg-surface-100 dark:bg-surface-800 rounded-2xl animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const usageMetrics = usage?.usage || {};
  const isFreePlan = plan?.slug === 'free';
  const statusBadge = STATUS_BADGES[subscription?.status] || STATUS_BADGES.active;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <PageHeader
        title="Subscription"
        subtitle="Manage your plan, usage, and billing"
      />

      {/* Current Plan Card */}
      <motion.div {...fadeUp} className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className={cn(
              'w-12 h-12 rounded-xl flex items-center justify-center',
              isFreePlan
                ? 'bg-surface-100 dark:bg-surface-800'
                : 'bg-gradient-to-br from-primary-500 to-primary-700 shadow-lg shadow-primary-500/25'
            )}>
              {isFreePlan ? <Zap size={20} className="text-surface-500" /> : <Crown size={20} className="text-white" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-surface-900 dark:text-white">{plan?.name || 'Free'} Plan</h2>
                <span className={cn('px-2 py-0.5 rounded-full text-[11px] font-semibold', statusBadge.color)}>
                  {statusBadge.label}
                </span>
              </div>
              {subscription ? (
                <p className="text-[13px] text-surface-500 dark:text-surface-400 mt-0.5">
                  {plan?.pricing_model === 'per_operator'
                    ? `${formatCents(plan?.monthly_price_cents || 0)}/operator/mo`
                    : formatCents(plan?.monthly_price_cents || 0) + '/mo'
                  }
                  {subscription.billing_cycle === 'annual' && ' (billed annually)'}
                  {subscription.current_period_end && ` · Renews ${formatDate(subscription.current_period_end)}`}
                </p>
              ) : (
                <p className="text-[13px] text-surface-500 dark:text-surface-400 mt-0.5">No active subscription</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {subscription?.cancel_at_period_end ? (
              <button
                onClick={handleResume}
                disabled={actionLoading}
                className="px-4 py-2 text-[13px] font-medium rounded-xl bg-emerald-500 text-white hover:bg-emerald-600 transition-colors disabled:opacity-50"
              >
                Resume Subscription
              </button>
            ) : (
              <>
                <button
                  onClick={() => setShowPlans(!showPlans)}
                  className="px-4 py-2 text-[13px] font-medium rounded-xl bg-primary-500 text-white hover:bg-primary-600 transition-colors flex items-center gap-1.5"
                >
                  <ArrowUpRight size={14} />
                  {isFreePlan ? 'Upgrade' : 'Change Plan'}
                </button>
                {!isFreePlan && (
                  <button
                    onClick={handleManageBilling}
                    className="px-4 py-2 text-[13px] font-medium rounded-xl border border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors flex items-center gap-1.5"
                  >
                    <CreditCard size={14} />
                    Manage Billing
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* Cancel warning */}
        {subscription?.cancel_at_period_end && (
          <div className="mt-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-2">
            <AlertTriangle size={16} className="text-amber-500 mt-0.5 flex-shrink-0" />
            <p className="text-[13px] text-amber-700 dark:text-amber-300">
              Your subscription is scheduled to cancel on <strong>{formatDate(subscription.current_period_end)}</strong>. You can resume anytime before then.
            </p>
          </div>
        )}
      </motion.div>

      {/* Usage Meters */}
      {usage && (
        <motion.div {...fadeUp} className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-6">
          <h3 className="text-[15px] font-bold text-surface-900 dark:text-white mb-1">Usage This Period</h3>
          <p className="text-[12px] text-surface-500 dark:text-surface-400 mb-5">
            {formatDate(usage.period?.start)} — {formatDate(usage.period?.end)}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {[
              { key: 'ai_messages', label: 'AI Messages', icon: MessageSquare },
              { key: 'url_scans', label: 'URL Scans', icon: Globe },
              { key: 'live_chat_messages', label: 'Live Chat Messages', icon: Headphones },
              { key: 'email_summaries', label: 'Email Summaries', icon: Mail },
              { key: 'bots', label: 'Bots', icon: Bot },
              { key: 'storage_mb', label: 'Storage (MB)', icon: HardDrive },
            // eslint-disable-next-line no-unused-vars
            ].map(({ key, label, icon: Icon }) => {
              const metric = usageMetrics[key];
              if (!metric) return null;
              const pct = usagePercent(metric.used, metric.limit);
              const color = usageColor(pct);
              return (
                <div key={key} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon size={14} className="text-surface-400 dark:text-surface-500" />
                      <span className="text-[13px] font-medium text-surface-700 dark:text-surface-300">{label}</span>
                    </div>
                    <span className="text-[12px] font-mono text-surface-500 dark:text-surface-400">
                      {formatLimit(metric.used, metric.limit)}
                    </span>
                  </div>
                  <Progress value={metric.used} max={metric.limit <= 0 ? 1 : metric.limit} color={color} size="sm" />
                  {pct >= 90 && metric.limit > 0 && (
                    <p className="text-[11px] text-rose-500 font-medium flex items-center gap-1">
                      <AlertTriangle size={11} />
                      {pct >= 100 ? 'Limit reached — upgrade to continue' : 'Approaching limit'}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          {usage.overage?.messages > 0 && (
            <div className="mt-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
              <p className="text-[13px] text-amber-700 dark:text-amber-300">
                <strong>{usage.overage.messages.toLocaleString()}</strong> overage messages · Estimated charge: <strong>{formatCents(usage.overage.amount_cents)}</strong>
              </p>
            </div>
          )}
        </motion.div>
      )}

      {/* Plan Comparison */}
      {showPlans && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-6"
        >
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-[15px] font-bold text-surface-900 dark:text-white">Choose a Plan</h3>
            <div className="flex items-center bg-surface-100 dark:bg-surface-800 rounded-lg p-0.5">
              {['monthly', 'annual'].map(cycle => (
                <button
                  key={cycle}
                  onClick={() => setBillingCycle(cycle)}
                  className={cn(
                    'px-3 py-1.5 text-[12px] font-medium rounded-md transition-all',
                    billingCycle === cycle
                      ? 'bg-white dark:bg-surface-700 text-surface-900 dark:text-white shadow-sm'
                      : 'text-surface-500 dark:text-surface-400'
                  )}
                >
                  {cycle === 'monthly' ? 'Monthly' : 'Annual (Save 30%)'}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {plans.map(p => {
              const isCurrent = p.id === plan?.id;
              const isEnterprise = p.slug === 'enterprise';
              const price = billingCycle === 'annual' && p.annual_price_cents > 0
                ? Math.round(p.annual_price_cents / 12)
                : p.monthly_price_cents;
              return (
                <div
                  key={p.id}
                  className={cn(
                    'rounded-xl border p-5 transition-all',
                    isCurrent
                      ? 'border-primary-500 bg-primary-50/50 dark:bg-primary-500/5 dark:border-primary-500/50'
                      : 'border-surface-200 dark:border-surface-800 hover:border-surface-300 dark:hover:border-surface-700'
                  )}
                >
                  <h4 className="text-[14px] font-bold text-surface-900 dark:text-white">{p.name}</h4>
                  <p className="text-[12px] text-surface-500 dark:text-surface-400 mt-1 h-8">{p.description}</p>
                  <div className="mt-3">
                    {isEnterprise ? (
                      <p className="text-lg font-bold text-surface-900 dark:text-white">Custom</p>
                    ) : (
                      <p className="text-lg font-bold text-surface-900 dark:text-white">
                        {price === 0 ? 'Free' : formatCents(price)}
                        {price > 0 && (
                          <span className="text-[12px] font-normal text-surface-500">
                            /{p.pricing_model === 'per_operator' ? 'operator/' : ''}mo
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                  <ul className="mt-4 space-y-1.5">
                    {[
                      `${p.limits?.ai_messages === -1 ? 'Unlimited' : (p.limits?.ai_messages || 0).toLocaleString()} AI messages`,
                      `${p.limits?.url_scans === -1 ? 'Unlimited' : p.limits?.url_scans || 0} URL scans`,
                      p.features?.live_chat ? 'Live chat included' : null,
                      p.features?.bant ? 'BANT qualification' : null,
                      p.features?.webhooks ? 'Webhooks' : null,
                      p.features?.api_access ? 'API access' : null,
                      p.features?.sso ? 'SSO & security' : null,
                    ].filter(Boolean).map((feat, i) => (
                      <li key={i} className="flex items-center gap-2 text-[12px] text-surface-600 dark:text-surface-400">
                        <CheckCircle size={12} className="text-emerald-500 flex-shrink-0" />
                        {feat}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-5">
                    {isCurrent ? (
                      <div className="w-full py-2 text-center text-[12px] font-semibold text-primary-500 bg-primary-50 dark:bg-primary-500/10 rounded-lg">
                        Current Plan
                      </div>
                    ) : isEnterprise ? (
                      <a
                        href="mailto:sales@oyechats.com"
                        className="block w-full py-2 text-center text-[12px] font-semibold border border-surface-300 dark:border-surface-700 rounded-lg hover:bg-surface-50 dark:hover:bg-surface-800 transition-colors text-surface-700 dark:text-surface-300"
                      >
                        Contact Sales
                      </a>
                    ) : (
                      <button
                        onClick={() => handleUpgrade(p.id)}
                        disabled={actionLoading}
                        className="w-full py-2 text-[12px] font-semibold bg-primary-500 text-white rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50"
                      >
                        {p.monthly_price_cents > (plan?.monthly_price_cents || 0) ? 'Upgrade' : 'Switch'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </motion.div>
      )}

      {/* Features */}
      {plan?.features && (
        <motion.div {...fadeUp} className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-6">
          <h3 className="text-[15px] font-bold text-surface-900 dark:text-white mb-4">Plan Features</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {[
              { key: 'live_chat', label: 'Live Chat' },
              { key: 'bant', label: 'BANT Scoring' },
              { key: 'webhooks', label: 'Webhooks' },
              { key: 'api_access', label: 'API Access' },
              { key: 'advanced_analytics', label: 'Advanced Analytics' },
              { key: 'branding_removable', label: 'Remove Branding' },
              { key: 'sso', label: 'SSO' },
              { key: 'custom_sla', label: 'Custom SLA' },
              { key: 'dedicated_csm', label: 'Dedicated CSM' },
              { key: 'whitelabel', label: 'White Label' },
            ].map(({ key, label }) => {
              const enabled = plan.features[key];
              return (
                <div
                  key={key}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-lg',
                    enabled
                      ? 'bg-emerald-50 dark:bg-emerald-500/10'
                      : 'bg-surface-50 dark:bg-surface-800/50'
                  )}
                >
                  {enabled ? (
                    <CheckCircle size={14} className="text-emerald-500 flex-shrink-0" />
                  ) : (
                    <XCircle size={14} className="text-surface-300 dark:text-surface-600 flex-shrink-0" />
                  )}
                  <span className={cn(
                    'text-[12px] font-medium',
                    enabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-surface-400 dark:text-surface-500'
                  )}>
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        </motion.div>
      )}

      {/* Invoices */}
      {invoices.length > 0 && (
        <motion.div {...fadeUp} className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-6">
          <h3 className="text-[15px] font-bold text-surface-900 dark:text-white mb-4">Payment History</h3>
          <div className="space-y-2">
            {invoices.slice(0, 10).map(inv => (
              <div key={inv.id} className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-surface-50 dark:hover:bg-surface-800/50 transition-colors">
                <div className="flex items-center gap-3">
                  <Receipt size={16} className="text-surface-400" />
                  <div>
                    <p className="text-[13px] font-medium text-surface-700 dark:text-surface-300">
                      {inv.description || 'Invoice'}
                    </p>
                    <p className="text-[11px] text-surface-500">{formatDate(inv.created_at)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={cn(
                    'text-[13px] font-semibold',
                    inv.status === 'paid' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
                  )}>
                    {formatCents(inv.amount_cents)}
                  </span>
                  {inv.invoice_url && (
                    <a
                      href={inv.invoice_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary-500 hover:text-primary-600"
                    >
                      <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Cancel */}
      {subscription && !isFreePlan && !subscription.cancel_at_period_end && (
        <motion.div {...fadeUp} className="flex justify-end">
          <button
            onClick={handleCancel}
            disabled={actionLoading}
            className="text-[12px] text-surface-400 hover:text-rose-500 transition-colors disabled:opacity-50"
          >
            Cancel subscription
          </button>
        </motion.div>
      )}
    </div>
  );
}
