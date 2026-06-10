import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
    Sparkles, Plus, Loader2, Copy, Check, MousePointerClick, Users,
    TrendingUp, Link as LinkIcon, Power, RotateCcw, AlertCircle, Pencil,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import EmptyState from '../components/ui/EmptyState';
import { SkeletonTable } from '../components/ui/SkeletonLoader';
import CreateCodeModal from '../components/affiliate/CreateCodeModal';
import EditCodeModal from '../components/affiliate/EditCodeModal';
import {
    getAffiliateMe, getAffiliateCodes, getAffiliateStats, updateAffiliateCode,
} from '../services/api';
import { useToast } from '../context/ToastContext';
import { cn } from '../lib/utils';

const LANDING_ORIGIN = import.meta.env.VITE_LANDING_URL || 'https://oyechats.com';
const refLink = (code) => `${LANDING_ORIGIN.replace(/\/$/, '')}/?ref=${encodeURIComponent(code)}`;

/**
 * Per-stat card on the dashboard header. Compact, scannable, no icons-as-
 * decoration policy — every icon here actually anchors the metric.
 */
// Tint → icon-tile class lookup, hoisted out of StatCard so React doesn't
// re-create the object on every render.
const STAT_TINTS = {
    primary: 'bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400',
    sky: 'bg-sky-50 dark:bg-sky-500/10 text-sky-600 dark:text-sky-400',
    emerald: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    amber: 'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400',
};

// ``icon`` is a pre-rendered lucide element (e.g. ``<Sparkles size={14} />``)
// rather than the component constructor. That sidesteps the project's
// ``no-unused-vars`` lint rule which doesn't track JSX usage of destructured
// props, AND keeps the StatCard reusable for any icon library / inline SVG.
function StatCard({ icon, label, value, hint, tint = 'primary' }) {
    return (
        <div className="bg-white dark:bg-surface-900 p-4 rounded-2xl border border-surface-200 dark:border-surface-800">
            <div className="flex items-center gap-2 mb-2">
                <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center', STAT_TINTS[tint])}>
                    {icon}
                </div>
                <p className="text-[12px] font-medium text-surface-500 dark:text-surface-400">{label}</p>
            </div>
            <p className="text-2xl font-bold text-surface-900 dark:text-surface-100 leading-none">{value}</p>
            {hint && <p className="text-[11px] text-surface-500 dark:text-surface-400 mt-1">{hint}</p>}
        </div>
    );
}

/** Tiny copy-to-clipboard button used in the code rows. */
function CopyLinkButton({ code }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = async () => {
        const url = refLink(code);
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard API may be blocked over non-https; fall back to a
            // tiny synthetic textarea + execCommand path.
            const ta = document.createElement('textarea');
            ta.value = url;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try {
                document.execCommand('copy');
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            } catch {
                /* swallow */
            }
            document.body.removeChild(ta);
        }
    };
    return (
        <button
            type="button"
            onClick={handleCopy}
            title="Copy referral link"
            aria-label="Copy referral link"
            className="inline-flex items-center gap-1 px-2 h-7 text-[11px] font-medium text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800 rounded-md transition-colors"
        >
            {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy link'}
        </button>
    );
}

