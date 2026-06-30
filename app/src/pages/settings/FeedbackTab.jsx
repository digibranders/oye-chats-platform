import { useState, useEffect, useCallback } from 'react';
import {
    MessageSquare, Bug, Lightbulb, HelpCircle, MoreHorizontal,
    Loader2, Send, Clock, CheckCircle2, Archive, Inbox, RefreshCw,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useToast } from '../../context/ToastContext';
import { submitPlatformFeedback, getMyFeedback } from '../../services/api';

const TYPES = [
    { id: 'bug', label: 'Bug', icon: Bug },
    { id: 'feature_request', label: 'Feature', icon: Lightbulb },
    { id: 'question', label: 'Question', icon: HelpCircle },
    { id: 'other', label: 'Other', icon: MoreHorizontal },
];

const AREAS = [
    { id: '', label: 'Not sure / unspecified' },
    { id: 'billing', label: 'Billing' },
    { id: 'bots', label: 'Bots' },
    { id: 'knowledge', label: 'Knowledge' },
    { id: 'live_chat', label: 'Live chat' },
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'widget', label: 'Widget' },
    { id: 'other', label: 'Other' },
];

const SEVERITIES = [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'critical', label: 'Critical' },
];

const TYPE_LABELS = Object.fromEntries(TYPES.map((t) => [t.id, t.label]));
const AREA_LABELS = Object.fromEntries(AREAS.filter((a) => a.id).map((a) => [a.id, a.label]));
const SEVERITY_LABELS = Object.fromEntries(SEVERITIES.map((s) => [s.id, s.label]));

