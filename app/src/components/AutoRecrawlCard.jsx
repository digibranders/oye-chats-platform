import { useCallback, useEffect, useState } from 'react';
import { formatDate, formatTime } from '../i18n/formatters';
import {
    RefreshCw,
    CalendarClock,
    CheckCircle2,
    AlertCircle,
    Loader2,
} from 'lucide-react';
import { getRecrawlStatus, updateRecrawl } from '../services/api';
import useEntitlements from '../hooks/useEntitlements';
import { useUpgradeModal } from '../context/UpgradeModalContext';
import { cn } from '../lib/utils';

/**
 * AutoRecrawlCard - bot-scoped weekly auto-refresh of crawled URLs.
 *
 * Standard / Professional plans see a working toggle plus the last-run
 * summary and the next scheduled run. Free / Starter plans see the same
 * layout with the toggle rendered as OFF; clicking it opens the shared
 * upgrade modal via ``requestUpgrade('auto_recrawl')`` instead of hitting
 * the backend (which would 403 anyway).
 *
 * There is no manual "Recrawl now" trigger - the ARQ sweep at :05 past
 * every hour fires the per-bot task the moment ``next_recrawl_at`` has
 * elapsed. The card is a status surface, not a control surface for
 * ad-hoc runs.
 *
 * The client-side entitlements check is a convenience; the backend
 * re-enforces the gate on every PATCH so a stale entitlements cache
 * can't grant a paid feature by accident.
 */
