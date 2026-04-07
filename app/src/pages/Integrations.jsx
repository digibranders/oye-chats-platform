import { useState, useEffect, useCallback, useRef } from 'react';
import { Mail, Webhook as WebhookIcon, Calendar, Loader2, Info, ChevronDown, ChevronRight, Check, X } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import Tabs from '../components/ui/Tabs';
import { useToast } from '../context/ToastContext';
import { getBots, updateBot } from '../services/api';
import Webhooks from './Webhooks';

// ─── Toggle ─────────────────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled = false }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
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

// ─── Email Chip Input ───────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function EmailChipInput({ emails, onChange, placeholder = 'Type email and press Enter' }) {
    const [inputValue, setInputValue] = useState('');
    const [error, setError] = useState('');
    const inputRef = useRef(null);

    const addEmail = (raw) => {
        const email = raw.trim().toLowerCase();
        if (!email) return;
        if (!EMAIL_RE.test(email)) {
            setError(`"${email}" is not a valid email`);
            return;
        }
        if (emails.includes(email)) {
            setError(`"${email}" is already added`);
            return;
        }
        setError('');
        onChange([...emails, email]);
        setInputValue('');
    };

    const removeEmail = (emailToRemove) => {
        onChange(emails.filter((e) => e !== emailToRemove));
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
            e.preventDefault();
            addEmail(inputValue);
        }
        if (e.key === 'Backspace' && !inputValue && emails.length > 0) {
            removeEmail(emails[emails.length - 1]);
        }
    };

    const handlePaste = (e) => {
        e.preventDefault();
        const pasted = e.clipboardData.getData('text');
        const parts = pasted.split(/[,;\s]+/).filter(Boolean);
        const valid = [];
        for (const part of parts) {
            const email = part.trim().toLowerCase();
            if (EMAIL_RE.test(email) && !emails.includes(email) && !valid.includes(email)) {
                valid.push(email);
            }
        }
        if (valid.length > 0) {
            setError('');
            onChange([...emails, ...valid]);
            setInputValue('');
        }
    };

    const handleBlur = () => {
        if (inputValue.trim()) {
            addEmail(inputValue);
        }
    };

    return (
        <div>
            <div
                className="flex flex-wrap items-center gap-1.5 min-h-[42px] px-3 py-2 bg-white border border-secondary-200 rounded-xl text-sm cursor-text focus-within:ring-2 focus-within:ring-primary-500/20 focus-within:border-primary-500 transition-all"
                onClick={() => inputRef.current?.focus()}
            >
                {emails.map((email) => (
                    <span
                        key={email}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary-50 border border-primary-200 text-xs font-medium text-primary-700 animate-fade-in"
                    >
                        <span className="font-mono">{email}</span>
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); removeEmail(email); }}
                            className="p-0.5 rounded hover:bg-primary-100 text-primary-400 hover:text-primary-600 transition-colors"
                            aria-label={`Remove ${email}`}
                        >
                            <X size={12} />
                        </button>
                    </span>
                ))}
                <input
                    ref={inputRef}
                    type="text"
                    className="flex-1 min-w-[180px] bg-transparent outline-none text-sm text-secondary-900 placeholder:text-secondary-400"
                    placeholder={emails.length === 0 ? placeholder : 'Add another...'}
                    value={inputValue}
                    onChange={(e) => { setInputValue(e.target.value); setError(''); }}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onBlur={handleBlur}
                />
            </div>
            {error && <p className="text-xs text-error-600 mt-1">{error}</p>}
        </div>
    );
}

// ─── Email Settings Tab ─────────────────────────────────────────────────────