export default function AffiliateDashboard() {
    const { showToast } = useToast();
    const [me, setMe] = useState(null);
    const [codes, setCodes] = useState([]);
    const [stats, setStats] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showCreate, setShowCreate] = useState(false);
    const [togglingId, setTogglingId] = useState(null);
    // The currently-being-edited code (null when the edit modal is closed).
    // We keep the full row, not just an id, so the modal can seed its form
    // synchronously without a re-fetch flash.
    const [editingCode, setEditingCode] = useState(null);

    const fetchAll = useCallback(async () => {
        setError(null);
        try {
            // Three reads in parallel — small payloads, fast first paint.
            const [meRes, codesRes, statsRes] = await Promise.all([
                getAffiliateMe(),
                getAffiliateCodes(),
                getAffiliateStats(),
            ]);
            setMe(meRes);
            setCodes(codesRes);
            setStats(statsRes);
        } catch (err) {
            // 403 = not enrolled. Surface a dedicated empty state rather than
            // a generic error toast so the user understands why they can't
            // see anything.
            setError(err);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchAll();
    }, [fetchAll]);

    const handleCreated = (created) => {
        // Prepend the new code so it surfaces above older ones. The codes
        // table is sorted by active-then-created at the API, but locally
        // we just prepend; a subsequent refetch will re-sort properly.
        setCodes((prev) => [created, ...prev]);
        // Re-fetch stats so the "active codes" tile reflects the new total.
        getAffiliateStats().then(setStats).catch(() => {});
        showToast?.('success', `Code ${created.code} created.`);
    };

    const handleToggleActive = async (code) => {
        const nextActive = !code.active;
        setTogglingId(code.id);
        try {
            const updated = await updateAffiliateCode(code.id, { active: nextActive });
            setCodes((prev) => prev.map((c) => (c.id === code.id ? updated : c)));
            // Stats include active_codes — refresh.
            getAffiliateStats().then(setStats).catch(() => {});
            showToast?.(
                'success',
                nextActive ? `Reactivated ${code.code}.` : `Deactivated ${code.code}.`,
            );
        } catch (err) {
            showToast?.('error', err?.message || 'Failed to update code.');
        } finally {
            setTogglingId(null);
        }
    };

    const activeCount = useMemo(() => codes.filter((c) => c.active).length, [codes]);
    const maxCodes = me?.max_active_codes ?? stats?.max_active_codes ?? 10;
    const atCap = activeCount >= maxCodes;
    // Pool the super-admin granted this affiliate. Passed into both modals
    // so create/edit can validate split totals client-side without an
    // extra round-trip.
    const poolPct = me?.commission_pct ?? 0;

    // ── Render — error / loading / empty / table ────────────────────────

    if (!isLoading && error?.status === 403) {
        return (
            <EmptyState
                title="Affiliate program"
                description="You're not enrolled in the OyeChats affiliate program. Contact your account manager if you'd like an invite."
            />
        );
    }

    return (
        <div className="space-y-6 animate-fade-in pb-12">
            <PageHeader
                title="Affiliate Program"
                subtitle="Create referral codes, share them anywhere, and track every signup they bring in."
            >
                {/* Pool chip — surfaces the commission % the super-admin
                    granted this affiliate. It's the ceiling each code's
                    (my-commission + friend-reward) must split within. */}
                {!isLoading && !error && (
                    <div
                        className="inline-flex items-center gap-2 px-3 h-10 rounded-xl bg-primary-50 dark:bg-primary-500/10 border border-primary-200 dark:border-primary-500/30 text-primary-700 dark:text-primary-300"
                        title="Set by your account manager. Each code splits within this pool."
                    >
                        <TrendingUp size={14} />
                        <span className="text-[12px] font-semibold tabular-nums">
                            Pool: {poolPct.toFixed(2)}%
                        </span>
                    </div>
                )}
                <button
                    type="button"
                    onClick={() => setShowCreate(true)}
                    disabled={isLoading || !!error || atCap}
                    title={atCap ? `You're at the ${maxCodes}-code limit. Deactivate one to create another.` : undefined}
                    className="inline-flex items-center gap-2 px-4 h-10 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <Plus size={15} />
                    Create code
                </button>
            </PageHeader>

            {/* Stats row */}
            {isLoading ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[0, 1, 2, 3].map((i) => (
                        <div
                            key={i}
                            className="h-[88px] rounded-2xl bg-surface-100 dark:bg-surface-800 animate-pulse"
                        />
                    ))}
                </div>
            ) : error ? (
                <div className="flex items-start gap-3 p-4 rounded-xl bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300">
                    <AlertCircle size={16} className="shrink-0 mt-0.5" />
                    <div>
                        <p className="text-sm font-medium">Could not load your affiliate dashboard.</p>
                        <p className="text-[12px] mt-1 opacity-80">{error.message}</p>
                    </div>
                </div>
            ) : (
                <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3 }}
                    className="grid grid-cols-2 md:grid-cols-4 gap-3"
                >
                    <StatCard
                        icon={<Sparkles size={14} />}
                        label="Active codes"
                        value={`${activeCount}/${maxCodes}`}
                        hint={atCap ? 'At cap — deactivate one to make room' : `${maxCodes - activeCount} slots free`}
                        tint="primary"
                    />
                    <StatCard
                        icon={<MousePointerClick size={14} />}
                        label="Total clicks"
                        value={(stats?.total_clicks ?? 0).toLocaleString()}
                        hint="All-time across every code"
                        tint="sky"
                    />
                    <StatCard
                        icon={<Users size={14} />}
                        label="Signups"
                        value={(stats?.total_signups ?? 0).toLocaleString()}
                        hint="Visitors who used your code"
                        tint="emerald"
                    />
                    <StatCard
                        icon={<TrendingUp size={14} />}
                        label="Conversion"
                        value={stats?.conversion_pct != null ? `${stats.conversion_pct}%` : '—'}
                        hint={stats?.total_clicks ? 'Signups ÷ clicks' : 'No clicks yet'}
                        tint="amber"
                    />
                </motion.div>
            )}

            {/* Codes table */}
            <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 overflow-hidden">
                {isLoading ? (
                    <SkeletonTable rows={5} cols={7} />
                ) : codes.length === 0 ? (
                    <div className="p-12 text-center text-surface-500 dark:text-surface-400">
                        <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center">
                            <LinkIcon size={20} className="text-primary-500" />
                        </div>
                        <p className="text-sm font-medium text-surface-700 dark:text-surface-300">
                            You haven&apos;t created any codes yet.
                        </p>
                        <p className="text-[12px] mt-1 max-w-sm mx-auto">
                            Create your first code and share it anywhere — Twitter, LinkedIn, newsletter, DMs.
                            We track clicks and signups for each one separately.
                        </p>
                        <button
                            type="button"
                            onClick={() => setShowCreate(true)}
                            className="mt-4 inline-flex items-center gap-2 px-4 h-9 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors"
                        >
                            <Plus size={14} />
                            Create your first code
                        </button>
                    </div>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-surface-100 dark:border-surface-800">
                                <th className="text-center px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Code</th>
                                <th className="text-center px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">My Comm</th>
                                <th className="text-center px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Reward</th>
                                <th className="text-center px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Clicks</th>
                                <th className="text-center px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Signups</th>
                                <th className="text-center px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Conv %</th>
                                <th className="px-4 py-3" />
                            </tr>
                        </thead>
                        <tbody>
                            {codes.map((c) => (
                                <tr
                                    key={c.id}
                                    className={cn(
                                        'border-b border-surface-50 dark:border-surface-800 transition-colors',
                                        c.active ? 'hover:bg-surface-50 dark:hover:bg-surface-800/50' : 'opacity-60',
                                    )}
                                >
                                    <td className="px-4 py-3 text-center">
                                        <div className="flex items-center justify-center gap-2">
                                            <code className="text-[13px] font-mono font-semibold uppercase tracking-wider text-surface-900 dark:text-surface-100">
                                                {c.code}
                                            </code>
                                            {!c.active && (
                                                <span className="px-1.5 py-0.5 text-[10px] font-bold uppercase rounded bg-surface-200 dark:bg-surface-700 text-surface-600 dark:text-surface-400">
                                                    Inactive
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex justify-center">
                                            <CopyLinkButton code={c.code} />
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 text-center tabular-nums">
                                        <span
                                            className={cn(
                                                (c.affiliate_commission_pct || 0) > 0
                                                    ? 'font-medium text-surface-900 dark:text-surface-100'
                                                    : 'text-surface-400',
                                            )}
                                        >
                                            {(c.affiliate_commission_pct || 0).toFixed(2)}%
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-center tabular-nums">
                                        <span
                                            className={cn(
                                                (c.customer_discount_pct || 0) > 0
                                                    ? 'font-medium text-surface-900 dark:text-surface-100'
                                                    : 'text-surface-400',
                                            )}
                                        >
                                            {(c.customer_discount_pct || 0).toFixed(2)}%
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-center tabular-nums text-surface-900 dark:text-surface-100">
                                        {c.clicks.toLocaleString()}
                                    </td>
                                    <td className="px-4 py-3 text-center tabular-nums text-surface-900 dark:text-surface-100">
                                        {c.signups.toLocaleString()}
                                    </td>
                                    <td className="px-4 py-3 text-center tabular-nums">
                                        {c.conversion_pct != null ? (
                                            <span
                                                className={cn(
                                                    'font-medium',
                                                    c.conversion_pct >= 10
                                                        ? 'text-emerald-600 dark:text-emerald-400'
                                                        : c.conversion_pct >= 3
                                                            ? 'text-sky-600 dark:text-sky-400'
                                                            : 'text-surface-700 dark:text-surface-300',
                                                )}
                                            >
                                                {c.conversion_pct}%
                                            </span>
                                        ) : (
                                            <span className="text-surface-400">—</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3">
                                        <div className="flex items-center justify-end gap-1">
                                            <button
                                                type="button"
                                                onClick={() => setEditingCode(c)}
                                                title="Edit code or label"
                                                aria-label={`Edit ${c.code}`}
                                                className="inline-flex items-center gap-1.5 px-2.5 h-8 text-[12px] font-medium rounded-lg text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                                            >
                                                <Pencil size={12} />
                                                Edit
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleToggleActive(c)}
                                                disabled={togglingId === c.id || (!c.active && atCap)}
                                                title={
                                                    !c.active && atCap
                                                        ? `At cap (${maxCodes}). Deactivate another code first.`
                                                        : c.active
                                                            ? 'Deactivate (no new signups via this code)'
                                                            : 'Reactivate'
                                                }
                                                className={cn(
                                                    'inline-flex items-center gap-1.5 px-2.5 h-8 text-[12px] font-medium rounded-lg transition-colors',
                                                    c.active
                                                        ? 'text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10'
                                                        : 'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10',
                                                    'disabled:opacity-40 disabled:cursor-not-allowed',
                                                )}
                                            >
                                                {togglingId === c.id ? (
                                                    <Loader2 size={12} className="animate-spin" />
                                                ) : c.active ? (
                                                    <Power size={12} />
                                                ) : (
                                                    <RotateCcw size={12} />
                                                )}
                                                {c.active ? 'Deactivate' : 'Reactivate'}
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            <CreateCodeModal
                open={showCreate}
                onClose={() => setShowCreate(false)}
                onCreated={handleCreated}
                poolPct={poolPct}
            />

            <EditCodeModal
                open={editingCode != null}
                code={editingCode}
                onClose={() => setEditingCode(null)}
                onUpdated={(updated) => {
                    setCodes((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
                    showToast?.('success', `Updated ${updated.code}.`);
                }}
                poolPct={poolPct}
            />
        </div>
    );
}
