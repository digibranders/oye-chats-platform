import { useState, useEffect, useCallback } from 'react';
import {
    MessageSquareWarning, Paperclip, Star, Award, AlignLeft, Clock, Mail, Loader2
} from 'lucide-react';
import { useToast } from '../context/ToastContext';
import PageHeader from '../components/ui/PageHeader';
import { getAuthState } from '../utils/auth';
import { getBots, updateBot } from '../services/api';

// ─── Helpers ────────────────────────────────────────────────────────────────

const DAYS = [
    { key: 'mon', label: 'Monday' },
    { key: 'tue', label: 'Tuesday' },
    { key: 'wed', label: 'Wednesday' },
    { key: 'thu', label: 'Thursday' },
    { key: 'fri', label: 'Friday' },
    { key: 'sat', label: 'Saturday' },
    { key: 'sun', label: 'Sunday' },
];

const DEFAULT_FLAGS = {
    file_sharing: false,
    post_chat_rating: true,
    show_branding: true,
    queue_position: false,
    typing_preview: true,
    email_transcript: false,
};

const DEFAULT_BUSINESS_HOURS = {
    enabled: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    days: Object.fromEntries(
        DAYS.map(({ key }) => [key, { enabled: key !== 'sat' && key !== 'sun', start: '09:00', end: '17:00' }])
    ),
};

