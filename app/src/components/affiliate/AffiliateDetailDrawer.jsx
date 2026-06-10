import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    X, Loader2, MousePointerClick, Users as UsersIcon, TrendingUp, Sparkles,
    Mail, Calendar, Save, Power, RotateCcw, AlertCircle, Eye,
} from 'lucide-react';
import {
    getSuperadminAffiliateDetail, updateSuperadminAffiliate,
    getSuperadminCodeReferrals,
} from '../../services/api';
import { cn } from '../../lib/utils';
import ReferralsModal from './ReferralsModal';

/**
 * Side drawer that drills into a single affiliate from the super-admin
 * list. Renders meta + codes + stats, and lets the super admin override
 * the cap or toggle the affiliate's active status.
 *
 * Fetches detail lazily — only when the drawer opens — so the list page
 * doesn't pay the per-affiliate code-stats cost upfront.
 */
export default function AffiliateDetailDrawer({ affiliateId, open, onClose, onUpdated }) {
    const [detail, setDetail] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    const [maxCodesInput, setMaxCodesInput] = useState('');
    const [commissionInput, setCommissionInput] = useState('');
    const [isSavingCap, setIsSavingCap] = useState(false);
    const [isSavingCommission, setIsSavingCommission] = useState(false);
    const [isTogglingActive, setIsTogglingActive] = useState(false);
    const [actionError, setActionError] = useState(null);
    // Code currently being inspected for referrals — null when closed. Stored
    // as the full row so the modal can render the code string while loading.
    const [viewingCode, setViewingCode] = useState(null);

    // Stable fetcher per open-code. See AffiliateDashboard's comment for why
    // this needs useCallback (ReferralsModal lists it in its effect deps).
    const viewingFetcher = useCallback(
        () => (
            viewingCode && affiliateId
                ? getSuperadminCodeReferrals(affiliateId, viewingCode.id)
                : Promise.resolve(null)
        ),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [affiliateId, viewingCode?.id],
    );

    useEffect(() => {
        if (!open || !affiliateId) return undefined;
        let cancelled = false;
        setIsLoading(true);
        setError(null);
        setActionError(null);
        getSuperadminAffiliateDetail(affiliateId)
            .then((d) => {
                if (cancelled) return;
                setDetail(d);
                setMaxCodesInput(String(d?.max_active_codes ?? ''));
                setCommissionInput(
                    d?.commission_pct != null ? String(d.commission_pct) : '0',
                );
            })
            .catch((err) => { if (!cancelled) setError(err); })
            .finally(() => { if (!cancelled) setIsLoading(false); });
        return () => { cancelled = true; };
    }, [open, affiliateId]);

    const handleSaveCap = async () => {
        const parsed = Number(maxCodesInput);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 100) {
            setActionError('Max active codes must be an integer between 1 and 100.');
            return;
        }
        if (parsed === detail?.max_active_codes) return; // no-op

        setActionError(null);
        setIsSavingCap(true);
        try {
            const updated = await updateSuperadminAffiliate(affiliateId, { maxActiveCodes: parsed });
            setDetail((prev) => ({ ...prev, max_active_codes: updated.max_active_codes }));
            onUpdated?.(updated);
        } catch (err) {
            setActionError(err?.message || 'Failed to update cap.');
        } finally {
            setIsSavingCap(false);
        }
    };

    /**
     * Persist a new commission %. The backend stores basis points; we send
     * whole percent (UI-friendly) and let the route convert. Empty input
     * resolves to 0 — "no commission" rather than "leave unchanged" — to
     * match the create-flow semantic where unset = 0.
     */
    const handleSaveCommission = async () => {
        const raw = commissionInput.trim();
        const parsed = raw === '' ? 0 : Number(raw);
        if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
            setActionError('Commission must be a number between 0 and 100.');
            return;
        }
        if (parsed === (detail?.commission_pct ?? 0)) return; // no-op

        setActionError(null);
        setIsSavingCommission(true);
        try {
            const updated = await updateSuperadminAffiliate(affiliateId, { commissionPct: parsed });
            setDetail((prev) => ({
                ...prev,
                commission_pct: updated.commission_pct,
                commission_bps: updated.commission_bps,
            }));
            onUpdated?.(updated);
        } catch (err) {
            setActionError(err?.message || 'Failed to update commission.');
        } finally {
            setIsSavingCommission(false);
        }
    };

    const handleToggleActive = async () => {
        if (!detail) return;
        const nextActive = !detail.active;
        setActionError(null);
        setIsTogglingActive(true);
        try {
            const updated = await updateSuperadminAffiliate(affiliateId, { active: nextActive });
            setDetail((prev) => ({
                ...prev,
                active: updated.active,
                deactivated_at: updated.deactivated_at,
            }));
            onUpdated?.(updated);
        } catch (err) {
            setActionError(err?.message || 'Failed to toggle active status.');
        } finally {
            setIsTogglingActive(false);
        }
    };

    const formatDate = (iso) =>
        iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

    return (
        <AnimatePresence>
            {open && (
                <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="absolute inset-0 bg-black/30 dark:bg-black/60"
                    />
                    <motion.div
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ type: 'spring', damping: 32, stiffness: 320 }}
                        className="relative w-full max-w-xl bg-white dark:bg-surface-900 shadow-2xl flex flex-col"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="sticky top-0 z-10 bg-white dark:bg-surface-900 border-b border-surface-200 dark:border-surface-800 px-6 py-4 flex items-center justify-between">
                            <h2 className="text-lg font-bold text-surface-900 dark:text-surface-100">Affiliate detail</h2>
                            <button
                                onClick={onClose}
                                aria-label="Close"
                                className="text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300"
                            >
                                <X size={18} />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto">
                            {isLoading ? (
                                <div className="flex items-center justify-center py-20">
                                    <Loader2 className="w-7 h-7 animate-spin text-primary-500" />
                                </div>
                            ) : error ? (
                                <div className="m-6 flex items-start gap-3 p-4 rounded-xl bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300">
                                    <AlertCircle size={16} className="shrink-0 mt-0.5" />
                                    <div>
                                        <p className="text-sm font-medium">Could not load affiliate.</p>
                                        <p className="text-[12px] mt-1 opacity-80">{error.message}</p>
                                    </div>
                                </div>
                            ) : detail ? (
                                <div className="p-6 space-y-6">
                                    {/* Meta */}
                                    <div className="space-y-3">
                                        <div className="flex items-center gap-3">
                                            <div className="w-11 h-11 rounded-xl bg-primary-50 dark:bg-primary-500/15 flex items-center justify-center">
                                                <Sparkles size={18} className="text-primary-600 dark:text-primary-400" />
                                            </div>
                                            <div className="min-w-0">
                                                <p className="font-semibold text-surface-900 dark:text-surface-100 truncate">
                                                    {detail.client_name || `Client #${detail.client_id}`}
                                                </p>
                                                <p className="text-[12px] text-surface-500 dark:text-surface-400 flex items-center gap-1">
                                                    <Mail size={11} />
                                                    {detail.client_email || '—'}
                                                </p>
                                            </div>
                                            <span
                                                className={cn(
                                                    'ml-auto px-2.5 py-1 rounded-full text-[11px] font-bold',
                                                    detail.active
                                                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400'
                                                        : 'bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-400',
                                                )}
                                            >
                                                {detail.active ? 'Active' : 'Deactivated'}
                                            </span>
                                        </div>
                                        <div className="flex flex-wrap gap-4 text-[12px] text-surface-500 dark:text-surface-400">
                                            <span className="flex items-center gap-1">
                                                <Calendar size={11} />
                                                Joined {formatDate(detail.created_at)}
                                            </span>
                                            {detail.deactivated_at && (
                                                <span className="flex items-center gap-1 text-rose-500">
                                                    <Calendar size={11} />
                                                    Deactivated {formatDate(detail.deactivated_at)}
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    {/* Stats */}
                                    <div className="grid grid-cols-3 gap-2">
                                        <StatBlock
                                            icon={<MousePointerClick size={13} className="text-sky-600 dark:text-sky-400" />}
                                            label="Clicks"
                                            value={(detail.stats?.total_clicks ?? 0).toLocaleString()}
                                        />
                                        <StatBlock
                                            icon={<UsersIcon size={13} className="text-emerald-600 dark:text-emerald-400" />}
                                            label="Signups"
                                            value={(detail.stats?.total_signups ?? 0).toLocaleString()}
                                        />
                                        <StatBlock
                                            icon={<TrendingUp size={13} className="text-amber-600 dark:text-amber-400" />}
                                            label="Conversion"
                                            value={detail.stats?.conversion_pct != null ? `${detail.stats.conversion_pct}%` : '—'}
                                        />
                                    </div>

                                    {/* Overrides */}
                                    <div className="bg-surface-50 dark:bg-surface-800/40 rounded-xl border border-surface-200 dark:border-surface-700 p-4 space-y-3">
                                        <h3 className="text-[13px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">
                                            Overrides
                                        </h3>

                                        <div className="space-y-1.5">
                                            <label className="text-[12px] font-medium text-surface-700 dark:text-surface-300">
                                                Max active codes
                                            </label>
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="number"
                                                    min="1"
                                                    max="100"
                                                    value={maxCodesInput}
                                                    onChange={(e) => setMaxCodesInput(e.target.value)}
                                                    className="flex-1 h-9 px-3 text-sm bg-white dark:bg-surface-900 text-surface-900 dark:text-white border border-surface-200 dark:border-surface-700 rounded-lg outline-none focus:border-primary-400"
                                                    disabled={isSavingCap || !detail.active}
                                                />
                                                <button
                                                    type="button"
                                                    onClick={handleSaveCap}
                                                    disabled={
                                                        isSavingCap
                                                        || !detail.active
                                                        || Number(maxCodesInput) === detail.max_active_codes
                                                    }
                                                    className="inline-flex items-center gap-1.5 px-3 h-9 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                                >
                                                    {isSavingCap ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                                                    Save
                                                </button>
                                            </div>
                                        </div>

                                        {/* Commission % — super-admin sets the percent this affiliate
                                            earns. 0 = no payout (default for v1's money-free path). */}
                                        <div className="space-y-1.5">
                                            <label className="text-[12px] font-medium text-surface-700 dark:text-surface-300">
                                                Commission %
                                            </label>
                                            <div className="flex items-center gap-2">
                                                <div className="relative flex-1">
                                                    <input
                                                        type="number"
                                                        min="0"
                                                        max="100"
                                                        step="0.01"
                                                        value={commissionInput}
                                                        onChange={(e) => setCommissionInput(e.target.value)}
                                                        placeholder="0"
                                                        className="w-full h-9 pl-3 pr-8 text-sm bg-white dark:bg-surface-900 text-surface-900 dark:text-white border border-surface-200 dark:border-surface-700 rounded-lg outline-none focus:border-primary-400"
                                                        disabled={isSavingCommission || !detail.active}
                                                    />
                                                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-surface-400 pointer-events-none">%</span>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={handleSaveCommission}
                                                    disabled={
                                                        isSavingCommission
                                                        || !detail.active
                                                        || Number(commissionInput || 0) === (detail.commission_pct ?? 0)
                                                    }
                                                    className="inline-flex items-center gap-1.5 px-3 h-9 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                                >
                                                    {isSavingCommission ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                                                    Save
                                                </button>
                                            </div>
                                            <p className="text-[11px] text-surface-400">
                                                What this affiliate earns per qualifying signup (0–100).
                                            </p>
                                            {!detail.active && (
                                                <p className="text-[11px] text-surface-400">
                                                    Reactivate the affiliate first to change their cap.
                                                </p>
                                            )}
                                        </div>

                                        <div className="pt-2 border-t border-surface-200 dark:border-surface-700">
                                            <button
                                                type="button"
                                                onClick={handleToggleActive}
                                                disabled={isTogglingActive}
                                                className={cn(
                                                    'inline-flex items-center gap-2 px-3 h-9 text-sm font-medium rounded-lg transition-colors disabled:opacity-50',
                                                    detail.active
                                                        ? 'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-500/10 hover:bg-rose-100 dark:hover:bg-rose-500/20 border border-rose-200 dark:border-rose-500/30'
                                                        : 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 border border-emerald-200 dark:border-emerald-500/30',
                                                )}
                                            >
                                                {isTogglingActive ? (
                                                    <Loader2 size={13} className="animate-spin" />
                                                ) : detail.active ? (
                                                    <Power size={13} />
                                                ) : (
                                                    <RotateCcw size={13} />
                                                )}
                                                {detail.active ? 'Deactivate affiliate' : 'Reactivate affiliate'}
                                            </button>
                                            <p className="text-[11px] text-surface-500 dark:text-surface-400 mt-1.5">
                                                {detail.active
                                                    ? 'Deactivating an affiliate also deactivates every code they own. Existing referred customers keep their attribution.'
                                                    : 'Reactivation only re-enables the affiliate — they must manually re-activate any codes they want to keep using.'}
                                            </p>
                                        </div>

                                        {actionError && (
                                            <div
                                                role="alert"
                                                className="flex items-start gap-2 px-3 py-2 rounded-lg bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300 text-[12px]"
                                            >
                                                <AlertCircle size={12} className="shrink-0 mt-0.5" />
                                                <span>{actionError}</span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Codes */}
                                    <div>
                                        <h3 className="text-[13px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400 mb-2">
                                            Codes ({detail.codes?.length || 0})
                                        </h3>
                                        {detail.codes?.length ? (
                                            <div className="rounded-xl border border-surface-200 dark:border-surface-800 overflow-hidden">
                                                <table className="w-full text-sm">
                                                    <thead className="bg-surface-50 dark:bg-surface-800/40">
                                                        <tr>
                                                            <th className="text-left px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Code</th>
                                                            <th className="text-right px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Clicks</th>
                                                            <th className="text-right px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Signups</th>
                                                            <th className="text-right px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Conv%</th>
                                                            <th className="px-3 py-2" aria-label="Actions" />
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {detail.codes.map((c) => (
                                                            <tr key={c.id} className={cn('border-t border-surface-100 dark:border-surface-800', !c.active && 'opacity-60')}>
                                                                <td className="px-3 py-2">
                                                                    <div className="flex items-center gap-2">
                                                                        <code className="text-[12px] font-mono font-semibold uppercase text-surface-900 dark:text-surface-100">
                                                                            {c.code}
                                                                        </code>
                                                                        {!c.active && (
                                                                            <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-surface-200 dark:bg-surface-700 text-surface-600 dark:text-surface-400">
                                                                                Inactive
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                    {c.label && (
                                                                        <p className="text-[11px] text-surface-500 dark:text-surface-400 truncate max-w-[220px]">
                                                                            {c.label}
                                                                        </p>
                                                                    )}
                                                                </td>
                                                                <td className="px-3 py-2 text-right tabular-nums text-surface-900 dark:text-surface-100">
                                                                    {c.clicks.toLocaleString()}
                                                                </td>
                                                                <td className="px-3 py-2 text-right tabular-nums text-surface-900 dark:text-surface-100">
                                                                    {c.signups.toLocaleString()}
                                                                </td>
                                                                <td className="px-3 py-2 text-right tabular-nums text-surface-700 dark:text-surface-300">
                                                                    {c.conversion_pct != null ? `${c.conversion_pct}%` : '—'}
                                                                </td>
                                                                <td className="px-3 py-2 text-right">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => setViewingCode(c)}
                                                                        title="View signups, PII, and platform commission"
                                                                        aria-label={`View referrals for ${c.code}`}
                                                                        className="inline-flex items-center gap-1 px-2 h-7 text-[11px] font-medium rounded-md text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700 transition-colors"
                                                                    >
                                                                        <Eye size={11} />
                                                                        View
                                                                    </button>
                                                                </td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        ) : (
                                            <p className="text-[12px] text-surface-500 dark:text-surface-400 italic">
                                                No codes created yet.
                                            </p>
                                        )}
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    </motion.div>

                    {/* Referrals modal — nested inside the drawer's portal so
                        it stacks above the drawer overlay and closing it
                        doesn't dismiss the drawer itself. */}
                    <ReferralsModal
                        open={viewingCode != null}
                        onClose={() => setViewingCode(null)}
                        code={viewingCode?.code}
                        fetcher={viewingFetcher}
                        isSuperAdmin
                    />
                </div>
            )}
        </AnimatePresence>
    );
}

// Internal — single stat block in the 3-up row near the top of the drawer.
function StatBlock({ icon, label, value }) {
    return (
        <div className="bg-surface-50 dark:bg-surface-800/40 rounded-lg border border-surface-200 dark:border-surface-700 p-3">
            <div className="flex items-center gap-1.5 mb-1">
                {icon}
                <p className="text-[10px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">
                    {label}
                </p>
            </div>
            <p className="text-lg font-bold tabular-nums text-surface-900 dark:text-surface-100">{value}</p>
        </div>
    );
}