const STATUS_META = {
    open: { label: 'Open', icon: Clock, className: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300' },
    in_progress: { label: 'In progress', icon: Loader2, className: 'bg-sky-100 dark:bg-sky-500/15 text-sky-700 dark:text-sky-300' },
    resolved: { label: 'Resolved', icon: CheckCircle2, className: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
    closed: { label: 'Closed', icon: Archive, className: 'bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400' },
};

function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function StatusBadge({ status }) {
    const meta = STATUS_META[status] || STATUS_META.open;
    const Icon = meta.icon;
    return (
        <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold', meta.className)}>
            <Icon size={11} className={status === 'in_progress' ? 'animate-spin' : ''} />
            {meta.label}
        </span>
    );
}

function MetaPill({ children }) {
    return (
        <span className="text-[11px] text-surface-500 dark:text-surface-400 px-2 py-0.5 rounded-full bg-surface-100 dark:bg-surface-800 border border-surface-200 dark:border-surface-700">
            {children}
        </span>
    );
}

/**
 * FeedbackTab — submit platform feedback and review your own submissions.
 *
 * The submit form mirrors the FeedbackModal fields (type required, optional
 * area, severity for bugs). The "My feedback" list surfaces each item's status
 * and the admin's written response so customers see the resolution loop.
 */
export default function FeedbackTab() {
    const { showToast } = useToast();

    const [type, setType] = useState(null);
    const [area, setArea] = useState('');
    const [severity, setSeverity] = useState(null);
    const [message, setMessage] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const [items, setItems] = useState([]);
    const [loadingList, setLoadingList] = useState(true);
    const [listError, setListError] = useState('');

    const loadFeedback = useCallback(async () => {
        setLoadingList(true);
        setListError('');
        try {
            const data = await getMyFeedback();
            setItems(Array.isArray(data) ? data : []);
        } catch (err) {
            setListError(err.message || 'Failed to load your feedback');
        } finally {
            setLoadingList(false);
        }
    }, []);

    useEffect(() => {
        loadFeedback();
    }, [loadFeedback]);

    const canSubmit = !!message.trim() && !!type && !submitting;

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        try {
            await submitPlatformFeedback({
                message: message.trim(),
                type,
                area: area || null,
                severity: type === 'bug' ? severity : null,
                context: {
                    page_url: typeof window !== 'undefined' ? window.location.href : null,
                    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
                },
            });
            setMessage('');
            setType(null);
            setArea('');
            setSeverity(null);
            showToast('success', 'Thanks! Your feedback was submitted.');
            await loadFeedback();
        } catch (err) {
            showToast('error', err.message || 'Failed to submit feedback.');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="space-y-6">
            {/* ── Submit feedback ─────────────────────────────────────────── */}
            <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50 mb-1 flex items-center gap-2">
                    <MessageSquare size={16} className="text-primary-600 dark:text-primary-400" />
                    Send Feedback
                </h2>
                <p className="text-sm text-surface-500 dark:text-surface-400 mb-5">
                    Found a bug or have an idea? Tell us — we read every submission and reply here.
                </p>

                <form onSubmit={handleSubmit} className="space-y-5">
                    {/* Type — required */}
                    <div>
                        <span className="text-sm font-medium text-surface-800 dark:text-surface-200 mb-2 block">
                            What type of feedback is this? <span className="text-surface-400 font-normal">(required)</span>
                        </span>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            {TYPES.map((t) => {
                                const Icon = t.icon;
                                const selected = type === t.id;
                                return (
                                    <button
                                        key={t.id}
                                        type="button"
                                        onClick={() => setType(t.id)}
                                        aria-pressed={selected}
                                        className={cn(
                                            'flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-all',
                                            'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                                            selected
                                                ? 'border-primary-500 bg-primary-50/60 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
                                                : 'border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800/60'
                                        )}
                                    >
                                        <Icon size={15} />
                                        {t.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Area — optional */}
                    <div>
                        <label htmlFor="feedback-area" className="text-sm font-medium text-surface-800 dark:text-surface-200 mb-2 block">
                            Which area? <span className="text-surface-400 font-normal">(optional)</span>
                        </label>
                        <select
                            id="feedback-area"
                            value={area}
                            onChange={(e) => setArea(e.target.value)}
                            className={cn(
                                'w-full px-3 py-2.5 rounded-xl border border-surface-200 dark:border-surface-600 text-sm',
                                'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                'focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all'
                            )}
                        >
                            {AREAS.map((a) => (
                                <option key={a.id || 'none'} value={a.id}>{a.label}</option>
                            ))}
                        </select>
                    </div>

                    {/* Severity — bug only */}
                    {type === 'bug' && (
                        <div>
                            <span className="text-sm font-medium text-surface-800 dark:text-surface-200 mb-2 block">
                                How severe is it? <span className="text-surface-400 font-normal">(optional)</span>
                            </span>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                {SEVERITIES.map((s) => {
                                    const selected = severity === s.id;
                                    return (
                                        <button
                                            key={s.id}
                                            type="button"
                                            onClick={() => setSeverity(selected ? null : s.id)}
                                            aria-pressed={selected}
                                            className={cn(
                                                'px-3 py-2 rounded-xl border text-sm font-medium transition-all',
                                                'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
                                                selected
                                                    ? 'border-primary-500 bg-primary-50/60 dark:bg-primary-500/10 text-primary-700 dark:text-primary-300'
                                                    : 'border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800/60'
                                            )}
                                        >
                                            {s.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Message */}
                    <div>
                        <label htmlFor="feedback-message" className="text-sm font-medium text-surface-800 dark:text-surface-200 mb-2 block">
                            Your message
                        </label>
                        <textarea
                            id="feedback-message"
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            rows={4}
                            placeholder="Describe your issue or feature request…"
                            className={cn(
                                'w-full px-4 py-3 rounded-xl border border-surface-200 dark:border-surface-600',
                                'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                'placeholder:text-surface-400 dark:placeholder:text-surface-500',
                                'focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all resize-none text-sm'
                            )}
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={!canSubmit}
                        className="inline-flex items-center gap-2 py-2.5 px-5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {submitting ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                        Send Feedback
                    </button>
                </form>
            </div>

            {/* ── My feedback ─────────────────────────────────────────────── */}
            <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                <div className="flex items-center justify-between gap-4 mb-5">
                    <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                        <Inbox size={16} className="text-primary-600 dark:text-primary-400" />
                        My Feedback
                    </h2>
                    <button
                        type="button"
                        onClick={loadFeedback}
                        disabled={loadingList}
                        aria-label="Refresh feedback list"
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-surface-500 dark:text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 transition-colors disabled:opacity-50"
                    >
                        <RefreshCw size={14} className={loadingList ? 'animate-spin' : ''} />
                        Refresh
                    </button>
                </div>

                {loadingList ? (
                    <div className="flex items-center gap-2 text-surface-400 dark:text-surface-500 text-sm py-2">
                        <Loader2 size={14} className="animate-spin" />
                        Loading your feedback…
                    </div>
                ) : listError ? (
                    <div>
                        <p className="text-sm text-rose-600 dark:text-rose-400 mb-3">{listError}</p>
                        <button
                            type="button"
                            onClick={loadFeedback}
                            className="text-sm font-medium text-primary-600 dark:text-primary-400 hover:underline"
                        >
                            Try again
                        </button>
                    </div>
                ) : items.length === 0 ? (
                    <div className="text-center py-8">
                        <Inbox size={28} className="mx-auto text-surface-300 dark:text-surface-600 mb-2" />
                        <p className="text-sm text-surface-500 dark:text-surface-400">
                            You haven&apos;t sent any feedback yet.
                        </p>
                        <p className="text-xs text-surface-400 dark:text-surface-500 mt-1">
                            Once you send feedback, you&apos;ll see its status and our response here.
                        </p>
                    </div>
                ) : (
                    <ul className="space-y-3">
                        {items.map((item) => (
                            <li
                                key={item.id}
                                className="rounded-xl border border-surface-200 dark:border-surface-700 bg-surface-50/50 dark:bg-surface-800/40 p-4"
                            >
                                <div className="flex items-start justify-between gap-3 flex-wrap">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                        {item.type && <MetaPill>{TYPE_LABELS[item.type] || item.type}</MetaPill>}
                                        {item.area && <MetaPill>{AREA_LABELS[item.area] || item.area}</MetaPill>}
                                        {item.severity && <MetaPill>{SEVERITY_LABELS[item.severity] || item.severity}</MetaPill>}
                                        {item.created_at && (
                                            <span className="text-[11px] text-surface-400 dark:text-surface-500">
                                                {formatDate(item.created_at)}
                                            </span>
                                        )}
                                    </div>
                                    <StatusBadge status={item.status} />
                                </div>

                                <p className="mt-2 text-sm text-surface-700 dark:text-surface-200 whitespace-pre-wrap leading-relaxed">
                                    {item.message}
                                </p>

                                {item.admin_response && (
                                    <div className="mt-3 rounded-lg bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 p-3">
                                        <p className="text-[11px] font-semibold uppercase tracking-wide text-surface-400 dark:text-surface-500 mb-1">
                                            OyeChats team
                                        </p>
                                        <p className="text-[13px] text-surface-700 dark:text-surface-200 whitespace-pre-wrap leading-relaxed">
                                            {item.admin_response}
                                        </p>
                                        {item.resolved_at && (
                                            <p className="mt-2 text-[11px] text-surface-400 dark:text-surface-500">
                                                Resolved {formatDate(item.resolved_at)}
                                            </p>
                                        )}
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
