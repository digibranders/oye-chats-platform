import { useState } from 'react';
import { Bot, Sparkles, Settings2, Mail, X } from 'lucide-react';

const FIELD_LABELS = { name: 'Name', email: 'Email', phone: 'Phone', company: 'Company' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * LeadsTab — lead capture configuration.
 *
 * BANT qualification toggle, the pre-chat lead-capture form (field selection +
 * required flags), and email-notification settings. The whole tab is paid;
 * the shell only renders it when the plan is unlocked.
 *
 * @param {{ draft: object, set: (field: string, value: unknown) => void }} props
 */
export default function LeadsTab({ draft, set }) {
    const [emailInput, setEmailInput] = useState('');

    const leadFormFields = Array.isArray(draft.lead_form_fields) ? draft.lead_form_fields : [];
    const notificationEmails = Array.isArray(draft.notification_emails) ? draft.notification_emails : [];

    const commitEmail = () => {
        const val = emailInput.trim().replace(/,$/, '');
        if (val && EMAIL_RE.test(val) && !notificationEmails.includes(val)) {
            set('notification_emails', [...notificationEmails, val]);
            setEmailInput('');
        }
    };

    return (
        <div className="space-y-6 animate-fade-in">
            {/* BANT Qualification Toggle */}
            <div>
                <h3 className="text-[15px] font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                    <Bot className="w-4 h-4 text-primary-500" />
                    <span className="text-green-600 dark:text-green-400">BANT</span> Lead Qualification
                </h3>
                <p className="text-[13px] text-surface-500 dark:text-surface-400 mt-0.5">
                    AI will subtly ask qualifying questions (Budget, Authority, Need, Timeline) when the user shows buying intent.
                </p>
            </div>
            <div className="bg-white dark:bg-surface-900 p-5 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm flex items-center justify-between">
                <div>
                    <h4 className="text-[14px] font-semibold text-surface-900 dark:text-surface-100">Enable BANT Qualification</h4>
                    <p className="text-[12px] text-surface-500 dark:text-surface-400 mt-1">Qualify leads automatically during chat.</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" className="sr-only peer" checked={draft.bant_enabled} onChange={(e) => set('bant_enabled', e.target.checked)} />
                    <div className="w-11 h-6 bg-surface-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-surface-300 dark:after:border-surface-600 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600"></div>
                </label>
            </div>

            {/* Pre-Chat Lead Capture Form */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className="text-[15px] font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-primary-500" />
                    Pre-Chat Lead Capture
                </h3>
                <p className="text-[13px] text-surface-500 dark:text-surface-400 mt-0.5">
                    Show a form before chat starts to capture visitor contact details.
                </p>
            </div>

            <div className="bg-white dark:bg-surface-900 p-5 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm flex items-center justify-between">
                <div>
                    <h4 className="text-[14px] font-semibold text-surface-900 dark:text-surface-100">Enable Lead Form</h4>
                    <p className="text-[12px] text-surface-500 dark:text-surface-400 mt-1">New visitors fill out a form before chatting.</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" className="sr-only peer" checked={draft.lead_form_enabled} onChange={(e) => set('lead_form_enabled', e.target.checked)} />
                    <div className="w-11 h-6 bg-surface-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-surface-300 dark:after:border-surface-600 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600"></div>
                </label>
            </div>

            {draft.lead_form_enabled && (
                <div className="bg-white dark:bg-surface-900 p-5 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm space-y-3">
                    <h4 className="text-[14px] font-semibold text-surface-900 dark:text-surface-100">Form Fields</h4>
                    <p className="text-[12px] text-surface-500 dark:text-surface-400">Select which fields to show and mark as required.</p>
                    {['name', 'email', 'phone', 'company'].map((fieldName) => {
                        const existing = leadFormFields.find((f) => f.field === fieldName);
                        const isEnabled = !!existing;
                        const isRequired = existing?.required ?? false;

                        return (
                            <div key={fieldName} className="flex items-center justify-between py-2 border-b border-surface-100 dark:border-surface-800 last:border-0">
                                <div className="flex items-center gap-3">
                                    <label className="relative inline-flex items-center cursor-pointer">
                                        <input
                                            type="checkbox"
                                            className="sr-only peer"
                                            checked={isEnabled}
                                            onChange={(e) => {
                                                if (e.target.checked) {
                                                    set('lead_form_fields', [...leadFormFields, { field: fieldName, required: false }]);
                                                } else {
                                                    set('lead_form_fields', leadFormFields.filter((f) => f.field !== fieldName));
                                                }
                                            }}
                                        />
                                        <div className="w-9 h-5 bg-surface-200 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-surface-300 dark:after:border-surface-600 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                                    </label>
                                    <span className="text-[13px] font-medium text-surface-700 dark:text-surface-300">{FIELD_LABELS[fieldName]}</span>
                                </div>
                                {isEnabled && (
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            className="w-4 h-4 text-primary-600 rounded border-surface-300 focus:ring-primary-500"
                                            checked={isRequired}
                                            onChange={(e) => {
                                                set('lead_form_fields', leadFormFields.map((f) =>
                                                    f.field === fieldName ? { ...f, required: e.target.checked } : f
                                                ));
                                            }}
                                        />
                                        <span className="text-[12px] text-surface-500">Required</span>
                                    </label>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Email Notifications */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className="text-[15px] font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2">
                    <Settings2 className="w-4 h-4 text-primary-500" />
                    Email Notifications
                </h3>
                <p className="text-[13px] text-surface-500 dark:text-surface-400 mt-0.5">
                    Get notified when leads are qualified or request live support.
                </p>
            </div>

            <div className="bg-white dark:bg-surface-900 p-5 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm space-y-4">
                <div className="space-y-2">
                    <label className="text-[13px] font-bold text-surface-700 dark:text-surface-300">
                        Notification Emails
                    </label>
                    <div
                        className="min-h-[42px] w-full flex flex-wrap gap-1.5 px-2.5 py-2 border border-surface-200 dark:border-surface-700 rounded-lg bg-white dark:bg-surface-900 focus-within:border-primary-400 transition-colors cursor-text"
                        onClick={() => document.getElementById('notif-email-input')?.focus()}
                    >
                        {notificationEmails.map((email) => (
                            <span
                                key={email}
                                className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md bg-primary-50 dark:bg-primary-500/15 border border-primary-200 dark:border-primary-500/30 text-[12px] font-medium text-primary-700 dark:text-primary-300 max-w-full"
                            >
                                <Mail size={11} className="flex-shrink-0 opacity-70" />
                                <span className="truncate">{email}</span>
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        set('notification_emails', notificationEmails.filter((x) => x !== email));
                                    }}
                                    className="flex-shrink-0 ml-0.5 p-0.5 rounded hover:bg-primary-200 dark:hover:bg-primary-500/30 transition-colors"
                                    aria-label={`Remove ${email}`}
                                >
                                    <X size={10} />
                                </button>
                            </span>
                        ))}
                        <input
                            id="notif-email-input"
                            type="email"
                            value={emailInput}
                            onChange={(e) => setEmailInput(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ',') {
                                    e.preventDefault();
                                    commitEmail();
                                } else if (e.key === 'Backspace' && !emailInput && notificationEmails.length > 0) {
                                    set('notification_emails', notificationEmails.slice(0, -1));
                                }
                            }}
                            onBlur={commitEmail}
                            placeholder={notificationEmails.length === 0 ? 'sales@yourcompany.com' : 'Add another...'}
                            className="flex-1 min-w-[160px] text-sm text-surface-600 dark:text-surface-300 bg-transparent outline-none placeholder:text-surface-400 dark:placeholder:text-surface-500 py-0.5"
                        />
                    </div>
                    <p className="text-[11px] text-surface-400 dark:text-surface-500">
                        Press Enter or comma to add. Backspace removes the last chip.
                    </p>
                </div>
                <div className="flex items-center justify-between py-2">
                    <span className="text-[13px] text-surface-700 dark:text-surface-300">Email on qualified lead</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" checked={draft.email_on_qualified} onChange={(e) => set('email_on_qualified', e.target.checked)} />
                        <div className="w-9 h-5 bg-surface-200 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-surface-300 dark:after:border-surface-600 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                    </label>
                </div>
                <div className="flex items-center justify-between py-2">
                    <span className="text-[13px] text-surface-700 dark:text-surface-300">Email on live chat request</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" checked={draft.email_on_handoff} onChange={(e) => set('email_on_handoff', e.target.checked)} />
                        <div className="w-9 h-5 bg-surface-200 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-surface-300 dark:after:border-surface-600 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary-600"></div>
                    </label>
                </div>
            </div>
        </div>
    );
}