// Simple toggle switch component
function Toggle({ checked, onChange, disabled = false, id }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            id={id}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'bg-primary-600' : 'bg-secondary-200'}`}
        >
            <span
                aria-hidden="true"
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${checked ? 'translate-x-4' : 'translate-x-0'}`}
            />
        </button>
    );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function Settings() {
    const { showToast } = useToast();
    const { isOperator, operatorRole, isBotManager } = getAuthState();
    const [feedback, setFeedback] = useState('');

    // Bot data
    const [botId, setBotId] = useState(null);
    const [flags, setFlags] = useState(DEFAULT_FLAGS);
    const [businessHours, setBusinessHours] = useState(DEFAULT_BUSINESS_HOURS);
    const [meetingBookingEnabled, setMeetingBookingEnabled] = useState(false);
    const [calendlyUrl, setCalendlyUrl] = useState('');
    const [loadingBot, setLoadingBot] = useState(true);

    // Saving state: key → true while in-flight
    const [saving, setSaving] = useState({});
    const [savingHours, setSavingHours] = useState(false);
    const [savingMeeting, setSavingMeeting] = useState(false);

    // Fetch current bot on mount
    useEffect(() => {
        const fetchBot = async () => {
            try {
                const bots = await getBots();
                if (!bots?.length) return;
                const bot = bots[0];
                setBotId(bot.id);
                setFlags({ ...DEFAULT_FLAGS, ...(bot.feature_flags || {}) });
                if (bot.business_hours) {
                    setBusinessHours({ ...DEFAULT_BUSINESS_HOURS, ...bot.business_hours });
                }
                setMeetingBookingEnabled(!!bot.meeting_booking_enabled);
                setCalendlyUrl(bot.calendly_url || '');
            } catch {
                showToast('error', 'Failed to load bot settings.');
            } finally {
                setLoadingBot(false);
            }
        };
        fetchBot();
        // showToast is stable (context value) — intentionally omitted to avoid re-running on provider re-render
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Toggle a single feature flag
    const toggleFlag = useCallback(async (key, value) => {
        if (!botId) return;
        setSaving((prev) => ({ ...prev, [key]: true }));
        // Optimistic update
        setFlags((prev) => ({ ...prev, [key]: value }));
        try {
            await updateBot(botId, { feature_flags: { [key]: value } });
        } catch {
            // Revert on failure
            setFlags((prev) => ({ ...prev, [key]: !value }));
            showToast('error', 'Failed to save setting.');
        } finally {
            setSaving((prev) => ({ ...prev, [key]: false }));
        }
        // showToast is stable — intentionally omitted
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [botId]);

    // Save the full business_hours object
    const saveBusinessHours = useCallback(async (updatedHours) => {
        if (!botId) return;
        setSavingHours(true);
        try {
            await updateBot(botId, { business_hours: updatedHours });
        } catch {
            showToast('error', 'Failed to save business hours.');
        } finally {
            setSavingHours(false);
        }
        // showToast is stable — intentionally omitted
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [botId]);

    const updateBusinessHours = useCallback((updater) => {
        setBusinessHours((prev) => {
            const next = updater(prev);
            saveBusinessHours(next);
            return next;
        });
    }, [saveBusinessHours]);

    const saveMeetingBooking = useCallback(async () => {
        if (!botId) return;
        setSavingMeeting(true);
        try {
            await updateBot(botId, {
                meeting_booking_enabled: meetingBookingEnabled,
                calendly_url: meetingBookingEnabled ? calendlyUrl : null,
            });
            showToast('success', 'Meeting booking settings saved');
        } catch (error) {
            showToast('error', error.message || 'Failed to save meeting booking settings.');
        } finally {
            setSavingMeeting(false);
        }
    }, [botId, calendlyUrl, meetingBookingEnabled, showToast]);

    const handleSendFeedback = (e) => {
        e.preventDefault();
        if (!feedback.trim()) return;
        showToast('success', 'Your feedback has been recorded!');
        setFeedback('');
    };

    // Only show bot-config sections to client/bot-manager accounts
    const showBotConfig = !isOperator || isBotManager;

    return (
        <div className="space-y-6 animate-fade-in max-w-3xl">
            <PageHeader title="Settings" subtitle="Preferences and account" />

            {/* ── Widget Behavior ──────────────────────────────────────────── */}
            {showBotConfig && (
                <div className="bg-white p-6 rounded-2xl border border-secondary-200 shadow-sm">
                    <h2 className="text-base font-semibold text-secondary-900 mb-1">Widget Behavior</h2>
                    <p className="text-sm text-secondary-500 mb-5">
                        Control which features are available to your visitors and operators.
                    </p>

                    {loadingBot ? (
                        <div className="flex items-center gap-2 text-secondary-400 text-sm py-2">
                            <Loader2 size={14} className="animate-spin" />
                            Loading settings…
                        </div>
                    ) : (
                        <div className="divide-y divide-secondary-100">
                            <FlagRow
                                icon={<Paperclip size={15} />}
                                label="File Sharing in Live Chat"
                                description="Allow visitors and operators to share images and files (max 10 MB) during live human chat sessions."
                                value={flags.file_sharing}
                                saving={saving.file_sharing}
                                onChange={(v) => toggleFlag('file_sharing', v)}
                            />
                            <FlagRow
                                icon={<Star size={15} />}
                                label="Post-Chat Rating Survey"
                                description="Show a 1–5 star satisfaction survey to visitors after a live chat session ends."
                                value={flags.post_chat_rating}
                                saving={saving.post_chat_rating}
                                onChange={(v) => toggleFlag('post_chat_rating', v)}
                            />
                            <FlagRow
                                icon={<Award size={15} />}
                                label='Show "Powered by OyeChats" Branding'
                                description="Display the OyeChats branding badge at the bottom of the chat widget."
                                value={flags.show_branding}
                                saving={saving.show_branding}
                                onChange={(v) => toggleFlag('show_branding', v)}
                            />
                            <FlagRow
                                icon={<AlignLeft size={15} />}
                                label="Queue Position Indicator"
                                description="Show visitors their position in the queue while waiting for a live operator."
                                value={flags.queue_position}
                                saving={saving.queue_position}
                                onChange={(v) => toggleFlag('queue_position', v)}
                            />
                            <FlagRow
                                icon={<Clock size={15} />}
                                label="Typing Preview"
                                description="Let operators see what the visitor is typing before they hit send (and vice versa)."
                                value={flags.typing_preview}
                                saving={saving.typing_preview}
                                onChange={(v) => toggleFlag('typing_preview', v)}
                            />
                            <FlagRow
                                icon={<Mail size={15} />}
                                label="Email Chat Transcript"
                                description="Allow visitors to request a copy of their chat conversation by email."
                                value={flags.email_transcript}
                                saving={saving.email_transcript}
                                onChange={(v) => toggleFlag('email_transcript', v)}
                            />
                        </div>
                    )}
                </div>
            )}

            {/* ── Meeting Booking ─────────────────────────────────────────── */}
            {showBotConfig && (
                <div className="bg-white p-6 rounded-2xl border border-secondary-200 shadow-sm">
                    <div className="flex items-start justify-between gap-4 mb-1">
                        <div>
                            <h2 className="text-base font-semibold text-secondary-900">Meeting Booking</h2>
                            <p className="text-sm text-secondary-500 mt-1">
                                Show a Calendly booking widget when leads qualify as SQL.
                            </p>
                        </div>
                        {savingMeeting && <Loader2 size={14} className="animate-spin text-secondary-400 flex-shrink-0 mt-1" />}
                    </div>

                    {loadingBot ? (
                        <div className="flex items-center gap-2 text-secondary-400 text-sm py-2 mt-4">
                            <Loader2 size={14} className="animate-spin" />
                            Loading settings…
                        </div>
                    ) : (
                        <div className="mt-5 space-y-4">
                            <div className="flex items-center justify-between">
                                <span className="text-sm font-medium text-secondary-800">Enable meeting booking</span>
                                <Toggle checked={meetingBookingEnabled} onChange={setMeetingBookingEnabled} />
                            </div>

                            {meetingBookingEnabled && (
                                <div>
                                    <label className="block text-sm text-secondary-700 mb-2">Calendly URL</label>
                                    <input
                                        type="url"
                                        value={calendlyUrl}
                                        onChange={(e) => setCalendlyUrl(e.target.value)}
                                        placeholder="https://calendly.com/your-name/30min"
                                        className="w-full px-3 py-2 text-sm border border-secondary-200 rounded-lg bg-white text-secondary-900 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                                    />
                                </div>
                            )}

                            <div className="flex justify-end">
                                <button
                                    onClick={saveMeetingBooking}
                                    disabled={savingMeeting || (meetingBookingEnabled && !calendlyUrl.trim())}
                                    className="py-2.5 px-5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    Save
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── Business Hours ───────────────────────────────────────────── */}
            {showBotConfig && (
                <div className="bg-white p-6 rounded-2xl border border-secondary-200 shadow-sm">
                    <div className="flex items-start justify-between gap-4 mb-1">
                        <div>
                            <h2 className="text-base font-semibold text-secondary-900">Business Hours</h2>
                            <p className="text-sm text-secondary-500 mt-1">
                                When enabled, visitors outside your hours will see an offline form instead of live chat.
                            </p>
                        </div>
                        {savingHours && <Loader2 size={14} className="animate-spin text-secondary-400 flex-shrink-0 mt-1" />}
                    </div>

                    {loadingBot ? (
                        <div className="flex items-center gap-2 text-secondary-400 text-sm py-2 mt-4">
                            <Loader2 size={14} className="animate-spin" />
                            Loading settings…
                        </div>
                    ) : (
                        <div className="mt-5 space-y-5">
                            {/* Master enable toggle */}
                            <div className="flex items-center justify-between">
                                <span className="text-sm font-medium text-secondary-800">Enable business hours</span>
                                <Toggle
                                    checked={businessHours.enabled}
                                    onChange={(v) =>
                                        updateBusinessHours((prev) => ({ ...prev, enabled: v }))
                                    }
                                />
                            </div>

                            {businessHours.enabled && (
                                <>
                                    {/* Timezone */}
                                    <div className="flex items-center justify-between gap-4">
                                        <label className="text-sm text-secondary-700 flex-shrink-0">Timezone</label>
                                        <select
                                            value={businessHours.timezone}
                                            onChange={(e) =>
                                                updateBusinessHours((prev) => ({ ...prev, timezone: e.target.value }))
                                            }
                                            className="text-sm border border-secondary-200 rounded-lg px-3 py-1.5 bg-white text-secondary-900 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 max-w-xs"
                                        >
                                            {Intl.supportedValuesOf('timeZone').map((tz) => (
                                                <option key={tz} value={tz}>{tz}</option>
                                            ))}
                                        </select>
                                    </div>

                                    {/* Day rows */}
                                    <div className="divide-y divide-secondary-100 border border-secondary-100 rounded-xl overflow-hidden">
                                        {DAYS.map(({ key, label }) => {
                                            const day = businessHours.days?.[key] || { enabled: false, start: '09:00', end: '17:00' };
                                            return (
                                                <div key={key} className="flex items-center gap-3 px-4 py-3 bg-white">
                                                    <Toggle
                                                        id={`bh-${key}`}
                                                        checked={day.enabled}
                                                        onChange={(v) =>
                                                            updateBusinessHours((prev) => ({
                                                                ...prev,
                                                                days: {
                                                                    ...prev.days,
                                                                    [key]: { ...day, enabled: v },
                                                                },
                                                            }))
                                                        }
                                                    />
                                                    <label htmlFor={`bh-${key}`} className="text-sm text-secondary-700 w-24 flex-shrink-0 cursor-pointer">
                                                        {label}
                                                    </label>
                                                    {day.enabled ? (
                                                        <div className="flex items-center gap-2 ml-auto">
                                                            <input
                                                                type="time"
                                                                value={day.start}
                                                                onChange={(e) =>
                                                                    updateBusinessHours((prev) => ({
                                                                        ...prev,
                                                                        days: {
                                                                            ...prev.days,
                                                                            [key]: { ...day, start: e.target.value },
                                                                        },
                                                                    }))
                                                                }
                                                                className="text-xs border border-secondary-200 rounded-lg px-2 py-1 bg-white text-secondary-900 focus:outline-none focus:ring-1 focus:ring-primary-500/30"
                                                            />
                                                            <span className="text-secondary-400 text-xs">to</span>
                                                            <input
                                                                type="time"
                                                                value={day.end}
                                                                onChange={(e) =>
                                                                    updateBusinessHours((prev) => ({
                                                                        ...prev,
                                                                        days: {
                                                                            ...prev.days,
                                                                            [key]: { ...day, end: e.target.value },
                                                                        },
                                                                    }))
                                                                }
                                                                className="text-xs border border-secondary-200 rounded-lg px-2 py-1 bg-white text-secondary-900 focus:outline-none focus:ring-1 focus:ring-primary-500/30"
                                                            />
                                                        </div>
                                                    ) : (
                                                        <span className="ml-auto text-xs text-secondary-400">Closed</span>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>

                                    <p className="text-xs text-secondary-400">
                                        Outside of business hours, visitors will see an offline form to leave a message.
                                    </p>
                                </>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* ── Account Info ─────────────────────────────────────────────── */}
            <div className="bg-white p-6 rounded-2xl border border-secondary-200 shadow-sm">
                <h2 className="text-base font-semibold text-secondary-900 mb-1">Account</h2>
                <p className="text-sm text-secondary-500 mb-4">Your account information</p>

                <div className="space-y-3">
                    <div className="flex items-center justify-between py-2">
                        <span className="text-sm text-secondary-500">Name</span>
                        <span className="text-sm font-medium text-secondary-900">{localStorage.getItem('admin_name') || '—'}</span>
                    </div>
                    <div className="border-t border-secondary-100" />
                    {isOperator ? (
                        <>
                            <div className="flex items-center justify-between py-2">
                                <span className="text-sm text-secondary-500">Operator ID</span>
                                <span className="text-sm font-mono text-secondary-400">{localStorage.getItem('operator_id') || '—'}</span>
                            </div>
                            <div className="border-t border-secondary-100" />
                            <div className="flex items-center justify-between py-2">
                                <span className="text-sm text-secondary-500">Role</span>
                                <span className="text-sm font-medium text-secondary-900 capitalize">{operatorRole || '—'}</span>
                            </div>
                        </>
                    ) : (
                        <div className="flex items-center justify-between py-2">
                            <span className="text-sm text-secondary-500">Client ID</span>
                            <span className="text-sm font-mono text-secondary-400">{localStorage.getItem('admin_client_id') || '—'}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* ── Feedback ─────────────────────────────────────────────────── */}
            <div className="bg-white p-6 rounded-2xl border border-secondary-200 shadow-sm">
                <h2 className="text-base font-semibold text-secondary-900 mb-1 flex items-center gap-2">
                    <MessageSquareWarning size={16} className="text-primary-600" />
                    Send Feedback
                </h2>
                <p className="text-sm text-secondary-500 mb-4">
                    Have a suggestion or found a bug? Let us know at{' '}
                    <a href="mailto:developer@oyechats.com" className="font-medium text-primary-600 hover:underline">developer@oyechats.com</a>
                </p>

                <form onSubmit={handleSendFeedback} className="space-y-4">
                    <textarea
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                        className="w-full px-4 py-3 rounded-xl border border-secondary-200 bg-white text-secondary-900 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all resize-none h-28 text-sm"
                        placeholder="Describe your issue or feature request..."
                    />
                    <button
                        type="submit"
                        disabled={!feedback.trim()}
                        className="py-2.5 px-5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Send Feedback
                    </button>
                </form>
            </div>
        </div>
    );
}

// ─── Flag Toggle Row ──────────────────────────────────────────────────────────

function FlagRow({ icon, label, description, value, saving, onChange }) {
    return (
        <div className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
            <div className="flex items-start gap-3 min-w-0">
                <span className="mt-0.5 text-secondary-400 flex-shrink-0">{icon}</span>
                <div>
                    <p className="text-sm font-medium text-secondary-800">{label}</p>
                    <p className="text-xs text-secondary-500 mt-0.5">{description}</p>
                </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
                {saving && <Loader2 size={13} className="animate-spin text-secondary-400" />}
                <Toggle checked={value} onChange={onChange} disabled={saving} />
            </div>
        </div>
    );
}
