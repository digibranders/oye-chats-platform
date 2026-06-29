import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    Wallet,
    TrendingUp,
    Users as UsersIcon,
    Receipt,
    Loader2,
    PieChart as PieChartIcon,
    Calendar,
    Eye,
    X,
    ExternalLink,
    ChevronLeft,
    ChevronRight,
    ArrowUp,
    ArrowDown,
    ArrowLeftRight,
} from 'lucide-react';
import {
    getSuperadminRevenue,
    getSuperadminPlans,
    getSuperadminSubscriptions,
} from '../../services/api';
import { useToast } from '../../context/ToastContext';

// ─── helpers ─────────────────────────────────────────────────────────────────

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const formatCents = (cents) => {
    const value = Number(cents || 0) / 100;
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: value % 1 === 0 ? 0 : 2,
    }).format(value);
};

const formatNumber = (n) => {
    if (n == null || Number.isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US');
};

const monthlyEquivalentCents = (plan, sub) => {
    if (!plan || !sub) return 0;
    const seats = Math.max(1, sub.operator_quantity || 1);
    if (sub.billing_cycle === 'annual' && plan.annual_price_cents > 0) {
        const perSeat = Math.round(plan.annual_price_cents / 12);
        return plan.pricing_model === 'per_operator' ? perSeat * seats : perSeat;
    }
    const monthly = plan.monthly_price_cents || 0;
    return plan.pricing_model === 'per_operator' ? monthly * seats : monthly;
};

// ─── StatCard ────────────────────────────────────────────────────────────────

function StatCard({ icon, label, value, hint, accent }) {
    const accentMap = {
        violet: 'text-primary-500 bg-primary-500/10',
        emerald: 'text-emerald-500 bg-emerald-500/10',
        blue: 'text-blue-500 bg-blue-500/10',
        amber: 'text-amber-500 bg-amber-500/10',
    };
    return (
        <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm relative overflow-hidden transition-all hover:shadow-md">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="text-sm font-medium text-surface-500 dark:text-surface-400">{label}</h3>
                    <p className="mt-3 text-3xl font-bold text-surface-900 dark:text-surface-100 tracking-tight">{value}</p>
                    {hint && (
                        <p className="mt-2 text-xs text-surface-500 dark:text-surface-400">{hint}</p>
                    )}
                </div>
                <div className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center ${accentMap[accent] || accentMap.violet}`}>
                    {icon}
                </div>
            </div>
        </div>
    );
}

// ─── MonthPicker ─────────────────────────────────────────────────────────────

function MonthPicker({ selected, onChange }) {
    const [open, setOpen] = useState(false);
    const [pickerYear, setPickerYear] = useState(selected.getFullYear());
    const ref = useRef(null);
    const today = new Date();

    useEffect(() => {
        if (!open) return;
        const handler = (e) => {
            if (ref.current && !ref.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    const label = selected.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    const handleOpen = () => {
        setPickerYear(selected.getFullYear());
        setOpen((v) => !v);
    };

    return (
        <div className="relative" ref={ref}>
            <button
                onClick={handleOpen}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary-50 dark:bg-primary-500/10 border border-primary-100 dark:border-primary-500/20 text-primary-700 dark:text-primary-300 text-xs font-medium hover:bg-primary-100 dark:hover:bg-primary-500/20 transition-colors"
            >
                <Calendar size={13} />
                {label}
            </button>

            {open && (
                <div className="absolute right-0 top-full mt-2 z-50 bg-white dark:bg-surface-900 rounded-2xl shadow-2xl border border-surface-200 dark:border-surface-700 p-4 w-60">
                    {/* Year navigation */}
                    <div className="flex items-center justify-between mb-3">
                        <button
                            onClick={() => setPickerYear((y) => y - 1)}
                            className="w-7 h-7 rounded-lg flex items-center justify-center text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800 hover:text-surface-900 dark:hover:text-surface-100 transition-colors"
                        >
                            <ChevronLeft size={14} />
                        </button>
                        <span className="text-sm font-semibold text-surface-900 dark:text-surface-100">
                            {pickerYear}
                        </span>
                        <button
                            onClick={() => setPickerYear((y) => y + 1)}
                            disabled={pickerYear >= today.getFullYear()}
                            className="w-7 h-7 rounded-lg flex items-center justify-center text-surface-500 hover:bg-surface-100 dark:hover:bg-surface-800 hover:text-surface-900 dark:hover:text-surface-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                        >
                            <ChevronRight size={14} />
                        </button>
                    </div>

                    {/* Month grid */}
                    <div className="grid grid-cols-3 gap-1.5">
                        {MONTH_NAMES.map((m, idx) => {
                            const isFuture =
                                pickerYear > today.getFullYear() ||
                                (pickerYear === today.getFullYear() && idx > today.getMonth());
                            const isSelected =
                                pickerYear === selected.getFullYear() && idx === selected.getMonth();
                            return (
                                <button
                                    key={m}
                                    disabled={isFuture}
                                    onClick={() => {
                                        onChange(new Date(pickerYear, idx, 1));
                                        setOpen(false);
                                    }}
                                    className={`py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                        isSelected
                                            ? 'bg-primary-500 text-white shadow-sm'
                                            : isFuture
                                            ? 'text-surface-300 dark:text-surface-600 cursor-not-allowed'
                                            : 'text-surface-700 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800'
                                    }`}
                                >
                                    {m}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── PlanChangeBadge ─────────────────────────────────────────────────────────

function PlanChangeBadge({ planChange }) {
    if (!planChange) return null;
    const cfg = {
        upgraded: {
            icon: <ArrowUp size={10} />,
            cls: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
            label: 'Upgraded',
        },
        downgraded: {
            icon: <ArrowDown size={10} />,
            cls: 'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400',
            label: 'Downgraded',
        },
        changed: {
            icon: <ArrowLeftRight size={10} />,
            cls: 'bg-sky-50 dark:bg-sky-500/10 text-sky-700 dark:text-sky-400',
            label: 'Changed',
        },
    }[planChange.type];

    if (!cfg) return null;

    return (
        <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium ${cfg.cls}`}
            title={`${cfg.label} from ${planChange.from}`}
        >
            {cfg.icon}
            {cfg.label} from {planChange.from}
        </span>
    );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function SuperadminPricingInsights() {
    const { showToast } = useToast();
    const [revenue, setRevenue] = useState(null);
    const [plans, setPlans] = useState([]);
    const [subscriptions, setSubscriptions] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [viewingPlan, setViewingPlan] = useState(null);
    const [selectedMonth, setSelectedMonth] = useState(() => {
        const d = new Date();
        return new Date(d.getFullYear(), d.getMonth(), 1);
    });
    const modalRef = useRef(null);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            setIsLoading(true);
            try {
                // Fetch all subscriptions (all statuses) so we can filter by month
                // and detect upgrade/downgrade history.
                const [rev, planList, subs] = await Promise.all([
                    getSuperadminRevenue(),
                    getSuperadminPlans(),
                    getSuperadminSubscriptions(),
                ]);
                if (cancelled) return;
                setRevenue(rev);
                setPlans(Array.isArray(planList) ? planList : []);
                setSubscriptions(Array.isArray(subs) ? subs : []);
            } catch (err) {
                console.error('Failed to load pricing insights', err);
                if (!cancelled) {
                    showToast('error', err.message || 'Failed to load pricing insights');
                }
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        };
        load();
        return () => { cancelled = true; };
    }, [showToast]);

    const monthLabel = selectedMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    // Inclusive date range for the selected month
    const { monthStart, monthEnd } = useMemo(() => ({
        monthStart: selectedMonth,
        monthEnd: new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() + 1, 0, 23, 59, 59, 999),
    }), [selectedMonth]);

    // Subscriptions that were active at any point during the selected month:
    //   created before end-of-month AND (not canceled, OR canceled after start-of-month)
    const monthSubs = useMemo(() => {
        return subscriptions.filter((sub) => {
            if (!sub.created_at) return false;
            if (new Date(sub.created_at) > monthEnd) return false;
            if (sub.canceled_at && new Date(sub.canceled_at) < monthStart) return false;
            return true;
        });
    }, [subscriptions, monthStart, monthEnd]);

    // Deduplicate: per client keep only their most-recently-created subscription
    // within the month window. Older subs for the same client become "previous"
    // and are used to detect upgrade / downgrade.
    const { dedupedSubs, prevSubMap } = useMemo(() => {
        const latestMap = new Map();
        for (const sub of monthSubs) {
            const prev = latestMap.get(sub.client_id);
            if (!prev || new Date(sub.created_at) > new Date(prev.created_at)) {
                latestMap.set(sub.client_id, sub);
            }
        }
        const prevMap = new Map();
        for (const sub of monthSubs) {
            const latest = latestMap.get(sub.client_id);
            if (!latest || sub.id === latest.id) continue;
            const prev = prevMap.get(sub.client_id);
            if (!prev || new Date(sub.created_at) > new Date(prev.created_at)) {
                prevMap.set(sub.client_id, sub);
            }
        }
        return { dedupedSubs: Array.from(latestMap.values()), prevSubMap: prevMap };
    }, [monthSubs]);

    // Plan breakdown for the selected month
    const planBreakdown = useMemo(() => {
        const planMap = new Map(plans.map((p) => [p.id, p]));
        const buckets = new Map();

        for (const sub of dedupedSubs) {
            const plan = planMap.get(sub.plan_id);
            if (!plan) continue;
            const mrr = monthlyEquivalentCents(plan, sub);

            const bucket = buckets.get(plan.id) || {
                planId: plan.id,
                planName: plan.name,
                subscribers: 0,
                mrrCents: 0,
                clients: [],
            };

            // Detect upgrade / downgrade vs previous plan
            const prevSub = prevSubMap.get(sub.client_id);
            const prevPlan = prevSub ? planMap.get(prevSub.plan_id) : null;
            let planChange = null;
            if (prevPlan && prevPlan.id !== plan.id) {
                const prevPrice = prevPlan.monthly_price_cents ?? 0;
                const currPrice = plan.monthly_price_cents ?? 0;
                planChange = {
                    type: currPrice > prevPrice ? 'upgraded' : currPrice < prevPrice ? 'downgraded' : 'changed',
                    from: prevPlan.name,
                };
            }

            bucket.subscribers += 1;
            bucket.mrrCents += mrr;
            bucket.clients.push({
                clientId: sub.client_id,
                clientName: sub.client_name || `Customer #${sub.client_id}`,
                clientEmail: sub.client_email || null,
                billingCycle: sub.billing_cycle,
                planChange,
            });
            buckets.set(plan.id, bucket);
        }
        return Array.from(buckets.values()).sort((a, b) => b.mrrCents - a.mrrCents);
    }, [plans, dedupedSubs, prevSubMap]);

    const totalPlanMrr = planBreakdown.reduce((s, p) => s + p.mrrCents, 0);
    const topPlanShare =
        totalPlanMrr > 0 && planBreakdown.length > 0
            ? Math.round((planBreakdown[0].mrrCents / totalPlanMrr) * 100)
            : null;

    // Compute KPIs from the selected month's subscriptions
    const payingCustomers = useMemo(() => {
        const planMap = new Map(plans.map((p) => [p.id, p]));
        return dedupedSubs.filter((s) => {
            const plan = planMap.get(s.plan_id);
            return plan && (plan.monthly_price_cents > 0 || plan.annual_price_cents > 0);
        }).length;
    }, [dedupedSubs, plans]);

    const mrrCents = totalPlanMrr;
    const arrCents = totalPlanMrr * 12;
    const lifetimeCents = revenue?.total_revenue_cents ?? 0;
    const arpuCents = payingCustomers > 0 ? Math.round(mrrCents / payingCustomers) : 0;

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-24">
                <Loader2 className="animate-spin text-surface-600 dark:text-surface-300" size={28} />
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-slide-up">
            {/* Header */}
            <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                    <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-100">
                        Pricing Insights
                    </h1>
                    <p className="text-surface-500 dark:text-surface-400 mt-1">
                        Revenue performance, plan mix, and active subscription value for {monthLabel}.
                    </p>
                </div>
                <MonthPicker selected={selectedMonth} onChange={setSelectedMonth} />
            </div>

            {/* KPI stats */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                <StatCard
                    icon={<Wallet size={16} />}
                    label={`MRR · ${monthLabel.split(' ')[0]}`}
                    value={formatCents(mrrCents)}
                    hint={`${formatNumber(dedupedSubs.length)} total subscriber${dedupedSubs.length === 1 ? '' : 's'}`}
                    accent="emerald"
                />
                <StatCard
                    icon={<TrendingUp size={16} />}
                    label="Projected ARR"
                    value={formatCents(arrCents)}
                    hint="Annualized run rate from MRR"
                    accent="violet"
                />
                <StatCard
                    icon={<Receipt size={16} />}
                    label="Lifetime Revenue"
                    value={formatCents(lifetimeCents)}
                    hint="All paid invoices to date"
                    accent="blue"
                />
                <StatCard
                    icon={<UsersIcon size={16} />}
                    label="Avg Revenue / Customer"
                    value={formatCents(arpuCents)}
                    hint={`${formatNumber(payingCustomers)} paying customer${payingCustomers === 1 ? '' : 's'}`}
                    accent="amber"
                />
            </div>

            {/* Plan mix + Subscription status */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm lg:col-span-2">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                            <PieChartIcon size={16} className="text-primary-500" />
                            <h2 className="text-sm font-semibold text-surface-900 dark:text-surface-100">
                                Plan mix · Monthly recurring
                            </h2>
                        </div>
                        {topPlanShare !== null && (
                            <span className="text-xs font-medium px-2 py-1 rounded-full bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300">
                                {topPlanShare}% top plan
                            </span>
                        )}
                    </div>
                    {planBreakdown.length === 0 ? (
                        <p className="text-sm text-surface-500 dark:text-surface-400 py-8 text-center">
                            No active subscriptions in {monthLabel}.
                        </p>
                    ) : (
                        <div className="space-y-4">
                            {planBreakdown.map((p) => {
                                const pct = totalPlanMrr > 0 ? (p.mrrCents / totalPlanMrr) * 100 : 0;
                                return (
                                    <div key={p.planId}>
                                        <div className="flex items-center justify-between mb-1.5">
                                            <span className="text-sm font-medium text-surface-800 dark:text-surface-200 truncate">
                                                {p.planName}
                                            </span>
                                            <span className="text-sm font-semibold text-surface-900 dark:text-surface-100">
                                                {formatCents(p.mrrCents)}
                                            </span>
                                        </div>
                                        <div className="h-2 w-full rounded-full bg-surface-100 dark:bg-surface-800 overflow-hidden">
                                            <div
                                                className="h-full bg-gradient-to-r from-primary-500 to-primary-600 transition-all"
                                                style={{ width: `${Math.min(100, pct).toFixed(1)}%` }}
                                            />
                                        </div>
                                        <div className="mt-1 flex items-center justify-between text-xs text-surface-500 dark:text-surface-400">
                                            <span>
                                                {formatNumber(p.subscribers)} subscriber{p.subscribers === 1 ? '' : 's'}
                                            </span>
                                            <span>{pct.toFixed(1)}%</span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                    <h2 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
                        Subscription status
                    </h2>
                    {revenue?.subscription_counts ? (
                        <div className="space-y-2.5 text-sm">
                            {Object.entries(revenue.subscription_counts).map(([status, count]) => (
                                <div
                                    key={status}
                                    className="flex items-center justify-between py-1.5 border-b border-surface-100 dark:border-surface-800/60 last:border-0"
                                >
                                    <span className="capitalize text-surface-600 dark:text-surface-400">
                                        {status.replace('_', ' ')}
                                    </span>
                                    <span className="font-semibold text-surface-900 dark:text-surface-100 tabular-nums">
                                        {formatNumber(count)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-sm text-surface-500 dark:text-surface-400">
                            No subscription data available.
                        </p>
                    )}
                </div>
            </div>

            {/* Per-plan revenue table */}
            <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-surface-200 dark:border-surface-700 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-surface-900 dark:text-surface-100">
                        Revenue by plan
                    </h2>
                    <span className="text-xs text-surface-500 dark:text-surface-400">
                        {planBreakdown.length} plan{planBreakdown.length === 1 ? '' : 's'} · {monthLabel}
                    </span>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-surface-50 dark:bg-surface-900/40 text-xs font-medium uppercase tracking-wider text-surface-500 dark:text-surface-400">
                            <tr>
                                <th className="text-left px-6 py-3">Plan</th>
                                <th className="text-right px-6 py-3">Subscribers</th>
                                <th className="text-right px-6 py-3">Monthly Revenue</th>
                                <th className="text-right px-6 py-3">Annualized</th>
                                <th className="text-right px-6 py-3">Share</th>
                            </tr>
                        </thead>
                        <tbody>
                            {planBreakdown.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="px-6 py-8 text-center text-surface-500 dark:text-surface-400">
                                        No subscription revenue recorded for {monthLabel}.
                                    </td>
                                </tr>
                            ) : (
                                planBreakdown.map((p) => {
                                    const pct = totalPlanMrr > 0 ? (p.mrrCents / totalPlanMrr) * 100 : 0;
                                    return (
                                        <tr key={p.planId} className="border-t border-surface-100 dark:border-surface-800/60">
                                            <td className="px-6 py-3 font-medium text-surface-900 dark:text-surface-100">
                                                {p.planName}
                                            </td>
                                            <td className="px-6 py-3 text-right tabular-nums text-surface-700 dark:text-surface-300">
                                                <span className="inline-flex items-center justify-end gap-2">
                                                    {formatNumber(p.subscribers)}
                                                    {p.subscribers > 0 && (
                                                        <button
                                                            onClick={() => setViewingPlan(p)}
                                                            title={`View subscribers for ${p.planName}`}
                                                            className="text-surface-400 hover:text-primary-500 dark:text-surface-500 dark:hover:text-primary-400 transition-colors"
                                                        >
                                                            <Eye size={14} />
                                                        </button>
                                                    )}
                                                </span>
                                            </td>
                                            <td className="px-6 py-3 text-right tabular-nums font-semibold text-surface-900 dark:text-surface-100">
                                                {formatCents(p.mrrCents)}
                                            </td>
                                            <td className="px-6 py-3 text-right tabular-nums text-surface-700 dark:text-surface-300">
                                                {formatCents(p.mrrCents * 12)}
                                            </td>
                                            <td className="px-6 py-3 text-right tabular-nums text-surface-700 dark:text-surface-300">
                                                {pct.toFixed(1)}%
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Subscriber list modal */}
            {viewingPlan && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
                    onClick={(e) => { if (e.target === e.currentTarget) setViewingPlan(null); }}
                >
                    <div
                        ref={modalRef}
                        className="bg-white dark:bg-surface-900 rounded-2xl shadow-xl border border-surface-200 dark:border-surface-700 w-full max-w-md flex flex-col max-h-[80vh]"
                    >
                        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-100 dark:border-surface-800">
                            <div>
                                <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">
                                    {viewingPlan.planName} subscribers
                                </h3>
                                <p className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
                                    {viewingPlan.subscribers} active · {monthLabel}
                                </p>
                            </div>
                            <button
                                onClick={() => setViewingPlan(null)}
                                className="text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 transition-colors"
                            >
                                <X size={16} />
                            </button>
                        </div>
                        <ul className="overflow-y-auto divide-y divide-surface-100 dark:divide-surface-800/60">
                            {viewingPlan.clients.map((c, idx) => (
                                <li
                                    key={`${c.clientId}-${idx}`}
                                    className="flex items-center gap-3 px-6 py-3 hover:bg-surface-50 dark:hover:bg-surface-800/40 transition-colors"
                                >
                                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary-500/30 to-purple-500/30 ring-1 ring-surface-200 dark:ring-surface-700 flex items-center justify-center text-[11px] font-semibold text-primary-600 dark:text-primary-300 shrink-0">
                                        {c.clientName.slice(0, 1).toUpperCase()}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-[13px] font-medium text-surface-900 dark:text-surface-100 truncate">
                                            {c.clientName}
                                        </p>
                                        {c.clientEmail && (
                                            <p className="text-[11px] text-surface-500 dark:text-surface-400 truncate">
                                                {c.clientEmail}
                                            </p>
                                        )}
                                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                            <span className="text-[11px] text-surface-400 dark:text-surface-500 capitalize">
                                                {c.billingCycle} billing
                                            </span>
                                            <PlanChangeBadge planChange={c.planChange} />
                                        </div>
                                    </div>
                                    <a
                                        href={`/superadmin/clients?id=${c.clientId}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        title="View client"
                                        className="text-surface-400 hover:text-primary-500 dark:hover:text-primary-400 transition-colors shrink-0"
                                    >
                                        <ExternalLink size={13} />
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            )}
        </div>
    );
}
