import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
    Clock, Users, Building2, Loader2, ChevronRight, Check, Lock, Info,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useToast } from '../../context/ToastContext';
import { useBotContext } from '../../context/BotContext';
import { useUpgradeModal } from '../../context/UpgradeModalContext';
import useEntitlements from '../../hooks/useEntitlements';
import BusinessHoursEditor from '../../components/BusinessHoursEditor';
import { getClientSettings, updateClientSettings, getDepartments } from '../../services/api';

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_ABBR = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

/**
 * Formats a set of open day-keys into compact human ranges, e.g.
 * ['mon','tue','wed','thu','fri'] → "Mon–Fri"; ['mon','wed','fri'] → "Mon, Wed, Fri".
 */
function formatDayRanges(keys) {
    const idx = keys
        .map((k) => DAY_ORDER.indexOf(k))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b);
    if (idx.length === 0) return '';

    const ranges = [];
    let start = idx[0];
    let prev = idx[0];
    for (let i = 1; i < idx.length; i += 1) {
        if (idx[i] === prev + 1) {
            prev = idx[i];
        } else {
            ranges.push([start, prev]);
            start = idx[i];
            prev = idx[i];
        }
    }
    ranges.push([start, prev]);

    return ranges
        .map(([a, b]) =>
            a === b
                ? DAY_ABBR[DAY_ORDER[a]]
                : `${DAY_ABBR[DAY_ORDER[a]]}–${DAY_ABBR[DAY_ORDER[b]]}`
        )
        .join(', ');
}

/**
 * Derives a one-line summary of a department's business hours (same JSONB shape
 * as BusinessHoursEditor). Null/disabled → "Always open"; uniform hours across
 * open days → "Mon–Fri · 09:00–17:00"; otherwise → "Custom hours".
 */
function summarizeHours(bh) {
    if (!bh || !bh.enabled) return 'Always open';
    const days = bh.days || {};
    const openKeys = DAY_ORDER.filter((k) => days[k]?.enabled);
    if (openKeys.length === 0) return 'Closed';

    const first = days[openKeys[0]];
    const uniform = openKeys.every(
        (k) => days[k].start === first.start && days[k].end === first.end
    );
    if (uniform) {
        return `${formatDayRanges(openKeys)} · ${first.start}–${first.end}`;
    }
    return `${formatDayRanges(openKeys)} · custom hours`;
}

const queueInputCls =
    'w-full h-10 px-3 text-sm text-surface-700 dark:text-surface-200 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 disabled:opacity-60 disabled:cursor-not-allowed';

/**
 * Settings → Live Chat — central hub for live-chat availability config.
 *
 * The page the Team-management nudge ("Business hours and queue behaviour …
 * Configure in Settings → Live Chat") finally points to. It is a hub rather
 * than a second source of truth:
 *
 *   1. Business hours — editable workspace default (``bots.business_hours``,
 *      the fallback used when a chat has no department). Departments override
 *      this in Team → Departments.
 *   2. Queue behaviour — editable, scoped to the selected bot
 *      (``bots.live_chat_queue_timeout_seconds`` / ``…_max_queue_size``).
 *   3. Department overrides — read-only summary that deep-links to the real
 *      per-department editor, so schedules keep a single source of truth.
 *
 * Everything is scoped to ``useBotContext().selectedBot`` — the same bot the
 * top-left switcher controls — because these columns live on the Bot row.
 */
