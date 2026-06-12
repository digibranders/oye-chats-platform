import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
    UserPlus, Sparkles, Loader2, ChevronRight, Mail, AlertCircle, CheckCircle2,
    MousePointerClick, Users as UsersIcon, TrendingUp, Search, Clock, X as XIcon,
    Trash2, Pencil,
} from 'lucide-react';
import {
    listSuperadminAffiliates,
    listSuperadminAffiliateInvites,
    revokeSuperadminAffiliateInvite,
    deleteSuperadminAffiliate,
} from '../../services/api';
import InviteAffiliateModal from '../../components/affiliate/InviteAffiliateModal';
import AffiliateDetailDrawer from '../../components/affiliate/AffiliateDetailDrawer';
import { cn } from '../../lib/utils';

export default function SuperadminAffiliates() {
    const [affiliates, setAffiliates] = useState([]);
    const [pendingInvites, setPendingInvites] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showInvite, setShowInvite] = useState(false);
    const [selectedId, setSelectedId] = useState(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [revokingId, setRevokingId] = useState(null);
    // Two-step inline confirm for the row-level Remove action so a stray
    // click can't deactivate an affiliate. ``confirmRemoveId`` holds the
    // affiliate id that's "armed" (first click); a second click within
    // the same render commits the change.
    const [confirmRemoveId, setConfirmRemoveId] = useState(null);
    const [removingId, setRemovingId] = useState(null);

    // Toast — same pattern as the existing super admin pages.
    const [toast, setToast] = useState(null);
    const toastTimer = useRef(null);
    const showToast = (type, message) => {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast({ type, message });
        toastTimer.current = setTimeout(() => setToast(null), 4000);
    };
    useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

    const fetchAffiliates = useCallback(async () => {
        setError(null);
        setIsLoading(true);
        try {
            // Both lists fetched in parallel — independent reads.
            // ``listSuperadminAffiliateInvites`` failure is non-fatal so we
            // settle each promise individually.
            const [affRes, invRes] = await Promise.allSettled([
                listSuperadminAffiliates(),
                listSuperadminAffiliateInvites(),
            ]);
            if (affRes.status === 'fulfilled') {
                setAffiliates(affRes.value);
            } else {
                throw affRes.reason;
            }
            if (invRes.status === 'fulfilled') {
                setPendingInvites(invRes.value);
            } else {
                // Invites are aux data — log but don't block.
                console.warn('Pending invites unavailable:', invRes.reason);
                setPendingInvites([]);
            }
        } catch (err) {
            setError(err);
            showToast('error', err.message || 'Failed to load affiliates');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => { fetchAffiliates(); }, [fetchAffiliates]);

    const handleRevokeInvite = async (invite) => {
        setRevokingId(invite.id);
        // Optimistic remove — re-insert on failure.
        const prev = pendingInvites;
        setPendingInvites((cur) => cur.filter((i) => i.id !== invite.id));
        try {
            await revokeSuperadminAffiliateInvite(invite.id);
            showToast('success', `Revoked invite for ${invite.email}.`);
        } catch (err) {
            setPendingInvites(prev);
            showToast('error', err?.message || 'Failed to revoke invite.');
        } finally {
            setRevokingId(null);
        }
    };

    const formatDate = (iso) =>
        iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

    /**
     * Hard-delete an affiliate from the row-level button.
     *
     * Permanent: removes the affiliate row, every code they own, and the
     * entire click history. Referred clients survive but lose their
     * ``referral_code_id``. No reactivation path — once deleted, gone.
     *
     * Optimistic UI: row drops from the table immediately on success.
     */
    const handleRemoveAffiliate = async (a) => {
        setRemovingId(a.id);
        setConfirmRemoveId(null);
        try {
            await deleteSuperadminAffiliate(a.id);
            setAffiliates((prev) => prev.filter((row) => row.id !== a.id));
            showToast(
                'success',
                `Removed ${a.client_email || `affiliate #${a.id}`} from the program.`,
            );
        } catch (err) {
            showToast('error', err?.message || 'Failed to remove affiliate.');
        } finally {
            setRemovingId(null);
        }
    };

    const filtered = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return affiliates;
        return affiliates.filter(
            (a) =>
                (a.client_email || '').toLowerCase().includes(q)
                || (a.client_name || '').toLowerCase().includes(q),
        );
    }, [affiliates, searchQuery]);

    const handleInvited = (response) => {
        // Backend returns a discriminated response:
        //   { kind: "instant",         affiliate: AffiliateRow }
        //   { kind: "pending_invite",  invite:    PendingInviteRow }
        // Update the right list optimistically, then trust the refetch to
        // reconcile authoritative stats.
        if (response?.kind === 'instant' && response.affiliate) {
            const aff = response.affiliate;
            setAffiliates((prev) => [aff, ...prev.filter((a) => a.id !== aff.id)]);
            showToast('success', `${aff.client_email} enrolled as an affiliate.`);
        } else if (response?.kind === 'pending_invite' && response.invite) {
            const inv = response.invite;
            setPendingInvites((prev) => [inv, ...prev.filter((i) => i.id !== inv.id)]);
            showToast(
                'success',
                `Magic-link invite sent to ${inv.email}. Pending until they accept.`,
            );
        }
    };

    const handleUpdated = (updated) => {
        setAffiliates((prev) => prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a)));
    };

    return (
        <div className="space-y-6 animate-fade-in">
            {/* Top toast */}
            {toast && (
                <div
                    className={cn(
                        'fixed top-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3 px-5 py-3 rounded-xl shadow-lg border',
                        toast.type === 'success'
                            ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
                            : 'bg-rose-50 dark:bg-rose-500/10 border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300',
                    )}
                >
                    {toast.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                    <span className="text-sm font-medium">{toast.message}</span>
                </div>
            )}

            {/* Page header */}
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-surface-900 dark:text-surface-50 tracking-tight">
                        Affiliates
                    </h1>
                    <p className="text-surface-500 dark:text-surface-400 mt-1 text-sm">
                        Invite hand-picked customers to run referral codes and track how each channel performs.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => setShowInvite(true)}
                    disabled={isLoading}
                    className="inline-flex items-center gap-2 px-4 h-10 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <UserPlus size={15} />
                    Invite affiliate
                </button>
            </div>

            {/* Program-wide stats */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <SeatCard
                    icon={<MousePointerClick size={14} />}
                    label="Total clicks"
                    value={affiliates.reduce((s, a) => s + (a.total_clicks || 0), 0).toLocaleString()}
                    hint="All affiliates · all-time"
                    tint="sky"
                />
                <SeatCard
                    icon={<UsersIcon size={14} />}
                    label="Total signups"
                    value={affiliates.reduce((s, a) => s + (a.total_signups || 0), 0).toLocaleString()}
                    hint="Referrals attributed"
                    tint="emerald"
                />
                <SeatCard
                    icon={<TrendingUp size={14} />}
                    label="Program conv."
                    value={(() => {
                        const c = affiliates.reduce((s, a) => s + (a.total_clicks || 0), 0);
                        const sg = affiliates.reduce((s, a) => s + (a.total_signups || 0), 0);
                        return c > 0 ? `${((sg / c) * 100).toFixed(1)}%` : '—';
                    })()}
                    hint="Signups ÷ clicks"
                    tint="amber"
                />
            </div>

            {/* Pending magic-link invites */}
            {pendingInvites.length > 0 && (
                <div className="bg-amber-50/60 dark:bg-amber-500/5 rounded-2xl border border-amber-200 dark:border-amber-500/20 overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-3 border-b border-amber-200/70 dark:border-amber-500/20">
                        <Clock size={14} className="text-amber-600 dark:text-amber-400" />
                        <p className="text-[13px] font-bold text-amber-700 dark:text-amber-300">
                            Pending invites ({pendingInvites.length})
                        </p>
                        <p className="text-[12px] text-amber-700/80 dark:text-amber-300/70 hidden sm:inline ml-2">
                            magic-link emails sent — waiting for the recipient to accept
                        </p>
                    </div>
                    <table className="w-full text-sm">
                        <tbody>
                            {pendingInvites.map((inv) => (
                                <tr key={inv.id} className="border-t border-amber-200/40 dark:border-amber-500/10">
                                    <td className="px-4 py-2.5">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <Mail size={12} className="text-amber-600 dark:text-amber-400 shrink-0" />
                                            <span className="font-mono text-[13px] text-surface-900 dark:text-surface-100 truncate">
                                                {inv.email}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="px-4 py-2.5 text-right text-[12px] text-surface-600 dark:text-surface-400 tabular-nums whitespace-nowrap">
                                        Sent {formatDate(inv.created_at)}
                                    </td>
                                    <td className="px-4 py-2.5 text-right text-[12px] text-surface-600 dark:text-surface-400 tabular-nums whitespace-nowrap">
                                        Expires {formatDate(inv.expires_at)}
                                    </td>
                                    <td className="px-4 py-2.5 text-right">
                                        <button
                                            type="button"
                                            onClick={() => handleRevokeInvite(inv)}
                                            disabled={revokingId === inv.id}
                                            title="Revoke this invite — the magic link will stop working immediately"
                                            className="inline-flex items-center gap-1.5 px-2.5 h-7 text-[11px] font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded-md transition-colors disabled:opacity-50"
                                        >
                                            {revokingId === inv.id ? <Loader2 size={11} className="animate-spin" /> : <XIcon size={11} />}
                                            Revoke
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Search */}
            {affiliates.length > 0 && (
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search by name or email…"
                        className="w-full pl-10 pr-4 h-10 text-sm bg-white dark:bg-surface-900 text-surface-900 dark:text-white border border-surface-200 dark:border-surface-700 rounded-xl outline-none focus:border-primary-400 placeholder:text-surface-400"
                    />
                </div>
            )}

            {/* Table / empty / error */}
            <div className="bg-white dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 overflow-hidden">
                {isLoading ? (
                    <div className="flex items-center justify-center py-16">
                        <Loader2 className="w-7 h-7 animate-spin text-primary-500" />
                    </div>
                ) : error ? (
                    <div className="p-8 text-center">
                        <AlertCircle size={20} className="mx-auto text-rose-500 mb-2" />
                        <p className="text-sm text-surface-700 dark:text-surface-200 font-medium">
                            Could not load affiliates.
                        </p>
                        <p className="text-[12px] text-surface-500 dark:text-surface-400 mt-1">{error.message}</p>
                    </div>
                ) : affiliates.length === 0 ? (
                    <div className="p-12 text-center">
                        <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center">
                            <UserPlus size={20} className="text-primary-500" />
                        </div>
                        <p className="text-sm font-medium text-surface-700 dark:text-surface-300">
                            No affiliates yet.
                        </p>
                        <p className="text-[12px] text-surface-500 dark:text-surface-400 mt-1 max-w-sm mx-auto">
                            Pick a hand-curated set of customers, invite them by email, and they&apos;ll
                            get access to the affiliate dashboard.
                        </p>
                        <button
                            type="button"
                            onClick={() => setShowInvite(true)}
                            className="mt-4 inline-flex items-center gap-2 px-4 h-9 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors"
                        >
                            <UserPlus size={14} />
                            Invite your first affiliate
                        </button>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="p-12 text-center text-sm text-surface-500 dark:text-surface-400">
                        No affiliates match your search.
                    </div>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-surface-100 dark:border-surface-800">
                                <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Affiliate</th>
                                <th className="text-center px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Codes</th>
                                <th className="text-center px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Comm%</th>
                                <th className="text-center px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Clicks</th>
                                <th className="text-center px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Signups</th>
                                <th className="text-center px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Conv%</th>
                                <th className="text-center px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-surface-500 dark:text-surface-400">Status</th>
                                <th className="px-4 py-3" />
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((a) => (
                                <motion.tr
                                    key={a.id}
                                    initial={{ opacity: 0, y: 4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.2 }}
                                    onClick={() => setSelectedId(a.id)}
                                    className={cn(
                                        'border-b border-surface-50 dark:border-surface-800 cursor-pointer transition-colors',
                                        a.active
                                            ? 'hover:bg-surface-50 dark:hover:bg-surface-800/50'
                                            : 'opacity-60 hover:bg-surface-50 dark:hover:bg-surface-800/50',
                                    )}
                                >
                                    <td className="px-4 py-3">
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="w-8 h-8 rounded-lg bg-primary-50 dark:bg-primary-500/15 flex items-center justify-center shrink-0">
                                                <Sparkles size={13} className="text-primary-600 dark:text-primary-400" />
                                            </div>
                                            <div className="min-w-0">
                                                <p className="font-medium text-surface-900 dark:text-surface-100 truncate">
                                                    {a.client_name || `Client #${a.client_id}`}
                                                </p>
                                                <p className="text-[11px] text-surface-500 dark:text-surface-400 flex items-center gap-1 truncate">
                                                    <Mail size={10} />
                                                    {a.client_email || '—'}
                                                </p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 text-center tabular-nums text-surface-900 dark:text-surface-100">
                                        {(a.active_codes || 0)}/{a.max_active_codes}
                                    </td>
                                    <td className="px-4 py-3 text-center tabular-nums">
                                        <span
                                            className={cn(
                                                (a.commission_pct || 0) > 0
                                                    ? 'font-medium text-surface-900 dark:text-surface-100'
                                                    : 'text-surface-400',
                                            )}
                                        >
                                            {(a.commission_pct || 0).toFixed(2)}%
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-center tabular-nums text-surface-900 dark:text-surface-100">
                                        {(a.total_clicks || 0).toLocaleString()}
                                    </td>
                                    <td className="px-4 py-3 text-center tabular-nums text-surface-900 dark:text-surface-100">
                                        {(a.total_signups || 0).toLocaleString()}
                                    </td>
                                    <td className="px-4 py-3 text-center tabular-nums">
                                        {a.conversion_pct != null ? (
                                            <span
                                                className={cn(
                                                    'font-medium',
                                                    a.conversion_pct >= 10
                                                        ? 'text-emerald-600 dark:text-emerald-400'
                                                        : a.conversion_pct >= 3
                                                            ? 'text-sky-600 dark:text-sky-400'
                                                            : 'text-surface-700 dark:text-surface-300',
                                                )}
                                            >
                                                {a.conversion_pct}%
                                            </span>
                                        ) : (
                                            <span className="text-surface-400">—</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-center">
                                        <span
                                            className={cn(
                                                'inline-block px-2 py-0.5 rounded-full text-[10px] font-bold',
                                                a.active
                                                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400'
                                                    : 'bg-surface-200 text-surface-600 dark:bg-surface-700 dark:text-surface-400',
                                            )}
                                        >
                                            {a.active ? 'Active' : 'Inactive'}
                                        </span>
                                    </td>
                                    <td
                                        className="px-4 py-3"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <div className="flex items-center justify-end gap-2">
                                            {confirmRemoveId === a.id ? (
                                                // Two-step confirm — first click arms the action,
                                                // second click commits. Guards against an accidental
                                                // destructive Remove on a stray mis-click.
                                                <div className="flex items-center gap-1">
                                                    <button
                                                        type="button"
                                                        onClick={() => handleRemoveAffiliate(a)}
                                                        disabled={removingId === a.id}
                                                        title="Permanently delete this affiliate + all their codes and click history."
                                                        className="inline-flex items-center gap-1 px-2.5 h-7 text-[11px] font-bold uppercase tracking-wider text-white bg-rose-600 hover:bg-rose-700 rounded-md transition-colors disabled:opacity-50"
                                                    >
                                                        {removingId === a.id ? (
                                                            <Loader2 size={11} className="animate-spin" />
                                                        ) : (
                                                            <Trash2 size={11} />
                                                        )}
                                                        Confirm delete
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setConfirmRemoveId(null)}
                                                        disabled={removingId === a.id}
                                                        className="px-2 h-7 text-[11px] font-medium text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-700 rounded-md transition-colors"
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            ) : (
                                                <>
                                                    <button
                                                        type="button"
                                                        onClick={() => setSelectedId(a.id)}
                                                        title="Edit commission, cap, and status"
                                                        aria-label={`Edit ${a.client_email || `affiliate #${a.id}`}`}
                                                        className="inline-flex items-center gap-1.5 px-2.5 h-7 text-[11px] font-medium text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800 rounded-md transition-colors"
                                                    >
                                                        <Pencil size={11} />
                                                        Edit
                                                    </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setConfirmRemoveId(a.id)}
                                                    title="Permanently remove from the program. Cannot be undone."
                                                    aria-label={`Remove ${a.client_email || `affiliate #${a.id}`}`}
                                                    className="inline-flex items-center gap-1.5 px-2.5 h-7 text-[11px] font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded-md transition-colors"
                                                >
                                                    <Trash2 size={11} />
                                                    Remove
                                                </button>
                                                </>
                                            )}
                                            <ChevronRight size={14} className="text-surface-400 dark:text-surface-500" />
                                        </div>
                                    </td>
                                </motion.tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            <InviteAffiliateModal
                open={showInvite}
                onClose={() => setShowInvite(false)}
                onInvited={(created) => {
                    handleInvited(created);
                    // Re-fetch to capture authoritative stats from the server.
                    setTimeout(() => fetchAffiliates(), 100);
                }}
            />

            <AffiliateDetailDrawer
                open={selectedId != null}
                affiliateId={selectedId}
                onClose={() => setSelectedId(null)}
                onUpdated={(updated) => {
                    handleUpdated(updated);
                    // Refetch so the table reflects cap / deactivation changes.
                    setTimeout(() => fetchAffiliates(), 100);
                }}
            />
        </div>
    );
}

// Card used in the 4-up stats row at the top of the page. Mirrors the
// shape of the affiliate-side StatCard but coloured for the super-admin view.
function SeatCard({ icon, label, value, hint, tint = 'primary' }) {
    const tints = {
        primary: 'bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400',
        sky: 'bg-sky-50 dark:bg-sky-500/10 text-sky-600 dark:text-sky-400',
        emerald: 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        amber: 'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400',
        rose: 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400',
    };
    return (
        <div className="bg-white dark:bg-surface-900 p-4 rounded-2xl border border-surface-200 dark:border-surface-800">
            <div className="flex items-center gap-2 mb-2">
                <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center', tints[tint])}>
                    {icon}
                </div>
                <p className="text-[12px] font-medium text-surface-500 dark:text-surface-400">{label}</p>
            </div>
            <p className="text-2xl font-bold text-surface-900 dark:text-surface-100 leading-none tabular-nums">
                {value}
            </p>
            {hint && <p className="text-[11px] text-surface-500 dark:text-surface-400 mt-1">{hint}</p>}
        </div>
    );
}
