import { useState, useEffect, useCallback } from 'react';
import {
    MessageSquareWarning, Paperclip, Star, Award, AlignLeft, Clock, Mail, Loader2,
    Sparkles, KeyRound, Eye, EyeOff, Check, Sun, Moon, Monitor, Palette,
    Inbox, X, Lock,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useToast } from '../context/ToastContext';
import { useTheme } from '../context/ThemeContext';
import PageHeader from '../components/ui/PageHeader';
import { getAuthState } from '../utils/auth';
import { updateBot, operatorChangePassword } from '../services/api';
import { useBotContext } from '../context/BotContext';
import useEntitlements from '../hooks/useEntitlements';
import { useUpgradeModal } from '../context/UpgradeModalContext';

const THEME_OPTIONS = [
    { id: 'system', label: 'System', description: 'Match your device setting', icon: Monitor },
    { id: 'light', label: 'Light', description: 'Always use the light theme', icon: Sun },
    { id: 'dark', label: 'Dark', description: 'Always use the dark theme', icon: Moon },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

const DEFAULT_FLAGS = {
    file_sharing: false,
    post_chat_rating: true,
    show_branding: true,
    queue_position: false,
    typing_preview: true,
    email_transcript: false,
};

// Flags that the Free plan pins to specific values. The Widget Behavior
// section is fully locked on Free, so these are the effective values the
// widget runs with regardless of what's stored on the bot. Mirrored by the
// backend in `get_bot_settings_public` so the widget actually behaves this
// way, not just the admin UI.
const FREE_PLAN_LOCKED_FLAGS = {
    file_sharing: false,
    post_chat_rating: false,
    show_branding: true,
    queue_position: false,
    typing_preview: false,
    email_transcript: false,
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
            className={cn(
                'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-surface-900',
                'disabled:cursor-not-allowed disabled:opacity-50',
                checked ? 'bg-primary-600' : 'bg-surface-300 dark:bg-surface-700'
            )}
        >
            <span
                aria-hidden="true"
                className={cn(
                    'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
                    checked ? 'translate-x-4' : 'translate-x-0'
                )}
            />
        </button>
    );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function Settings() {
    const { showToast } = useToast();
    const { mode: themeMode, setMode: setThemeMode } = useTheme();
    const { isOperator, operatorRole, isBotManager } = getAuthState();
    const { selectedBot, loading: botsLoading } = useBotContext();
    const { entitlements } = useEntitlements();
    const { requestUpgrade } = useUpgradeModal();
    // Plan-tier gating for the Widget Behavior section.
    //   Free → whole section locked; show_branding pinned ON.
    //   Starter → only show_branding pinned ON (branding_removable=false).
    //   Standard / Enterprise → fully interactive.
    const widgetBehaviorLocked = entitlements.isFree;
    const brandingLocked = !entitlements.hasFeature('branding_removable');
    const [feedback, setFeedback] = useState('');

    // Operator password change
    const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
    const [pwShow, setPwShow] = useState({ current: false, next: false });
    const [pwSaving, setPwSaving] = useState(false);
    const [pwError, setPwError] = useState('');
    const [pwSuccess, setPwSuccess] = useState(false);

    const handleChangePassword = async (e) => {
        e.preventDefault();
        setPwError('');
        setPwSuccess(false);
        if (pwForm.next !== pwForm.confirm) { setPwError('New passwords do not match.'); return; }
        if (pwForm.next.length < 8) { setPwError('New password must be at least 8 characters.'); return; }
        setPwSaving(true);
        try {
            await operatorChangePassword(pwForm.current, pwForm.next);
            setPwSuccess(true);
            setPwForm({ current: '', next: '', confirm: '' });
            showToast('success', 'Password changed successfully');
        } catch (err) {
            setPwError(err.message || 'Failed to change password');
        } finally {
            setPwSaving(false);
        }
    };

    // Bot data
    const [botId, setBotId] = useState(null);
    const [flags, setFlags] = useState(DEFAULT_FLAGS);
    const [loadingBot, setLoadingBot] = useState(true);

    // Live chat queue/routing settings — backed by columns added in the
    // b1f2a3c4d5e6 migration. Defaults match the migration's server_default
    // so the UI stays consistent for bots created before this section
    // shipped.
    const [queueTimeoutSeconds, setQueueTimeoutSeconds] = useState(20);
    const [maxQueueSize, setMaxQueueSize] = useState(10);
    const [savingQueueCfg, setSavingQueueCfg] = useState(false);

    // Tone & Personality
    const [brandTone, setBrandTone] = useState('');
    const [companyName, setCompanyName] = useState('');
    const [companyDescription, setCompanyDescription] = useState('');
    const [systemPrompt, setSystemPrompt] = useState('');
    const [savingTone, setSavingTone] = useState(false);

    // Visitor Messages — the always-available offline-form config. Free
    // plans don't get the Live Chat appearance tab OR the Integrations page,
    // so this card is their ONLY surface for setting where offline messages
    // get delivered AND where visitor email replies route. Paid users see
    // the same fields here AND in Appearance → Live Chat / Integrations →
    // Email (all paths write to the same bot columns, so they stay in sync).
    const [visitorMessagesEnabled, setVisitorMessagesEnabled] = useState(true);
    const [offlineMessage, setOfflineMessage] = useState(
        "We'll be right back! Leave a message and we'll follow up shortly.",
    );
    const [notificationEmails, setNotificationEmails] = useState([]);
    const [notifEmailInput, setNotifEmailInput] = useState('');
    // Single reply-to address — distinct from notification recipients above:
    // notifications go OUT to those addresses; this is where visitor REPLIES
    // come back to. Mirrors the Integrations → Email "Reply-To" field.
    const [replyToEmail, setReplyToEmail] = useState('');
    const [savingVisitorMessages, setSavingVisitorMessages] = useState(false);

    // Saving state: key → true while in-flight
    const [saving, setSaving] = useState({});

    // Sync from selected bot in BotContext
    useEffect(() => {
        if (botsLoading) return;
        if (!selectedBot) {
            setLoadingBot(false);
            return;
        }
        setBotId(selectedBot.id);
        setFlags({ ...DEFAULT_FLAGS, ...(selectedBot.feature_flags || {}) });
        setBrandTone(selectedBot.brand_tone || '');
        setCompanyName(selectedBot.company_name || '');
        setCompanyDescription(selectedBot.company_description || '');
        setSystemPrompt(selectedBot.system_prompt || '');
        if (typeof selectedBot.live_chat_queue_timeout_seconds === 'number') {
            setQueueTimeoutSeconds(selectedBot.live_chat_queue_timeout_seconds);
        }
        if (typeof selectedBot.live_chat_max_queue_size === 'number') {
            setMaxQueueSize(selectedBot.live_chat_max_queue_size);
        }
        // Visitor messages — bot.live_chat_enabled is the toggle that decides
        // whether the widget surfaces a "Talk to us" / "Leave a message" CTA
        // at all. For Free users this gates the offline form path because no
        // live operators ever come online. Default to ENABLED so newly-created
        // Free workspaces can receive visitor messages out of the box.
        setVisitorMessagesEnabled(selectedBot.live_chat_enabled ?? true);
        setOfflineMessage(
            selectedBot.offline_message
            || "We'll be right back! Leave a message and we'll follow up shortly.",
        );
        // notification_emails is JSONB shaped `{ default: [...] }`; fall back
        // to the legacy single-string `notification_email` field for bots
        // created before the multi-email column was added.
        const multi = selectedBot.notification_emails?.default;
        if (Array.isArray(multi) && multi.length) {
            setNotificationEmails(multi);
        } else if (selectedBot.notification_email) {
            setNotificationEmails([selectedBot.notification_email]);
        } else {
            setNotificationEmails([]);
        }
        setReplyToEmail(selectedBot.reply_to_email || '');
        setLoadingBot(false);
    }, [selectedBot, botsLoading]);

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

    // Persist a single live-chat queue setting. Optimistic UI: caller updates
    // local state first, this method commits and shows a toast on failure
    // (reverting is the caller's responsibility — kept simple because there
    // are only two fields and a network failure is rare).
    const saveQueueSetting = useCallback(async (patch) => {
        if (!botId) return;
        setSavingQueueCfg(true);
        try {
            await updateBot(botId, patch);
        } catch {
            showToast('error', 'Failed to save live chat setting.');
        } finally {
            setSavingQueueCfg(false);
        }
        // showToast is stable — intentionally omitted
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [botId]);

    // Persist the visitor-messages bundle. Combines the toggle, the
    // offline-message body, and the notification-email chips into a single
    // PATCH so the API call count stays predictable. Both legacy keys
    // (`notification_email`) and the new shape are written for backend
    // compatibility — matches the convention used in Interface.jsx.
    const saveVisitorMessages = useCallback(async () => {
        if (!botId) return;
        setSavingVisitorMessages(true);
        try {
            // Commit any unsubmitted chip text so users don't lose what's in
            // the input when they click Save.
            const pendingEmail = notifEmailInput.trim();
            const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
            let emails = notificationEmails;
            if (pendingEmail && isValidEmail(pendingEmail) && !emails.includes(pendingEmail)) {
                emails = [...emails, pendingEmail];
                setNotificationEmails(emails);
                setNotifEmailInput('');
            }
            const trimmedReplyTo = replyToEmail.trim();
            if (trimmedReplyTo && !isValidEmail(trimmedReplyTo)) {
                showToast('error', 'Reply-to must be a valid email address.');
                setSavingVisitorMessages(false);
                return;
            }
            await updateBot(botId, {
                live_chat_enabled: visitorMessagesEnabled,
                offline_message: offlineMessage,
                notification_email: emails[0] || null,
                notification_emails: emails.length > 0 ? { default: emails } : null,
                reply_to_email: trimmedReplyTo || null,
            });
            showToast('success', 'Visitor messages saved.');
        } catch {
            showToast('error', 'Failed to save visitor messages.');
        } finally {
            setSavingVisitorMessages(false);
        }
        // showToast is stable — intentionally omitted
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [botId, visitorMessagesEnabled, offlineMessage, notificationEmails, notifEmailInput, replyToEmail]);

    // Save tone & personality settings
    const saveToneSettings = useCallback(async () => {
        if (!botId) return;
        setSavingTone(true);
        try {
            await updateBot(botId, {
                brand_tone: brandTone || null,
                company_name: companyName || null,
                company_description: companyDescription || null,
                system_prompt: systemPrompt || null,
            });
            showToast('success', 'Tone settings saved.');
        } catch {
            showToast('error', 'Failed to save tone settings.');
        } finally {
            setSavingTone(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [botId, brandTone, companyName, companyDescription, systemPrompt]);

    const handleSendFeedback = (e) => {
        e.preventDefault();
        if (!feedback.trim()) return;
        showToast('success', 'Your feedback has been recorded!');
        setFeedback('');
    };

    // Only show bot-config sections to client/bot-manager accounts
    const showBotConfig = !isOperator || isBotManager;

    // Free plans display the locked feature-flag values regardless of what's
    // stored on the bot — the section is fully locked so the stored values
    // can be stale (e.g. left over from a previous paid tier). The backend
    // mirrors this override when serving bot settings to the widget.
    const effectiveFlags = widgetBehaviorLocked
        ? { ...flags, ...FREE_PLAN_LOCKED_FLAGS }
        : flags;

    return (
        <div className="space-y-6 animate-fade-in max-w-3xl">
            <PageHeader title="Settings" subtitle="Preferences and account" />

            {/* ── Appearance ───────────────────────────────────────────────── */}
            <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50 mb-1 flex items-center gap-2">
                    <Palette size={16} className="text-primary-600 dark:text-primary-400" />
                    Appearance
                </h2>
                <p className="text-sm text-surface-500 dark:text-surface-400 mb-5">
                    Choose how the admin dashboard looks. Affects this device only.
                </p>

                <div
                    role="radiogroup"
                    aria-label="Theme"
                    className="grid grid-cols-1 sm:grid-cols-3 gap-3"
                >
                    {THEME_OPTIONS.map((option) => {
                        const { id, label, description } = option;
                        const Icon = option.icon;
                        const selected = themeMode === id;
                        return (
                            <button
                                key={id}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                onClick={() => setThemeMode(id)}
                                className={cn(
                                    'group relative text-left p-4 rounded-xl border transition-all',
                                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-surface-900',
                                    selected
                                        ? 'border-primary-500 bg-primary-50/60 dark:bg-primary-500/10 ring-1 ring-primary-500/30'
                                        : 'border-surface-200 dark:border-surface-700 hover:border-primary-300 dark:hover:border-primary-500/40 hover:bg-surface-50 dark:hover:bg-surface-800/60'
                                )}
                            >
                                <div className="flex items-center justify-between">
                                    <span
                                        className={cn(
                                            'inline-flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
                                            selected
                                                ? 'bg-primary-600 text-white'
                                                : 'bg-surface-100 dark:bg-surface-800 text-surface-600 dark:text-surface-300 group-hover:text-primary-600 dark:group-hover:text-primary-400'
                                        )}
                                    >
                                        <Icon size={16} />
                                    </span>
                                    {selected && (
                                        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary-600 text-white">
                                            <Check size={12} />
                                        </span>
                                    )}
                                </div>
                                <p className="mt-3 text-sm font-medium text-surface-900 dark:text-surface-50">{label}</p>
                                <p className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">{description}</p>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* ── Widget Behavior ──────────────────────────────────────────── */}
            {showBotConfig && (
                <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                    <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50 mb-1">Widget Behavior</h2>
                    <p className="text-sm text-surface-500 dark:text-surface-400 mb-5">
                        Control which features are available to your visitors and operators.
                    </p>

                    {widgetBehaviorLocked && (
                        <button
                            type="button"
                            onClick={() => requestUpgrade('widget_behavior')}
                            className="w-full mb-5 flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/40 text-left hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                        >
                            <span className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-300">
                                <Lock size={13} className="text-surface-400 dark:text-surface-500 flex-shrink-0" />
                                Locked on the {entitlements.planName || 'Free'} plan
                            </span>
                            <span className="text-sm font-medium text-indigo-600 dark:text-indigo-400">Upgrade</span>
                        </button>
                    )}
                    {!widgetBehaviorLocked && brandingLocked && (
                        <button
                            type="button"
                            onClick={() => requestUpgrade('branding_removable')}
                            className="w-full mb-5 flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/40 text-left hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                        >
                            <span className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-300">
                                <Lock size={13} className="text-surface-400 dark:text-surface-500 flex-shrink-0" />
                                Branding required on the {entitlements.planName || 'Starter'} plan
                            </span>
                            <span className="text-sm font-medium text-indigo-600 dark:text-indigo-400">Upgrade</span>
                        </button>
                    )}

                    {loadingBot ? (
                        <div className="flex items-center gap-2 text-surface-400 dark:text-surface-500 text-sm py-2">
                            <Loader2 size={14} className="animate-spin" />
                            Loading settings…
                        </div>
                    ) : (
                        <div className="divide-y divide-surface-100 dark:divide-surface-800">
                            <FlagRow
                                icon={<Paperclip size={15} />}
                                label="File Sharing in Live Chat"
                                description="Allow visitors and operators to share images and files (max 10 MB) during live human chat sessions."
                                value={effectiveFlags.file_sharing}
                                saving={saving.file_sharing}
                                onChange={(v) => toggleFlag('file_sharing', v)}
                                locked={widgetBehaviorLocked}
                                onLockedClick={() => requestUpgrade('widget_behavior')}
                            />
                            <FlagRow
                                icon={<Star size={15} />}
                                label="Post-Chat Rating Survey"
                                description="Show a 1–5 star satisfaction survey to visitors after a live chat session ends."
                                value={effectiveFlags.post_chat_rating}
                                saving={saving.post_chat_rating}
                                onChange={(v) => toggleFlag('post_chat_rating', v)}
                                locked={widgetBehaviorLocked}
                                onLockedClick={() => requestUpgrade('widget_behavior')}
                            />
                            <FlagRow
                                icon={<Award size={15} />}
                                label='Show "Powered by OyeChats" Branding'
                                description={
                                    brandingLocked
                                        ? `The OyeChats branding badge stays on for your ${entitlements.planName || 'current'} plan. Upgrade to Standard to remove it.`
                                        : 'Display the OyeChats branding badge at the bottom of the chat widget.'
                                }
                                value={brandingLocked ? true : effectiveFlags.show_branding}
                                saving={saving.show_branding}
                                onChange={(v) => toggleFlag('show_branding', v)}
                                locked={brandingLocked}
                                onLockedClick={() => requestUpgrade('branding_removable')}
                            />
                            <FlagRow
                                icon={<AlignLeft size={15} />}
                                label="Queue Position Indicator"
                                description="Show visitors their position in the queue while waiting for a live operator."
                                value={effectiveFlags.queue_position}
                                saving={saving.queue_position}
                                onChange={(v) => toggleFlag('queue_position', v)}
                                locked={widgetBehaviorLocked}
                                onLockedClick={() => requestUpgrade('widget_behavior')}
                            />
                            <FlagRow
                                icon={<Clock size={15} />}
                                label="Typing Preview"
                                description="Let operators see what the visitor is typing before they hit send (and vice versa)."
                                value={effectiveFlags.typing_preview}
                                saving={saving.typing_preview}
                                onChange={(v) => toggleFlag('typing_preview', v)}
                                locked={widgetBehaviorLocked}
                                onLockedClick={() => requestUpgrade('widget_behavior')}
                            />
                            <FlagRow
                                icon={<Mail size={15} />}
                                label="Email Chat Transcript"
                                description="Allow visitors to request a copy of their chat conversation by email."
                                value={effectiveFlags.email_transcript}
                                saving={saving.email_transcript}
                                onChange={(v) => toggleFlag('email_transcript', v)}
                                locked={widgetBehaviorLocked}
                                onLockedClick={() => requestUpgrade('widget_behavior')}
                            />
                        </div>
                    )}
                </div>
            )}

            {/* ── Visitor Messages ─────────────────────────────────────────
                The single source of truth for the offline-form configuration.
                Always available regardless of plan — Free workspaces rely on
                this card because their Appearance → Live Chat tab is hidden.
                For paid users the same fields also appear in Appearance with
                more controls; both write to the same Bot columns. */}
            {showBotConfig && (
                <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                    <div className="flex items-center gap-2 mb-1">
                        <Inbox size={16} className="text-primary-600 dark:text-primary-400" />
                        <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50">Visitor Messages</h2>
                    </div>
                    <p className="text-sm text-surface-500 dark:text-surface-400 mb-5">
                        Let visitors leave a message when there&apos;s no one to chat live. Submissions land in <strong className="font-semibold text-surface-700 dark:text-surface-300">Support → Messages</strong> and are emailed to the addresses below.
                    </p>

                    {loadingBot ? (
                        <div className="flex items-center gap-2 text-surface-400 dark:text-surface-500 text-sm py-2">
                            <Loader2 size={14} className="animate-spin" />
                            Loading settings…
                        </div>
                    ) : (
                        <div className="space-y-5">
                            {/* Master toggle */}
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <label htmlFor="visitor-messages-toggle" className="text-sm font-medium text-surface-800 dark:text-surface-200 block">
                                        Show &ldquo;Leave a message&rdquo; in the widget
                                    </label>
                                    <p className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">
                                        Visitors get a contact form whenever no operator is available.
                                    </p>
                                </div>
                                <Toggle
                                    id="visitor-messages-toggle"
                                    checked={visitorMessagesEnabled}
                                    onChange={setVisitorMessagesEnabled}
                                />
                            </div>

                            {/* Offline message text */}
                            <div>
                                <label className="text-sm font-medium text-surface-800 dark:text-surface-200 mb-2 block">
                                    Offline message
                                </label>
                                <textarea
                                    value={offlineMessage}
                                    onChange={(e) => setOfflineMessage(e.target.value)}
                                    maxLength={240}
                                    rows={2}
                                    placeholder="We'll be right back! Leave a message and we'll follow up shortly."
                                    className={cn(
                                        'w-full px-4 py-3 rounded-xl border border-surface-200 dark:border-surface-600',
                                        'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                        'placeholder:text-surface-400 dark:placeholder:text-surface-500',
                                        'focus:ring-2 focus:ring-primary-500/20 dark:focus:ring-primary-500/30 focus:border-primary-500',
                                        'outline-none transition-all resize-none text-sm',
                                    )}
                                />
                                <p className="text-xs text-surface-400 dark:text-surface-500 mt-1.5">
                                    Shown above the message form so visitors know what to expect.
                                </p>
                            </div>

                            {/* Reply-to email — where visitor replies land */}
                            <div>
                                <label htmlFor="settings-reply-to-input" className="text-sm font-medium text-surface-800 dark:text-surface-200 mb-2 block">
                                    Reply-to email
                                </label>
                                <input
                                    id="settings-reply-to-input"
                                    type="email"
                                    value={replyToEmail}
                                    onChange={(e) => setReplyToEmail(e.target.value)}
                                    placeholder="support@yourdomain.com"
                                    className={cn(
                                        'w-full px-4 py-2.5 rounded-xl border border-surface-200 dark:border-surface-600',
                                        'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                        'placeholder:text-surface-400 dark:placeholder:text-surface-500',
                                        'focus:ring-2 focus:ring-primary-500/20 dark:focus:ring-primary-500/30 focus:border-primary-500',
                                        'outline-none transition-all text-sm',
                                    )}
                                />
                                <p className="text-xs text-surface-400 dark:text-surface-500 mt-1.5">
                                    Visitors get notification emails from <span className="font-mono">notifications@oyechats.com</span>; their replies route here.
                                </p>
                            </div>

                            {/* Notification emails — chip input */}
                            <div>
                                <label className="text-sm font-medium text-surface-800 dark:text-surface-200 mb-2 block">
                                    Notify these email addresses
                                </label>
                                <div
                                    className={cn(
                                        'min-h-[44px] flex flex-wrap items-center gap-1.5 px-3 py-2 rounded-xl border border-surface-200 dark:border-surface-600',
                                        'bg-white dark:bg-surface-800 focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/20',
                                        'transition-all',
                                    )}
                                    onClick={() => document.getElementById('settings-notif-email-input')?.focus()}
                                    role="presentation"
                                >
                                    {notificationEmails.map((email) => (
                                        <span
                                            key={email}
                                            className="inline-flex items-center gap-1 px-2 py-1 bg-primary-50 dark:bg-primary-500/15 text-primary-700 dark:text-primary-300 text-xs rounded-md font-medium"
                                        >
                                            <span className="truncate max-w-[200px]">{email}</span>
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setNotificationEmails((prev) => prev.filter((x) => x !== email));
                                                }}
                                                className="flex-shrink-0 ml-0.5 p-0.5 rounded hover:bg-primary-200 dark:hover:bg-primary-500/30 transition-colors"
                                                aria-label={`Remove ${email}`}
                                            >
                                                <X size={10} />
                                            </button>
                                        </span>
                                    ))}
                                    <input
                                        id="settings-notif-email-input"
                                        type="email"
                                        value={notifEmailInput}
                                        onChange={(e) => setNotifEmailInput(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ',') {
                                                e.preventDefault();
                                                const val = notifEmailInput.trim().replace(/,$/, '');
                                                if (val && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val) && !notificationEmails.includes(val)) {
                                                    setNotificationEmails((prev) => [...prev, val]);
                                                    setNotifEmailInput('');
                                                }
                                            } else if (e.key === 'Backspace' && !notifEmailInput && notificationEmails.length > 0) {
                                                setNotificationEmails((prev) => prev.slice(0, -1));
                                            }
                                        }}
                                        onBlur={() => {
                                            const val = notifEmailInput.trim();
                                            if (val && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val) && !notificationEmails.includes(val)) {
                                                setNotificationEmails((prev) => [...prev, val]);
                                                setNotifEmailInput('');
                                            }
                                        }}
                                        placeholder={notificationEmails.length === 0 ? 'sales@yourcompany.com' : 'Add another…'}
                                        className="flex-1 min-w-[160px] text-sm text-surface-700 dark:text-surface-200 bg-transparent outline-none placeholder:text-surface-400 dark:placeholder:text-surface-500 py-0.5"
                                    />
                                </div>
                                <p className="text-xs text-surface-400 dark:text-surface-500 mt-1.5">
                                    Press Enter or comma to add. Leave empty to skip email notifications and only collect messages in the inbox.
                                </p>
                            </div>

                            <button
                                type="button"
                                onClick={saveVisitorMessages}
                                disabled={savingVisitorMessages}
                                className="py-2.5 px-5 bg-primary-600 hover:bg-primary-700 dark:bg-primary-600 dark:hover:bg-primary-500 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                            >
                                {savingVisitorMessages ? (
                                    <>
                                        <Loader2 size={14} className="animate-spin" />
                                        Saving…
                                    </>
                                ) : (
                                    <>
                                        <Check size={14} />
                                        Save Visitor Messages
                                    </>
                                )}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* ── Tone & Personality ──────────────────────────────────────── */}
            {showBotConfig && (
                <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                    <div className="flex items-center gap-2 mb-1">
                        <Sparkles size={16} className="text-primary-600 dark:text-primary-400" />
                        <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50">Tone & Personality</h2>
                    </div>
                    <p className="text-sm text-surface-500 dark:text-surface-400 mb-5">
                        Control how your AI assistant communicates. Brand tone is auto-detected when you crawl your website.
                    </p>

                    {loadingBot ? (
                        <div className="flex items-center gap-2 text-surface-400 dark:text-surface-500 text-sm py-2">
                            <Loader2 size={14} className="animate-spin" />
                            Loading settings…
                        </div>
                    ) : (
                        <div className="space-y-5">
                            {/* Brand Tone */}
                            <div>
                                <label className="text-sm font-medium text-surface-800 dark:text-surface-200 flex items-center gap-2 mb-2">
                                    Brand Tone
                                    {brandTone && (
                                        <span className="text-xs font-normal text-primary-600 dark:text-primary-400 flex items-center gap-1">
                                            <Sparkles size={10} />
                                            Auto-detected
                                        </span>
                                    )}
                                </label>
                                <textarea
                                    value={brandTone}
                                    onChange={(e) => setBrandTone(e.target.value)}
                                    className={cn(
                                        'w-full px-4 py-3 rounded-xl border border-surface-200 dark:border-surface-600',
                                        'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                        'placeholder:text-surface-400 dark:placeholder:text-surface-500',
                                        'focus:ring-2 focus:ring-primary-500/20 dark:focus:ring-primary-500/30 focus:border-primary-500',
                                        'outline-none transition-all resize-none h-20 text-sm'
                                    )}
                                    placeholder='e.g., "Professional and approachable. Uses simple language with a warm, helpful tone."'
                                />
                                <p className="text-xs text-surface-400 dark:text-surface-500 mt-1.5">
                                    Describes your brand&apos;s voice. Auto-filled when you crawl your website, or customize manually.
                                </p>
                            </div>

                            {/* Company Name */}
                            <div>
                                <label className="text-sm font-medium text-surface-800 dark:text-surface-200 flex items-center gap-2 mb-2">
                                    Company Name
                                    {companyName && (
                                        <span className="text-xs font-normal text-primary-600 dark:text-primary-400 flex items-center gap-1">
                                            <Sparkles size={10} />
                                            Auto-detected
                                        </span>
                                    )}
                                </label>
                                <input
                                    type="text"
                                    value={companyName}
                                    onChange={(e) => setCompanyName(e.target.value)}
                                    className={cn(
                                        'w-full px-4 py-3 rounded-xl border border-surface-200 dark:border-surface-600',
                                        'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                        'placeholder:text-surface-400 dark:placeholder:text-surface-500',
                                        'focus:ring-2 focus:ring-primary-500/20 dark:focus:ring-primary-500/30 focus:border-primary-500',
                                        'outline-none transition-all text-sm'
                                    )}
                                    placeholder='e.g., "Fynix Digital"'
                                />
                                <p className="text-xs text-surface-400 dark:text-surface-500 mt-1.5">
                                    Your official company/brand name. Auto-filled when you crawl your website. The chatbot uses this to identify your company.
                                </p>
                            </div>

                            {/* Company Description */}
                            <div>
                                <label className="text-sm font-medium text-surface-800 dark:text-surface-200 flex items-center gap-2 mb-2">
                                    Company Description
                                    {companyDescription && (
                                        <span className="text-xs font-normal text-primary-600 dark:text-primary-400 flex items-center gap-1">
                                            <Sparkles size={10} />
                                            Auto-detected
                                        </span>
                                    )}
                                </label>
                                <textarea
                                    value={companyDescription}
                                    onChange={(e) => setCompanyDescription(e.target.value)}
                                    className={cn(
                                        'w-full px-4 py-3 rounded-xl border border-surface-200 dark:border-surface-600',
                                        'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                        'placeholder:text-surface-400 dark:placeholder:text-surface-500',
                                        'focus:ring-2 focus:ring-primary-500/20 dark:focus:ring-primary-500/30 focus:border-primary-500',
                                        'outline-none transition-all resize-none h-24 text-sm'
                                    )}
                                    placeholder='e.g., "Acme Corp is a digital marketing agency specializing in brand strategy, web design, and SEO for growing businesses."'
                                />
                                <p className="text-xs text-surface-400 dark:text-surface-500 mt-1.5">
                                    Describes your company. Auto-filled when you crawl your website. The chatbot uses this to answer &quot;What does your company do?&quot; questions.
                                </p>
                            </div>

                            {/* Custom Instructions */}
                            <div>
                                <label className="text-sm font-medium text-surface-800 dark:text-surface-200 mb-2 block">
                                    Custom Instructions
                                </label>
                                <textarea
                                    value={systemPrompt}
                                    onChange={(e) => setSystemPrompt(e.target.value)}
                                    className={cn(
                                        'w-full px-4 py-3 rounded-xl border border-surface-200 dark:border-surface-600',
                                        'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                        'placeholder:text-surface-400 dark:placeholder:text-surface-500',
                                        'focus:ring-2 focus:ring-primary-500/20 dark:focus:ring-primary-500/30 focus:border-primary-500',
                                        'outline-none transition-all resize-none h-28 text-sm'
                                    )}
                                    placeholder='e.g., "Always mention our free trial. Refer to our product as CloudSync. Avoid discussing competitor pricing."'
                                />
                                <p className="text-xs text-surface-400 dark:text-surface-500 mt-1.5">
                                    Additional rules your AI should follow. These override the default behavior.
                                </p>
                            </div>

                            <button
                                type="button"
                                onClick={saveToneSettings}
                                disabled={savingTone}
                                className="py-2.5 px-5 bg-primary-600 hover:bg-primary-700 dark:bg-primary-600 dark:hover:bg-primary-500 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                            >
                                {savingTone ? (
                                    <>
                                        <Loader2 size={14} className="animate-spin" />
                                        Saving…
                                    </>
                                ) : (
                                    'Save Tone Settings'
                                )}
                            </button>
                        </div>
                    )}
                </div>
            )}


            {/* ── Live Chat Queue ──────────────────────────────────────────── */}
            {showBotConfig && (
                <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                    <div className="flex items-start justify-between gap-4 mb-1">
                        <div>
                            <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                                <Clock size={16} className="text-primary-600 dark:text-primary-400" />
                                Live Chat Queue
                            </h2>
                            <p className="text-sm text-surface-500 dark:text-surface-400 mt-1">
                                How long visitors wait in queue before the offline form appears, and how many can wait at once.
                            </p>
                        </div>
                        {savingQueueCfg && <Loader2 size={14} className="animate-spin text-surface-400 dark:text-surface-500 flex-shrink-0 mt-1" />}
                    </div>

                    {loadingBot ? (
                        <div className="flex items-center gap-2 text-surface-400 dark:text-surface-500 text-sm py-2 mt-4">
                            <Loader2 size={14} className="animate-spin" />
                            Loading settings…
                        </div>
                    ) : (
                        <div className="mt-5 space-y-5">
                            {/* Queue wait timeout — the most impactful setting.
                                Drives the widget's auto-fallback to the offline
                                form. Tighter values feel snappy but frustrate
                                B2B visitors waiting for a considered answer;
                                longer values feel patient but lose impatient
                                ecommerce visitors. */}
                            <div className="flex items-center justify-between gap-4">
                                <div className="flex-1 min-w-0">
                                    <label htmlFor="queue-timeout" className="text-sm font-medium text-surface-800 dark:text-surface-200 block">
                                        Wait time before offline form
                                    </label>
                                    <p className="text-xs text-surface-400 dark:text-surface-500 mt-0.5">
                                        How long a visitor waits in the queue before they&apos;re offered the offline form.
                                    </p>
                                </div>
                                <select
                                    id="queue-timeout"
                                    value={queueTimeoutSeconds}
                                    onChange={(e) => {
                                        const v = Number(e.target.value);
                                        setQueueTimeoutSeconds(v);
                                        saveQueueSetting({ live_chat_queue_timeout_seconds: v });
                                    }}
                                    className={cn(
                                        'text-sm border border-surface-200 dark:border-surface-600 rounded-lg px-3 py-1.5',
                                        'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                        'focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:focus:ring-primary-500/30 focus:border-primary-500'
                                    )}
                                >
                                    <option value={15}>15 seconds (snappy)</option>
                                    <option value={20}>20 seconds (recommended)</option>
                                    <option value={30}>30 seconds</option>
                                    <option value={60}>60 seconds (patient)</option>
                                    <option value={90}>90 seconds (B2B)</option>
                                </select>
                            </div>

                            {/* Max queue size — reject queue entries past this
                                cap. Default 10 is a sensible "if you have
                                more than 10 waiting, you've got a staffing
                                issue not a tooling issue". */}
                            <div className="flex items-center justify-between gap-4">
                                <div className="flex-1 min-w-0">
                                    <label htmlFor="max-queue-size" className="text-sm font-medium text-surface-800 dark:text-surface-200 block">
                                        Maximum queue size
                                    </label>
                                    <p className="text-xs text-surface-400 dark:text-surface-500 mt-0.5">
                                        Visitors beyond this number see the offline form immediately.
                                    </p>
                                </div>
                                <input
                                    id="max-queue-size"
                                    type="number"
                                    min={1}
                                    max={100}
                                    value={maxQueueSize}
                                    onChange={(e) => setMaxQueueSize(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
                                    onBlur={() => saveQueueSetting({ live_chat_max_queue_size: maxQueueSize })}
                                    className={cn(
                                        'text-sm border border-surface-200 dark:border-surface-600 rounded-lg px-3 py-1.5 w-20 text-center',
                                        'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                        'focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:focus:ring-primary-500/30 focus:border-primary-500'
                                    )}
                                />
                            </div>

                            {/* Routing strategy — informational. We expose the
                                column but only "least_busy" is supported in
                                practice; the field is here for future tiers
                                that may want explicit round-robin. */}
                            <div className="rounded-lg bg-surface-50 dark:bg-surface-800/50 px-4 py-3 border border-surface-100 dark:border-surface-700">
                                <p className="text-xs text-surface-600 dark:text-surface-300">
                                    <strong className="text-surface-900 dark:text-surface-100">Routing:</strong>{' '}
                                    Least-busy. Chats go to the operator with the fewest active conversations,
                                    falling back to round-robin when operators are tied.
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── Account Info ─────────────────────────────────────────────── */}
            <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50 mb-1">Account</h2>
                <p className="text-sm text-surface-500 dark:text-surface-400 mb-4">Your account information</p>

                <div className="space-y-3">
                    <div className="flex items-center justify-between py-2">
                        <span className="text-sm text-surface-500 dark:text-surface-400">Name</span>
                        <span className="text-sm font-medium text-surface-900 dark:text-surface-50">{localStorage.getItem('admin_name') || '—'}</span>
                    </div>
                    <div className="border-t border-surface-100 dark:border-surface-800" />
                    {isOperator ? (
                        <>
                            <div className="flex items-center justify-between py-2">
                                <span className="text-sm text-surface-500 dark:text-surface-400">Operator ID</span>
                                <span className="text-sm font-mono text-surface-400 dark:text-surface-500">{localStorage.getItem('operator_id') || '—'}</span>
                            </div>
                            <div className="border-t border-surface-100 dark:border-surface-800" />
                            <div className="flex items-center justify-between py-2">
                                <span className="text-sm text-surface-500 dark:text-surface-400">Role</span>
                                <span className="text-sm font-medium text-surface-900 dark:text-surface-50 capitalize">{operatorRole || '—'}</span>
                            </div>
                        </>
                    ) : (
                        <div className="flex items-center justify-between py-2">
                            <span className="text-sm text-surface-500 dark:text-surface-400">Client ID</span>
                            <span className="text-sm font-mono text-surface-400 dark:text-surface-500">{localStorage.getItem('admin_client_id') || '—'}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* ── Change Password (operators only) ──────────────────────── */}
            {isOperator && (
                <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                    <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50 mb-1 flex items-center gap-2">
                        <KeyRound size={16} className="text-primary-600 dark:text-primary-400" />
                        Change Password
                    </h2>
                    <p className="text-sm text-surface-500 dark:text-surface-400 mb-4">
                        Update your login password. Must be at least 8 characters with a letter and a number.
                    </p>

                    {pwSuccess && (
                        <div className="flex items-center gap-2 p-3 mb-4 bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 rounded-xl text-sm text-emerald-700 dark:text-emerald-400">
                            <Check size={15} /> Password updated successfully.
                        </div>
                    )}
                    {pwError && (
                        <div className="p-3 mb-4 bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/20 rounded-xl text-sm text-rose-600 dark:text-rose-400">
                            {pwError}
                        </div>
                    )}

                    <form onSubmit={handleChangePassword} className="space-y-3">
                        {/* Current password */}
                        <div>
                            <label className="text-xs font-medium text-surface-500 dark:text-surface-400 mb-1 block">Current Password</label>
                            <div className="relative">
                                <input
                                    type={pwShow.current ? 'text' : 'password'}
                                    required
                                    value={pwForm.current}
                                    onChange={(e) => setPwForm(p => ({ ...p, current: e.target.value }))}
                                    placeholder="Your current password"
                                    className={cn(
                                        'w-full px-3 py-2 pr-10 rounded-xl border border-surface-200 dark:border-surface-600 text-sm',
                                        'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                        'placeholder:text-surface-400 dark:placeholder:text-surface-500',
                                        'focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all'
                                    )}
                                />
                                <button type="button" onClick={() => setPwShow(p => ({ ...p, current: !p.current }))}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300">
                                    {pwShow.current ? <EyeOff size={15} /> : <Eye size={15} />}
                                </button>
                            </div>
                        </div>

                        {/* New password */}
                        <div>
                            <label className="text-xs font-medium text-surface-500 dark:text-surface-400 mb-1 block">New Password</label>
                            <div className="relative">
                                <input
                                    type={pwShow.next ? 'text' : 'password'}
                                    required
                                    minLength={8}
                                    value={pwForm.next}
                                    onChange={(e) => setPwForm(p => ({ ...p, next: e.target.value }))}
                                    placeholder="At least 8 chars, letter + number"
                                    className={cn(
                                        'w-full px-3 py-2 pr-10 rounded-xl border border-surface-200 dark:border-surface-600 text-sm',
                                        'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                                        'placeholder:text-surface-400 dark:placeholder:text-surface-500',
                                        'focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all'
                                    )}
                                />
                                <button type="button" onClick={() => setPwShow(p => ({ ...p, next: !p.next }))}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:text-surface-500 dark:hover:text-surface-300">
                                    {pwShow.next ? <EyeOff size={15} /> : <Eye size={15} />}
                                </button>
                            </div>
                        </div>

                        {/* Confirm new password */}
                        <div>
                            <label className="text-xs font-medium text-surface-500 dark:text-surface-400 mb-1 block">Confirm New Password</label>
                            <input
                                type="password"
                                required
                                value={pwForm.confirm}
                                onChange={(e) => setPwForm(p => ({ ...p, confirm: e.target.value }))}
                                placeholder="Repeat new password"
                                className={cn(
                                    'w-full px-3 py-2 rounded-xl border text-sm transition-all outline-none',
                                    pwForm.confirm && pwForm.confirm !== pwForm.next
                                        ? 'border-rose-400 dark:border-rose-500 focus:ring-2 focus:ring-rose-500/20'
                                        : 'border-surface-200 dark:border-surface-600 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500',
                                    'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500'
                                )}
                            />
                            {pwForm.confirm && pwForm.confirm !== pwForm.next && (
                                <p className="text-xs text-rose-500 mt-1">Passwords do not match</p>
                            )}
                        </div>

                        <button
                            type="submit"
                            disabled={pwSaving || !pwForm.current || !pwForm.next || !pwForm.confirm}
                            className="flex items-center gap-2 py-2.5 px-5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {pwSaving ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
                            Change Password
                        </button>
                    </form>
                </div>
            )}

            {/* ── Feedback ─────────────────────────────────────────────────── */}
            <div className="bg-white dark:bg-surface-900 p-6 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm">
                <h2 className="text-base font-semibold text-surface-900 dark:text-surface-50 mb-1 flex items-center gap-2">
                    <MessageSquareWarning size={16} className="text-primary-600 dark:text-primary-400" />
                    Send Feedback
                </h2>
                <p className="text-sm text-surface-500 dark:text-surface-400 mb-4">
                    Have a suggestion or found a bug? Let us know at{' '}
                    <a href="mailto:support@oyechats.com" className="font-medium text-primary-600 dark:text-primary-400 hover:underline">support@oyechats.com</a>
                </p>

                <form onSubmit={handleSendFeedback} className="space-y-4">
                    <textarea
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                        className={cn(
                            'w-full px-4 py-3 rounded-xl border border-surface-200 dark:border-surface-600',
                            'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
                            'placeholder:text-surface-400 dark:placeholder:text-surface-500',
                            'focus:ring-2 focus:ring-primary-500/20 dark:focus:ring-primary-500/30 focus:border-primary-500',
                            'outline-none transition-all resize-none h-28 text-sm'
                        )}
                        placeholder="Describe your issue or feature request..."
                    />
                    <button
                        type="submit"
                        disabled={!feedback.trim()}
                        className="py-2.5 px-5 bg-primary-600 hover:bg-primary-700 dark:bg-primary-600 dark:hover:bg-primary-500 text-white text-sm font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Send Feedback
                    </button>
                </form>
            </div>
        </div>
    );
}

// ─── Flag Toggle Row ──────────────────────────────────────────────────────────

function FlagRow({ icon, label, description, value, saving, onChange, locked = false, onLockedClick }) {
    const handleToggle = (next) => {
        if (locked) {
            onLockedClick?.();
            return;
        }
        onChange(next);
    };
    return (
        <div
            className={cn(
                'flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0',
                locked && 'opacity-80',
            )}
        >
            <div className="flex items-start gap-3 min-w-0">
                <span className="mt-0.5 text-surface-400 dark:text-surface-500 flex-shrink-0">{icon}</span>
                <div className="min-w-0">
                    <p className="text-sm font-medium text-surface-800 dark:text-surface-200 flex items-center gap-1.5">
                        {label}
                        {locked && (
                            <Lock
                                size={12}
                                className="text-surface-400 dark:text-surface-500 flex-shrink-0"
                                aria-label="Locked — upgrade to change"
                            />
                        )}
                    </p>
                    <p className="text-xs text-surface-500 dark:text-surface-400 mt-0.5">{description}</p>
                </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
                {saving && !locked && <Loader2 size={13} className="animate-spin text-surface-400 dark:text-surface-500" />}
                <Toggle
                    checked={value}
                    onChange={handleToggle}
                    disabled={saving && !locked}
                />
            </div>
        </div>
    );
}