function EmailSettings() {
    const { showToast } = useToast();
    const [bot, setBot] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    // Form state — reply-to is a single string; recipients are arrays
    const [replyToEmail, setReplyToEmail] = useState('');
    const [defaultRecipients, setDefaultRecipients] = useState([]);
    const [qualifiedLeadRecipients, setQualifiedLeadRecipients] = useState([]);
    const [handoffRecipients, setHandoffRecipients] = useState([]);
    const [offlineRecipients, setOfflineRecipients] = useState([]);
    const [showPerEvent, setShowPerEvent] = useState(false);
    const [justSaved, setJustSaved] = useState(false);

    // Toggles
    const [emailOnQualified, setEmailOnQualified] = useState(true);
    const [emailOnHandoff, setEmailOnHandoff] = useState(true);
    const [emailOnOffline, setEmailOnOffline] = useState(true);
    const [emailVisitorConfirmation, setEmailVisitorConfirmation] = useState(true);
    const [emailTranscript, setEmailTranscript] = useState(false);

    const fetchBot = useCallback(async () => {
        setLoading(true);
        try {
            const bots = await getBots();
            if (bots?.length > 0) {
                const b = bots[0];
                setBot(b);
                setReplyToEmail(b.reply_to_email || '');
                setEmailOnQualified(b.email_on_qualified ?? true);
                setEmailOnHandoff(b.email_on_handoff ?? true);
                setEmailOnOffline(b.email_on_offline ?? true);
                setEmailVisitorConfirmation(b.email_visitor_confirmation ?? true);
                setEmailTranscript(b.feature_flags?.email_transcript ?? false);

                // Parse notification_emails JSONB → arrays
                const ne = b.notification_emails || {};
                setDefaultRecipients(ne.default || []);
                setQualifiedLeadRecipients(ne.qualified_lead || []);
                setHandoffRecipients(ne.handoff_request || []);
                setOfflineRecipients(ne.offline_message || []);

                if (ne.qualified_lead?.length || ne.handoff_request?.length || ne.offline_message?.length) {
                    setShowPerEvent(true);
                }
            }
        } catch {
            showToast('error', 'Failed to load email settings');
        } finally {
            setLoading(false);
        }
    }, [showToast]);

    useEffect(() => { fetchBot(); }, [fetchBot]);

    const handleSave = async () => {
        if (!bot) return;
        setSaving(true);
        try {
            const notificationEmails = { default: defaultRecipients };
            if (qualifiedLeadRecipients.length) notificationEmails.qualified_lead = qualifiedLeadRecipients;
            if (handoffRecipients.length) notificationEmails.handoff_request = handoffRecipients;
            if (offlineRecipients.length) notificationEmails.offline_message = offlineRecipients;

            await updateBot(bot.id, {
                reply_to_email: replyToEmail.trim() || null,
                notification_emails: notificationEmails,
                email_on_qualified: emailOnQualified,
                email_on_handoff: emailOnHandoff,
                email_on_offline: emailOnOffline,
                email_visitor_confirmation: emailVisitorConfirmation,
                feature_flags: { email_transcript: emailTranscript },
            });

            showToast('success', 'Email settings saved');
            setJustSaved(true);
            await fetchBot();
            setTimeout(() => setJustSaved(false), 3000);
        } catch {
            showToast('error', 'Failed to save email settings');
        } finally {
            setSaving(false);
        }
    };

    const inputClass = "w-full px-3.5 py-2.5 bg-white border border-secondary-200 rounded-xl text-sm text-secondary-900 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all";

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-6 h-6 animate-spin text-secondary-400" />
            </div>
        );
    }

    return (
        <div className="space-y-6 max-w-3xl">
            {/* Section 1: Sender Identity */}
            <div className="bg-white rounded-2xl border border-secondary-200 shadow-sm p-6">
                <div className="flex items-center gap-3 mb-5">
                    <div className="w-10 h-10 rounded-xl bg-primary-50 flex items-center justify-center">
                        <Mail size={20} className="text-primary-600" />
                    </div>
                    <div>
                        <h3 className="text-sm font-semibold text-secondary-900">Sender Identity</h3>
                        <p className="text-xs text-secondary-500">How your emails appear to recipients</p>
                    </div>
                </div>

                <div className="space-y-4">
                    <div className="flex items-start gap-2 px-3.5 py-3 bg-secondary-50 rounded-xl">
                        <Info size={14} className="text-secondary-400 mt-0.5 shrink-0" />
                        <p className="text-xs text-secondary-600 leading-relaxed">
                            Emails are sent as <strong>&ldquo;{bot?.name || 'Your Bot'} via OyeChats&rdquo;</strong> from{' '}
                            <span className="font-mono text-xs">notifications@oyechats.com</span>. Replies go to the address below.
                        </p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-secondary-700 mb-1.5">Reply-To Email</label>
                        <input
                            type="email"
                            className={inputClass}
                            placeholder="support@yourdomain.com"
                            value={replyToEmail}
                            onChange={(e) => setReplyToEmail(e.target.value)}
                        />
                        <p className="text-xs text-secondary-400 mt-1">When visitors reply to emails, responses go to this address</p>
                    </div>
                </div>
            </div>

            {/* Section 2: Notification Recipients */}
            <div className="bg-white rounded-2xl border border-secondary-200 shadow-sm p-6">
                <h3 className="text-sm font-semibold text-secondary-900 mb-4">Notification Recipients</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-secondary-700 mb-1.5">Default Recipients</label>
                        <EmailChipInput
                            emails={defaultRecipients}
                            onChange={setDefaultRecipients}
                            placeholder="team@yourdomain.com"
                        />
                        <p className="text-xs text-secondary-400 mt-1">Press Enter or comma to add. Used for all events unless overridden below.</p>
                    </div>

                    <button
                        type="button"
                        onClick={() => setShowPerEvent(!showPerEvent)}
                        className="flex items-center gap-1.5 text-xs font-medium text-primary-600 hover:text-primary-700 transition-colors"
                    >
                        {showPerEvent ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        Per-event recipient overrides
                    </button>

                    {showPerEvent && (
                        <div className="space-y-3 pl-4 border-l-2 border-secondary-100">
                            <div>
                                <label className="block text-xs font-medium text-secondary-600 mb-1">Qualified Leads</label>
                                <EmailChipInput
                                    emails={qualifiedLeadRecipients}
                                    onChange={setQualifiedLeadRecipients}
                                    placeholder="Using default recipients"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-secondary-600 mb-1">Handoff Requests</label>
                                <EmailChipInput
                                    emails={handoffRecipients}
                                    onChange={setHandoffRecipients}
                                    placeholder="Using default recipients"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-secondary-600 mb-1">Offline Messages</label>
                                <EmailChipInput
                                    emails={offlineRecipients}
                                    onChange={setOfflineRecipients}
                                    placeholder="Using default recipients"
                                />
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Section 3: Email Toggles */}
            <div className="bg-white rounded-2xl border border-secondary-200 shadow-sm p-6">
                <h3 className="text-sm font-semibold text-secondary-900 mb-4">Email Notifications</h3>

                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-secondary-800">Notify team on qualified leads</p>
                            <p className="text-xs text-secondary-500">Send email when a visitor reaches SQL qualification</p>
                        </div>
                        <Toggle checked={emailOnQualified} onChange={setEmailOnQualified} />
                    </div>

                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-secondary-800">Notify team on handoff requests</p>
                            <p className="text-xs text-secondary-500">Send email when a visitor requests live support</p>
                        </div>
                        <Toggle checked={emailOnHandoff} onChange={setEmailOnHandoff} />
                    </div>

                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-secondary-800">Notify team on offline messages</p>
                            <p className="text-xs text-secondary-500">Send email when a visitor leaves a message</p>
                        </div>
                        <Toggle checked={emailOnOffline} onChange={setEmailOnOffline} />
                    </div>

                    <hr className="border-secondary-100" />

                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-secondary-800">Send confirmation to visitors</p>
                            <p className="text-xs text-secondary-500">Visitors receive a &ldquo;we got your message&rdquo; email after submitting offline messages</p>
                        </div>
                        <Toggle checked={emailVisitorConfirmation} onChange={setEmailVisitorConfirmation} />
                    </div>

                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-secondary-800">Allow visitors to email transcript</p>
                            <p className="text-xs text-secondary-500">Show &ldquo;Send transcript&rdquo; option in the widget menu</p>
                        </div>
                        <Toggle checked={emailTranscript} onChange={setEmailTranscript} />
                    </div>
                </div>
            </div>

            {/* Save Button */}
            <div className="flex justify-end">
                <button
                    onClick={handleSave}
                    disabled={saving}
                    className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium shadow-sm transition-all disabled:opacity-50 ${
                        justSaved
                            ? 'bg-success-600 hover:bg-success-700 text-white'
                            : 'bg-primary-600 hover:bg-primary-700 text-white'
                    }`}
                >
                    {saving && <Loader2 size={14} className="animate-spin" />}
                    {justSaved && <Check size={14} />}
                    {saving ? 'Saving...' : justSaved ? 'Saved' : 'Save Email Settings'}
                </button>
            </div>
        </div>
    );
}

// ─── Calendly Settings Tab ─────────────────────────────────────────────────

function CalendlySettings() {
    const { showToast } = useToast();
    const [bot, setBot] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [meetingBookingEnabled, setMeetingBookingEnabled] = useState(false);
    const [calendlyUrl, setCalendlyUrl] = useState('');
    const [justSaved, setJustSaved] = useState(false);

    const fetchBot = useCallback(async () => {
        setLoading(true);
        try {
            const bots = await getBots();
            if (bots?.length > 0) {
                const b = bots[0];
                setBot(b);
                setMeetingBookingEnabled(!!b.meeting_booking_enabled);
                setCalendlyUrl(b.calendly_url || '');
            }
        } catch {
            showToast('error', 'Failed to load meeting booking settings');
        } finally {
            setLoading(false);
        }
    }, [showToast]);

    useEffect(() => { fetchBot(); }, [fetchBot]);

    const handleSave = async () => {
        if (!bot) return;
        setSaving(true);
        try {
            await updateBot(bot.id, {
                meeting_booking_enabled: meetingBookingEnabled,
                calendly_url: meetingBookingEnabled ? calendlyUrl : null,
            });
            showToast('success', 'Meeting booking settings saved');
            setJustSaved(true);
            await fetchBot();
            setTimeout(() => setJustSaved(false), 3000);
        } catch (error) {
            showToast('error', error.message || 'Failed to save meeting booking settings');
        } finally {
            setSaving(false);
        }
    };

    const inputClass = "w-full px-3.5 py-2.5 bg-white border border-secondary-200 rounded-xl text-sm text-secondary-900 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all";

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-6 h-6 animate-spin text-secondary-400" />
            </div>
        );
    }

    return (
        <div className="space-y-6 max-w-3xl">
            {/* Calendly Configuration */}
            <div className="bg-white rounded-2xl border border-secondary-200 shadow-sm p-6">
                <div className="flex items-center gap-3 mb-5">
                    <div className="w-10 h-10 rounded-xl bg-primary-50 flex items-center justify-center">
                        <Calendar size={20} className="text-primary-600" />
                    </div>
                    <div>
                        <h3 className="text-sm font-semibold text-secondary-900">Meeting Booking</h3>
                        <p className="text-xs text-secondary-500">Show a Calendly booking widget when leads qualify as SQL</p>
                    </div>
                </div>

                <div className="space-y-4">
                    <div className="flex items-start gap-2 px-3.5 py-3 bg-secondary-50 rounded-xl">
                        <Info size={14} className="text-secondary-400 mt-0.5 shrink-0" />
                        <p className="text-xs text-secondary-600 leading-relaxed">
                            When enabled, visitors who qualify as a Sales Qualified Lead (SQL) will see an embedded Calendly widget to book a meeting directly in the chat.
                        </p>
                    </div>

                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-secondary-800">Enable meeting booking</p>
                            <p className="text-xs text-secondary-500">Automatically offer meeting scheduling to qualified leads</p>
                        </div>
                        <Toggle checked={meetingBookingEnabled} onChange={setMeetingBookingEnabled} />
                    </div>

                    {meetingBookingEnabled && (
                        <div>
                            <label className="block text-sm font-medium text-secondary-700 mb-1.5">Calendly URL</label>
                            <input
                                type="url"
                                value={calendlyUrl}
                                onChange={(e) => setCalendlyUrl(e.target.value)}
                                placeholder="https://calendly.com/your-name/30min"
                                className={inputClass}
                            />
                            <p className="text-xs text-secondary-400 mt-1">Paste your Calendly scheduling link here</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Save Button */}
            <div className="flex justify-end">
                <button
                    onClick={handleSave}
                    disabled={saving || (meetingBookingEnabled && !calendlyUrl.trim())}
                    className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium shadow-sm transition-all disabled:opacity-50 ${
                        justSaved
                            ? 'bg-success-600 hover:bg-success-700 text-white'
                            : 'bg-primary-600 hover:bg-primary-700 text-white'
                    }`}
                >
                    {saving && <Loader2 size={14} className="animate-spin" />}
                    {justSaved && <Check size={14} />}
                    {saving ? 'Saving...' : justSaved ? 'Saved' : 'Save Meeting Settings'}
                </button>
            </div>
        </div>
    );
}

// ─── Unified Integrations Page ──────────────────────────────────────────────

const integrationTabs = [
    { id: 'email', label: 'Email', icon: Mail },
    { id: 'webhooks', label: 'Webhooks', icon: WebhookIcon },
    { id: 'calendly', label: 'Calendly', icon: Calendar },
];

export default function Integrations() {
    // Support ?tab= query param for deep linking / redirects
    const params = new URLSearchParams(window.location.search);
    const initialTab = params.get('tab') || 'email';
    const [activeTab, setActiveTab] = useState(
        integrationTabs.some(t => t.id === initialTab) ? initialTab : 'email'
    );

    return (
        <div className="space-y-6 animate-fade-in">
            <PageHeader title="Integrations" subtitle="Connect email, webhooks, and third-party services" />
            <Tabs tabs={integrationTabs} activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === 'email' && <EmailSettings />}
            {activeTab === 'webhooks' && <Webhooks embedded />}
            {activeTab === 'calendly' && <CalendlySettings />}
        </div>
    );
}