export default function LiveChatTab() {
    const { showToast } = useToast();
    const { selectedBot, bots, loading: botsLoading } = useBotContext();
    const { requestUpgrade } = useUpgradeModal();
    const { entitlements: ent } = useEntitlements();
    const liveChatAllowed = ent.hasFeature('live_chat');

    const [businessHours, setBusinessHours] = useState(null);
    const [queueTimeout, setQueueTimeout] = useState(20);
    const [maxQueue, setMaxQueue] = useState(10);
    const [departments, setDepartments] = useState([]);

    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [saving, setSaving] = useState(false);
    // Snapshot of the loaded values so Save only enables on a real change.
    const [initial, setInitial] = useState(null);

    const botId = selectedBot?.id;

    const load = useCallback(async () => {
        if (!botId) return;
        setLoading(true);
        setLoadError('');
        try {
            const [settingsRes, deptRes] = await Promise.allSettled([
                getClientSettings(botId),
                getDepartments(),
            ]);

            if (settingsRes.status === 'rejected') {
                throw settingsRes.reason;
            }
            const settings = settingsRes.value;
            const bh = settings.business_hours || null;
            const qt = settings.live_chat_queue_timeout_seconds ?? 20;
            const mq = settings.live_chat_max_queue_size ?? 10;

            setBusinessHours(bh);
            setQueueTimeout(qt);
            setMaxQueue(mq);
            setInitial({ bh: JSON.stringify(bh), qt, mq });

            // Departments are non-fatal — a free workspace or a transient error
            // shouldn't block the editable sections above.
            setDepartments(
                deptRes.status === 'fulfilled' ? deptRes.value.departments || [] : []
            );
        } catch (err) {
            setLoadError(err.message || 'Failed to load live chat settings.');
        } finally {
            setLoading(false);
        }
    }, [botId]);

    useEffect(() => {
        load();
    }, [load]);

    const dirty =
        initial != null &&
        (JSON.stringify(businessHours) !== initial.bh ||
            queueTimeout !== initial.qt ||
            maxQueue !== initial.mq);

    const handleSave = async () => {
        if (!botId || saving) return;
        setSaving(true);
        try {
            await updateClientSettings(
                {
                    business_hours: businessHours || {},
                    live_chat_queue_timeout_seconds: queueTimeout,
                    live_chat_max_queue_size: maxQueue,
                },
                botId
            );
            setInitial({ bh: JSON.stringify(businessHours), qt: queueTimeout, mq: maxQueue });
            showToast('success', 'Live chat settings saved.');
        } catch (err) {
            showToast('error', err.message || 'Failed to save live chat settings.');
        } finally {
            setSaving(false);
        }
    };

    // ── Loading / empty states ────────────────────────────────────────────
    if (botsLoading || (loading && !loadError)) {
        return (
            <div className="flex items-center gap-2 text-surface-400 dark:text-surface-500 text-sm py-10">
                <Loader2 size={15} className="animate-spin" />
                Loading live chat settings…
            </div>
        );
    }

    if (!botId) {
        return (
            <div className="rounded-2xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 p-8 text-center">
                <p className="text-sm font-medium text-surface-700 dark:text-surface-200">No bot selected</p>
                <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
                    Create a bot first — live chat availability is configured per bot.
                </p>
            </div>
        );
    }

    if (loadError) {
        return (
            <div className="rounded-2xl border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/20 p-5">
                <p className="text-sm text-rose-700 dark:text-rose-300 mb-3">{loadError}</p>
                <button
                    type="button"
                    onClick={load}
                    className="text-sm font-medium text-primary-600 dark:text-primary-400 hover:underline"
                >
                    Try again
                </button>
            </div>
        );
    }

    const disabled = !liveChatAllowed || saving;

    return (
        <div className="space-y-6">
            {/* Header */}
            <div>
                <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50">Live Chat</h2>
                <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
                    Availability and queue behaviour for{' '}
                    <strong className="font-semibold text-surface-700 dark:text-surface-300">
                        {selectedBot?.name || 'this bot'}
                    </strong>
                    .
                    {bots.length > 1 && (
                        <> These settings are per bot — switch bots with the workspace switcher (top left).</>
                    )}
                </p>
            </div>

            {/* Plan gate notice */}
            {!liveChatAllowed && (
                <div className="flex items-start gap-3 rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-4">
                    <Lock size={16} className="text-amber-500 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                        <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                            Live chat isn&apos;t included in your plan
                        </p>
                        <p className="text-sm text-amber-700/90 dark:text-amber-300/80 mt-0.5">
                            You can preview these settings, but they only take effect once live chat is enabled.
                        </p>
                        <button
                            type="button"
                            onClick={() => requestUpgrade('live_chat')}
                            className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-amber-800 dark:text-amber-200 hover:underline"
                        >
                            Upgrade plan
                            <ChevronRight size={14} />
                        </button>
                    </div>
                </div>
            )}

            {/* ── 1. Workspace default business hours ─────────────────────── */}
            <section className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                <h3 className="text-[15px] font-semibold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                    <Clock size={16} className="text-primary-600 dark:text-primary-400" />
                    Default business hours
                </h3>
                <p className="text-[13px] text-surface-500 dark:text-surface-400 mt-1 mb-4">
                    Applied when a chat isn&apos;t routed to a department. Departments can set their own
                    schedule, which takes precedence.
                </p>
                <BusinessHoursEditor
                    value={businessHours}
                    onChange={setBusinessHours}
                    disabled={disabled}
                />
            </section>

            {/* ── 2. Queue behaviour ──────────────────────────────────────── */}
            <section className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                <h3 className="text-[15px] font-semibold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                    <Users size={16} className="text-primary-600 dark:text-primary-400" />
                    Queue behaviour
                </h3>
                <p className="text-[13px] text-surface-500 dark:text-surface-400 mt-1 mb-4">
                    How visitors are queued when every operator is busy.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <label htmlFor="lc-queue-timeout" className="text-[13px] font-semibold text-surface-700 dark:text-surface-300">
                            Queue timeout (seconds)
                        </label>
                        <input
                            id="lc-queue-timeout"
                            type="number"
                            min={5}
                            max={600}
                            step={5}
                            value={queueTimeout}
                            disabled={disabled}
                            onChange={(e) => setQueueTimeout(Number(e.target.value))}
                            className={queueInputCls}
                        />
                        <p className="text-[11px] text-surface-400 dark:text-surface-500">
                            How long a visitor waits for an operator before timing out (20 default).
                        </p>
                    </div>
                    <div className="space-y-2">
                        <label htmlFor="lc-max-queue" className="text-[13px] font-semibold text-surface-700 dark:text-surface-300">
                            Max queue size
                        </label>
                        <input
                            id="lc-max-queue"
                            type="number"
                            min={1}
                            max={100}
                            step={1}
                            value={maxQueue}
                            disabled={disabled}
                            onChange={(e) => setMaxQueue(Number(e.target.value))}
                            className={queueInputCls}
                        />
                        <p className="text-[11px] text-surface-400 dark:text-surface-500">
                            Maximum visitors that can wait in the queue at once (10 default).
                        </p>
                    </div>
                </div>
                <Link
                    to="/chatbot?tab=appearance&section=live_chat"
                    className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 transition-colors"
                >
                    Widget copy & handoff messages in Bot Settings
                    <ChevronRight size={14} />
                </Link>
            </section>

            {/* Save bar (sections 1 + 2 both write to the selected bot) */}
            <div className="flex items-center justify-end gap-3">
                {dirty && !disabled && (
                    <span className="text-[12px] text-surface-400 dark:text-surface-500">Unsaved changes</span>
                )}
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={disabled || !dirty}
                    className={cn(
                        'inline-flex items-center gap-2 py-2.5 px-5 text-sm font-medium rounded-xl transition-colors',
                        'bg-primary-600 hover:bg-primary-700 text-white',
                        'disabled:opacity-50 disabled:cursor-not-allowed'
                    )}
                >
                    {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                    Save changes
                </button>
            </div>

            {/* ── 3. Department overrides (read-only summary + deep-link) ──── */}
            <section className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <h3 className="text-[15px] font-semibold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                            <Building2 size={16} className="text-primary-600 dark:text-primary-400" />
                            Department overrides
                        </h3>
                        <p className="text-[13px] text-surface-500 dark:text-surface-400 mt-1">
                            Each department can run its own schedule. Edit these in Team → Departments.
                        </p>
                    </div>
                    <Link
                        to="/team?tab=departments"
                        className="inline-flex items-center gap-1 text-[13px] font-medium text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 transition-colors shrink-0"
                    >
                        Manage
                        <ChevronRight size={14} />
                    </Link>
                </div>

                {departments.length === 0 ? (
                    <div className="mt-4 flex items-center gap-2 text-[13px] text-surface-500 dark:text-surface-400">
                        <Info size={14} className="shrink-0" />
                        No departments yet — the default hours above apply to every chat.
                    </div>
                ) : (
                    <ul className="mt-4 divide-y divide-surface-100 dark:divide-surface-800 border border-surface-100 dark:border-surface-800 rounded-xl overflow-hidden">
                        {departments.map((dept) => (
                            <li
                                key={dept.id}
                                className="flex items-center justify-between gap-3 px-4 py-3 bg-white dark:bg-surface-900"
                            >
                                <span className="text-sm font-medium text-surface-800 dark:text-surface-200 truncate">
                                    {dept.name}
                                </span>
                                <span className="text-[12px] text-surface-500 dark:text-surface-400 shrink-0">
                                    {summarizeHours(dept.business_hours)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