export default function AutoRecrawlCard({ botId }) {
    const { entitlements, loading: entitlementsLoading } = useEntitlements();
    const featureAvailable = entitlements.hasFeature('auto_recrawl');
    const { requestUpgrade } = useUpgradeModal();

    const [status, setStatus] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [confirmingDisable, setConfirmingDisable] = useState(false);
    const [flash, setFlash] = useState(null);

    const load = useCallback(async () => {
        if (!botId) return;
        setLoading(true);
        setError(null);
        try {
            const data = await getRecrawlStatus(botId);
            setStatus(data);
        } catch (err) {
            setError(err.message || 'Failed to load auto-recrawl status');
        } finally {
            setLoading(false);
        }
    }, [botId]);

    useEffect(() => {
        load();
    }, [load]);

    // Auto-clear the flash message after 4 seconds so it doesn't linger
    // as a permanent banner - the customer's next action is a fresh signal.
    useEffect(() => {
        if (!flash) return undefined;
        const timer = setTimeout(() => setFlash(null), 4000);
        return () => clearTimeout(timer);
    }, [flash]);

    const handleToggle = async (nextEnabled) => {
        // Free / Starter never actually flip the flag - the click is
        // captured here and redirected to the upgrade modal instead of
        // hitting the backend (which would reject with 403 anyway).
        if (autoRecrawlLocked) {
            requestUpgrade('auto_recrawl');
            return;
        }
        // Turning off shows a confirmation first - the customer might be
        // one click away from losing their weekly refresh cadence and
        // should hear the "next enable resets the 7-day clock" caveat.
        if (!nextEnabled && status?.enabled) {
            setConfirmingDisable(true);
            return;
        }
        await commitToggle(nextEnabled);
    };

    const commitToggle = async (nextEnabled) => {
        setSaving(true);
        setError(null);
        setConfirmingDisable(false);
        try {
            const updated = await updateRecrawl(botId, nextEnabled);
            setStatus(updated);
            setFlash({
                type: 'success',
                message: nextEnabled
                    ? 'Auto-recrawl enabled. Next check scheduled in 7 days.'
                    : 'Auto-recrawl disabled. Toggle on again anytime to restart the weekly cycle.',
            });
        } catch (err) {
            setError(err.message || 'Failed to update auto-recrawl');
        } finally {
            setSaving(false);
        }
    };

    // The ``auto_recrawl`` plan flag decides whether the toggle is
    // interactive. Two sources so a stale client cache can't wrongly
    // enable it:
    //  * ``backendLocked`` is the ground truth from the GET response.
    //  * ``clientLocked`` is the fast client-side check for pre-fetch renders.
    // When either is true the toggle is disabled and a persistent upsell
    // banner points the customer at /billing.
    const backendLocked = status && status.feature_available === false;
    const clientLocked = !entitlementsLoading && !featureAvailable;
    const autoRecrawlLocked = Boolean(backendLocked || clientLocked);

    if (loading) {
        return (
            <div className="rounded-2xl border border-surface-200 dark:border-surface-800 p-6 bg-[var(--bg-card)] dark:bg-surface-900">
                <div className="flex items-center gap-3">
                    <Loader2 className="animate-spin text-primary-500" size={18} />
                    <span className="text-sm text-surface-500">Loading auto-recrawl status…</span>
                </div>
            </div>
        );
    }

    const {
        enabled = false,
        cadence_days: cadenceDays = 7,
        next_recrawl_at: nextRecrawlAt,
        last_recrawl_at: lastRecrawlAt,
        last_recrawl_status: lastStatus,
        sources_count: sourcesCount = 0,
    } = status || {};

    return (
        <div className="rounded-2xl border border-surface-200 dark:border-surface-800 bg-[var(--bg-card)] dark:bg-surface-900 overflow-hidden">
            <div className="p-6 space-y-5">
                <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-xl bg-primary-50 dark:bg-primary-500/10 flex items-center justify-center flex-shrink-0">
                            <RefreshCw className="text-primary-600 dark:text-primary-400" size={18} />
                        </div>
                        <div>
                            <h3 className="text-base font-semibold text-surface-900 dark:text-white">Auto-recrawl</h3>
                            <p className="text-sm text-surface-500 mt-0.5">
                                Refresh every crawled URL once a week. We only re-embed pages whose content actually changed.
                            </p>
                        </div>
                    </div>

                    <ToggleSwitch
                        enabled={autoRecrawlLocked ? false : enabled}
                        disabled={saving}
                        onChange={handleToggle}
                        label={
                            autoRecrawlLocked
                                ? 'Upgrade to Standard to enable weekly auto-recrawl'
                                : 'Toggle weekly auto-recrawl'
                        }
                    />
                </div>

                {/* Live status strip */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <StatusTile
                        label="Cadence"
                        value={enabled ? `Every ${cadenceDays} days` : 'Off'}
                        icon={<CalendarClock size={14} />}
                    />
                    <StatusTile
                        label="Last checked"
                        value={lastRecrawlAt ? formatRelative(lastRecrawlAt) : '-'}
                        sub={lastStatus ? capitalize(lastStatus) : null}
                    />
                    {(() => {
                        // Both the relative "in about X" and the absolute
                        // "≈ 2:35 PM" must describe the SAME moment - the
                        // sweep tick that will actually enqueue this bot.
                        // Feeding raw next_recrawl_at into formatRelative
                        // while the sub-line ceilings to the tick made the
                        // two lines contradict each other (primary said
                        // "in 55 mins" while sub said "≈ 2:35 PM", which
                        // was actually ~2h away).
                        const runTick = enabled && nextRecrawlAt ? ceilToNextSweepTick(nextRecrawlAt) : null;
                        return (
                            <StatusTile
                                label="Next check"
                                value={runTick ? formatRelative(runTick.toISOString()) : '-'}
                                sub={runTick ? formatAbsoluteRunTime(runTick) : null}
                            />
                        );
                    })()}
                </div>

                {/* Sources line */}
                <div className="text-xs text-surface-500">
                    {sourcesCount === 0 ? (
                        <span>No crawled URLs yet. Scan a website first to enable recrawl.</span>
                    ) : (
                        <span>{sourcesCount} URL{sourcesCount === 1 ? '' : 's'} in the recrawl set</span>
                    )}
                </div>

                {flash && (
                    <div
                        className={cn(
                            'flex items-start gap-2 px-3 py-2 rounded-lg text-sm',
                            flash.type === 'success'
                                ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                : 'bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300',
                        )}
                        role="status"
                    >
                        {flash.type === 'success' ? (
                            <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" />
                        ) : (
                            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                        )}
                        <span>{flash.message}</span>
                    </div>
                )}

                {/* Transient error - PATCH failures, network hiccups, etc. */}
                {error && (
                    <div className="flex items-start gap-2 px-3 py-2 rounded-lg text-sm bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300">
                        <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                        <span>{error}</span>
                    </div>
                )}
            </div>

            {confirmingDisable && (
                <ConfirmDisableDialog
                    onCancel={() => setConfirmingDisable(false)}
                    onConfirm={() => commitToggle(false)}
                />
            )}
        </div>
    );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ToggleSwitch({ enabled, disabled, onChange, label }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={label}
            disabled={disabled}
            onClick={() => onChange(!enabled)}
            className={cn(
                'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full',
                'border-2 border-transparent transition-colors duration-200 ease-in-out',
                'focus:outline-none focus:ring-1 focus:ring-[var(--focus-ring)] focus:ring-offset-2',
                'focus:ring-offset-white dark:focus:ring-offset-surface-900',
                enabled ? 'bg-primary-600' : 'bg-surface-300 dark:bg-surface-700',
                disabled && 'opacity-50 cursor-not-allowed',
            )}
        >
            <span
                className={cn(
                    'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow',
                    'ring-0 transition duration-200 ease-in-out',
                    enabled ? 'translate-x-5' : 'translate-x-0',
                )}
            />
        </button>
    );
}

function StatusTile({ label, value, sub, icon }) {
    return (
        <div className="rounded-xl border border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900/50 p-3">
            <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-surface-500 font-medium">
                {icon}
                <span>{label}</span>
            </div>
            <div className="text-sm font-medium text-surface-900 dark:text-white mt-1">{value}</div>
            {sub && <div className="text-xs text-surface-500 mt-0.5">{sub}</div>}
        </div>
    );
}

function ConfirmDisableDialog({ onCancel, onConfirm }) {
    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            role="dialog"
            aria-modal="true"
        >
            <div className="w-full max-w-sm rounded-2xl bg-[var(--bg-card)] dark:bg-surface-900 p-5 shadow-2xl border border-surface-200 dark:border-surface-800">
                <h4 className="text-base font-semibold text-surface-900 dark:text-white">
                    Turn off auto-recrawl?
                </h4>
                <p className="text-sm text-surface-500 mt-2">
                    Your bot will stop refreshing crawled pages automatically. If you toggle it back on later,
                    the 7-day countdown starts fresh from that moment.
                </p>
                <div className="flex justify-end gap-2 mt-5">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="px-3 py-1.5 rounded-lg text-sm font-medium text-surface-700 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="px-3 py-1.5 rounded-lg text-sm font-medium text-white bg-rose-600 hover:bg-rose-700"
                    >
                        Turn off
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function capitalize(slug) {
    if (!slug) return 'Free';
    return slug.charAt(0).toUpperCase() + slug.slice(1);
}

// Round ``next_recrawl_at`` up to the actual sweep tick that would enqueue
// this bot. The cron fires hourly at UTC :05, so a bot due at 14:37 UTC
// won't run until the 15:05 UTC sweep - showing 14:37 raw would be a lie.
// This helper gives the honest estimate; the ≈ prefix in the tile signals
// it's still approximate (the per-hour cap can defer by an extra hour,
// sweep queue depth affects start latency, and the recrawl itself takes
// minutes to run).
//
// Ceiling math runs in UTC (``setUTCMinutes``/``setUTCHours``) because
// the sweep cron uses UTC minutes - in half-hour-offset zones (IST,
// Nepal, Newfoundland) rounding to LOCAL :05 lands on UTC :35, which
// would be wrong. Only the final ``toLocale*String`` renders in the
// user's own timezone.
function ceilToNextSweepTick(iso) {
    const d = new Date(iso);
    const tick = new Date(d);
    tick.setUTCSeconds(0, 0);
    tick.setUTCMinutes(5);
    // Strict `<` - a bot with next_recrawl_at exactly at :05:00.000 IS
    // caught by that same-hour sweep (the cron fires with now slightly
    // past :05:00.000, so ``next_recrawl_at <= now`` matches). Only bump
    // to the next hour when d is past :05 in the current hour.
    if (tick < d) {
        tick.setUTCHours(tick.getUTCHours() + 1);
    }
    return tick;
}

// Format an already-computed sweep-tick Date as "≈ 2:35 PM · Tue, Jul 21".
// Kept separate from ``ceilToNextSweepTick`` so the tile can compute the
// tick once and feed it into BOTH the relative and absolute formatters -
// otherwise the two lines describe different moments and contradict each
// other (see the AutoRecrawl "Next check" tile).
function formatAbsoluteRunTime(tick) {
    try {
        const time = formatTime(tick, {
            hour: 'numeric',
            minute: '2-digit',
        });
        const date = formatDate(tick, {
            weekday: 'short',
            month: 'short',
            day: 'numeric', year: undefined });
        return `≈ ${time} · ${date}`;
    } catch {
        return '-';
    }
}

function formatRelative(iso) {
    try {
        const then = new Date(iso).getTime();
        const now = Date.now();
        const diffMs = then - now;
        const absSeconds = Math.abs(diffMs) / 1000;
        const isFuture = diffMs > 0;

        // Fuzzy units get an "about" qualifier - an hour-grain estimate
        // for a system that can slip by 30+ minutes shouldn't look precise.
        const units = [
            { limit: 60, label: 'sec', divisor: 1, fuzzy: false },
            { limit: 3600, label: 'min', divisor: 60, fuzzy: false },
            { limit: 86400, label: 'hour', divisor: 3600, fuzzy: true },
            { limit: 604800, label: 'day', divisor: 86400, fuzzy: true },
            { limit: 2629800, label: 'week', divisor: 604800, fuzzy: true },
            { limit: Infinity, label: 'month', divisor: 2629800, fuzzy: true },
        ];
        const unit = units.find((u) => absSeconds < u.limit);
        const value = Math.round(absSeconds / unit.divisor);
        const plural = value === 1 ? unit.label : `${unit.label}s`;
        if (isFuture) {
            return unit.fuzzy ? `in about ${value} ${plural}` : `in ${value} ${plural}`;
        }
        return `${value} ${plural} ago`;
    } catch {
        return '-';
    }
}
