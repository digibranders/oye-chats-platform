import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    X, Loader2, Users, AlertCircle, ShieldCheck,
    TrendingUp, Gift, Sparkles, Crown,
} from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * View-referrals modal — used by both the affiliate dashboard and the
 * super-admin affiliate drawer.
 *
 * The two contexts call different backend endpoints — the affiliate scope
 * returns masked emails and no platform commission; the super-admin scope
 * returns the unmasked PII plus the platform's revenue cut. The shape is
 * otherwise identical, so this component stays surface-agnostic: the
 * parent passes a ``fetcher`` function (a thunk that hits the right
 * endpoint) and an ``isSuperAdmin`` flag so the breakdown row for the
 * platform's slice is rendered iff appropriate.
 *
 * Closes on backdrop click, ESC, and the X button. Locks body scroll while
 * open — consistent with CreateCodeModal / EditCodeModal in this folder.
 */
export default function ReferralsModal({
    open,
    onClose,
    code,           // string — used as headline + fallback when fetch lags
    fetcher,        // () => Promise<{code, breakdown, referrals}>
    isSuperAdmin = false,
}) {
    // Single ``view`` object so the compiler-aware lint sees one setState
    // per cycle — splitting into data/loading/error tripped the
    // react-hooks/set-state-in-effect rule. Status is a small state machine
    // rather than a boolean so the UI can distinguish "never fetched" (idle)
    // from "actively loading" without juggling two booleans.
    const [view, setView] = useState({ status: 'idle', data: null, error: '' });

    // Reload whenever the modal opens for a different code. React Compiler's
    // ``set-state-in-effect`` rule flags the synchronous reset on line 1 of
    // the effect body — but this is the canonical async-fetch pattern: the
    // alternative (deriving "is loading" from cached query state) requires a
    // data layer this surface doesn't have. Suppressed locally rather than
    // file-wide so any unrelated effect that picks up this state is still
    // checked.
    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
        if (!open) return undefined;
        let cancelled = false;
        setView({ status: 'loading', data: null, error: '' });
        fetcher()
            .then((res) => {
                if (!cancelled) setView({ status: 'ready', data: res, error: '' });
            })
            .catch((err) => {
                if (!cancelled) {
                    setView({
                        status: 'error',
                        data: null,
                        error: err?.message || 'Failed to load referrals.',
                    });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [open, code, fetcher]);
    /* eslint-enable react-hooks/set-state-in-effect */

    const { status, data, error } = view;
    const loading = status === 'loading';

    useEffect(() => {
        if (!open) return undefined;
        const handler = (e) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open, onClose]);

    const referrals = data?.referrals || [];
    const breakdown = data?.breakdown || {};
    const headline = data?.code || code || '';

    return (
        <AnimatePresence>
            {open && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center p-4"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="referrals-modal-title"
                >
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="absolute inset-0 bg-black/40 dark:bg-black/60"
                        onClick={onClose}
                    />
                    <motion.div
                        initial={{ opacity: 0, y: 14, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 14, scale: 0.98 }}
                        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                        className="relative w-full max-w-2xl max-h-[88vh] bg-white dark:bg-surface-900 rounded-2xl shadow-2xl border border-surface-200 dark:border-surface-800 flex flex-col"
                    >
                        {/* Header */}
                        <div className="flex items-start justify-between p-5 border-b border-surface-200 dark:border-surface-800 shrink-0">
                            <div className="flex items-start gap-3 min-w-0">
                                <div className="w-9 h-9 rounded-xl bg-primary-50 dark:bg-primary-500/15 flex items-center justify-center shrink-0">
                                    <Users size={16} className="text-primary-600 dark:text-primary-400" />
                                </div>
                                <div className="min-w-0">
                                    <h2
                                        id="referrals-modal-title"
                                        className="text-[16px] font-bold text-surface-900 dark:text-surface-50 truncate"
                                    >
                                        Referrals for <code className="font-mono uppercase tracking-wider">{headline}</code>
                                    </h2>
                                    <p className="text-[12px] text-surface-500 dark:text-surface-400 mt-0.5">
                                        {isSuperAdmin
                                            ? 'Super-admin view — full PII and platform commission visible.'
                                            : 'Customers who signed up using this code. Emails are masked for privacy.'}
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={onClose}
                                aria-label="Close"
                                className="text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300 shrink-0"
                            >
                                <X size={18} />
                            </button>
                        </div>

                        {/* Body */}
                        <div className="flex-1 overflow-y-auto p-5 space-y-5">
                            {/* Commission breakdown */}
                            <section className="space-y-2">
                                <div className="flex items-center gap-1.5">
                                    <ShieldCheck size={13} className="text-surface-500 dark:text-surface-400" />
                                    <h3 className="text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">
                                        Commission breakdown
                                    </h3>
                                </div>
                                {loading && !data ? (
                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                        {Array.from({ length: isSuperAdmin ? 4 : 3 }).map((_, i) => (
                                            <div
                                                key={i}
                                                className="h-[68px] rounded-xl bg-surface-100 dark:bg-surface-800 animate-pulse"
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <div className={cn(
                                        'grid gap-2',
                                        isSuperAdmin ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3',
                                    )}>
                                        <BreakdownCard
                                            icon={<TrendingUp size={12} />}
                                            label="Affiliate"
                                            value={breakdown.affiliate_pct}
                                            tint="primary"
                                        />
                                        <BreakdownCard
                                            icon={<Gift size={12} />}
                                            label="Customer"
                                            value={breakdown.customer_discount_pct}
                                            tint="emerald"
                                        />
                                        {isSuperAdmin && (
                                            <BreakdownCard
                                                icon={<Crown size={12} />}
                                                label="Platform"
                                                value={breakdown.platform_pct}
                                                tint="amber"
                                            />
                                        )}
                                        <BreakdownCard
                                            icon={<Sparkles size={12} />}
                                            label="Pool"
                                            value={breakdown.pool_pct}
                                            hint={
                                                breakdown.code_unused_pool_pct > 0
                                                    ? `${breakdown.code_unused_pool_pct.toFixed(2)}% pool left in this code`
                                                    : 'Fully allocated'
                                            }
                                            tint="slate"
                                        />
                                    </div>
                                )}
                                <p className="text-[11px] text-surface-500 dark:text-surface-400 leading-relaxed">
                                    {isSuperAdmin ? (
                                        <>Of every dollar a referred customer pays, the affiliate keeps their share, the customer saves their discount, and the platform keeps the rest. Out-of-pool leeway is reserved for future code splits.</>
                                    ) : (
                                        <>Affiliate is your commission per qualifying payment. Customer is the discount applied at checkout. Pool is your overall ceiling set by the platform.</>
                                    )}
                                </p>
                            </section>

                            {/* Referrals list */}
                            <section className="space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="flex items-center gap-1.5">
                                        <Users size={13} className="text-surface-500 dark:text-surface-400" />
                                        <h3 className="text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">
                                            Signed-up customers
                                        </h3>
                                    </div>
                                    {!loading && !error && (
                                        <span className="text-[11px] tabular-nums text-surface-500 dark:text-surface-400">
                                            {referrals.length} total
                                        </span>
                                    )}
                                </div>

                                {loading && !data ? (
                                    <div className="space-y-2">
                                        {Array.from({ length: 3 }).map((_, i) => (
                                            <div
                                                key={i}
                                                className="h-12 rounded-lg bg-surface-100 dark:bg-surface-800 animate-pulse"
                                            />
                                        ))}
                                    </div>
                                ) : error ? (
                                    <div
                                        role="alert"
                                        className="flex items-start gap-2 px-3 py-3 rounded-lg bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300 text-[13px]"
                                    >
                                        <AlertCircle size={14} className="shrink-0 mt-0.5" />
                                        <span>{error}</span>
                                    </div>
                                ) : referrals.length === 0 ? (
                                    <div className="rounded-xl border border-dashed border-surface-200 dark:border-surface-700 px-4 py-8 text-center">
                                        <Users size={20} className="mx-auto mb-2 text-surface-400" />
                                        <p className="text-[13px] font-medium text-surface-700 dark:text-surface-300">
                                            No signups yet
                                        </p>
                                        <p className="text-[12px] text-surface-500 dark:text-surface-400 mt-1 max-w-sm mx-auto">
                                            Share the code <code className="font-mono uppercase tracking-wider">{headline}</code> wherever you reach customers — Twitter, LinkedIn, your newsletter — and signups will show here.
                                        </p>
                                    </div>
                                ) : (
                                    <ul className="rounded-xl border border-surface-200 dark:border-surface-700 divide-y divide-surface-100 dark:divide-surface-800 overflow-hidden">
                                        {referrals.map((r) => (
                                            <li
                                                key={r.client_id}
                                                className="flex items-center justify-between gap-3 px-4 py-3 bg-white dark:bg-surface-900"
                                            >
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <Avatar name={r.name || r.email} />
                                                    <div className="min-w-0">
                                                        <p className="text-[13px] font-semibold text-surface-900 dark:text-surface-50 truncate">
                                                            {r.name || 'Anonymous customer'}
                                                        </p>
                                                        <p className="text-[12px] text-surface-500 dark:text-surface-400 truncate font-mono">
                                                            {r.email}
                                                        </p>
                                                    </div>
                                                </div>
                                                <span className="text-[11px] text-surface-500 dark:text-surface-400 tabular-nums shrink-0">
                                                    {fmtDate(r.attributed_at)}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>
                        </div>

                        {/* Footer */}
                        <div className="px-5 py-3 border-t border-surface-200 dark:border-surface-800 shrink-0 flex justify-end">
                            <button
                                type="button"
                                onClick={onClose}
                                className="px-4 h-9 text-sm font-medium text-surface-700 dark:text-surface-300 bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg hover:bg-surface-50 dark:hover:bg-surface-700 transition-colors"
                            >
                                Close
                            </button>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
}

const TINTS = {
    primary: 'bg-primary-50 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300 border-primary-200/60 dark:border-primary-500/30',
    emerald: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-200/60 dark:border-emerald-500/30',
    amber:   'bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-200/60 dark:border-amber-500/30',
    slate:   'bg-surface-50 dark:bg-surface-800/60 text-surface-700 dark:text-surface-300 border-surface-200/60 dark:border-surface-700/60',
};

function BreakdownCard({ icon, label, value, hint, tint = 'slate' }) {
    const pct = value == null ? null : Number(value);
    return (
        <div className={cn('rounded-xl border px-3 py-2.5', TINTS[tint])}>
            <div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider opacity-80">
                {icon}
                <span>{label}</span>
            </div>
            <p className="mt-1 text-lg font-bold tabular-nums leading-none">
                {pct == null ? '—' : `${pct.toFixed(2)}%`}
            </p>
            {hint && (
                <p className="mt-0.5 text-[10px] opacity-70 truncate">{hint}</p>
            )}
        </div>
    );
}

/** Initials-circle, deterministic colour per name. */
function Avatar({ name }) {
    const display = (name || '?').trim();
    const initial = (display[0] || '?').toUpperCase();
    // Stable colour from name hash so the same customer keeps the same circle
    // across reloads — purely aesthetic.
    const palette = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899'];
    let hash = 0;
    for (let i = 0; i < display.length; i++) hash = (hash * 31 + display.charCodeAt(i)) | 0;
    const bg = palette[Math.abs(hash) % palette.length];
    return (
        <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[13px] font-bold shrink-0"
            style={{ backgroundColor: bg }}
            aria-hidden
        >
            {initial}
        </div>
    );
}

function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
