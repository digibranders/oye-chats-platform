import React, { useState, useRef, useEffect } from 'react';
import { User, Mail, Phone, Building2, ArrowRight } from 'lucide-react';
import BotAvatar from './BotAvatar';
import { sanitizeColor } from '../services/sanitize';
import { validateEmail as checkEmailWithServer } from '../services/api';
import { t } from '../i18n/i18n.js';

const getFieldConfig = () => ({
    name: { label: t('lead.name_label') || 'Your Name', icon: User, type: 'text', placeholder: t('lead.name_placeholder') || 'John Doe' },
    email: { label: t('lead.email_label') || 'Email Address', icon: Mail, type: 'email', placeholder: t('lead.email_placeholder') || 'john@company.com' },
    phone: { label: t('lead.phone_label') || 'Phone Number', icon: Phone, type: 'tel', placeholder: t('lead.phone_placeholder') || '+1 (555) 000-0000' },
    company: { label: t('lead.company_label') || 'Company', icon: Building2, type: 'text', placeholder: t('lead.company_placeholder') || 'Acme Inc.' },
});

// Inline pre-chat lead form. Renders WITHIN the chat window's messages area,
// the parent ChatWindow already supplies the header (bot avatar, name, close
// button) and outer container, so this component MUST NOT render its own.
// Adding chrome here produces a "second chat window stacked on top" look.
const LeadCaptureForm = ({ settings, onSubmit }) => {
    // Email-first by default so the real-time check below (fires on blur)
    // runs in the background while the visitor fills in the remaining
    // fields. Only applies when the customer hasn't set their own order,
    // an explicit settings.lead_form_fields is never silently reordered.
    const fields = settings?.lead_form_fields || [
        { field: 'email', required: true },
        { field: 'name', required: true },
    ];

    const [formData, setFormData] = useState({});
    const [errors, setErrors] = useState({});
    const [submitting, setSubmitting] = useState(false);
    // 'idle' | 'checking' | 'valid' | 'invalid'. PRESENTATION ONLY: it drives
    // the spinner and the disabled state. The submit gate is keyed on the
    // address in the field, never on this flag, which describes whichever
    // address was checked last.
    const [emailCheckState, setEmailCheckState] = useState('idle');
    // Latest value in the field, so an in-flight check can tell whether its
    // verdict still applies to what the visitor has typed.
    const emailValueRef = useRef('');
    const emailValue = formData.email || '';
    useEffect(() => {
        emailValueRef.current = emailValue;
    }, [emailValue]);

    const looksLikeEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    // Fires on blur from the email field, purely so the visitor sees the
    // verdict early. The check is memoized by address in ``services/api``,
    // so the matching check at submit costs no extra request.
    const handleEmailBlur = () => {
        const email = formData.email?.trim();
        if (!email) return;
        if (!looksLikeEmail(email)) {
            setEmailCheckState('invalid');
            setErrors(prev => ({ ...prev, email: (t('lead.invalid_email_short') || 'Please enter a valid email') }));
            return;
        }

        setEmailCheckState('checking');
        checkEmailWithServer(email).then((result) => {
            // A newer edit may have superseded this check. Only show the
            // verdict while it still describes what's in the field.
            if (emailValueRef.current.trim() !== email) return;
            if (result.valid) {
                setEmailCheckState('valid');
                setErrors(prev => ({ ...prev, email: undefined }));
            } else {
                setEmailCheckState('invalid');
                setErrors(prev => ({ ...prev, email: result.reason || (t('lead.invalid_email_short') || 'Please enter a valid email') }));
            }
        });
    };

    const validate = () => {
        const newErrors = {};
        const fieldConfigMap = getFieldConfig();
        for (const f of fields) {
            if (f.required && !formData[f.field]?.trim()) {
                const label = fieldConfigMap[f.field]?.label || f.field;
                newErrors[f.field] = t('lead.field_required', { field: label })
                    || `${label} is required`;
            }
            if (f.field === 'email' && formData.email?.trim()) {
                if (!looksLikeEmail(formData.email.trim())) {
                    newErrors.email = (t('lead.invalid_email_short') || 'Please enter a valid email');
                }
            }
        }
        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    };

    const hasEmailField = fields.some(f => f.field === 'email');

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!validate()) return;

        if (hasEmailField && formData.email?.trim()) {
            // Gate on the address that is IN THE FIELD right now, resolved by
            // value rather than by reading the mode flag: the flag describes
            // whichever address was checked last, so a second address typed
            // after a first one passed would otherwise inherit its "valid".
            const email = formData.email.trim();
            setEmailCheckState('checking');
            const result = await checkEmailWithServer(email);
            if (!result.valid) {
                setEmailCheckState('invalid');
                setErrors(prev => ({ ...prev, email: result.reason || (t('lead.invalid_email_short') || 'Please enter a valid email') }));
                return;
            }
            setEmailCheckState('valid');
        }

        setSubmitting(true);
        try {
            await onSubmit(formData);
        } catch {
            setSubmitting(false);
        }
    };

    const primary = sanitizeColor(settings?.primary_color, '#3A0CA3');
    const background = sanitizeColor(settings?.background_color, '#ffffff');

    return (
        <div
            className="w-full h-full flex flex-col items-center justify-center overflow-auto px-5 py-6"
            style={{ backgroundColor: background, animation: 'fadeUp 0.4s ease-out' }}
        >
            <div className="w-full max-w-sm">
                <div className="relative flex items-center justify-center mb-4">
                    <div
                        style={{
                            position: 'absolute',
                            width: 70,
                            height: 70,
                            borderRadius: '50%',
                            background: `radial-gradient(circle, ${primary}20 0%, transparent 70%)`,
                            filter: 'blur(8px)',
                        }}
                    />
                    <div className="relative">
                        <BotAvatar settings={settings} size="lg" />
                    </div>
                </div>

                <h2 className="text-center text-[#16202C] text-lg font-bold mb-1">
                    {settings?.lead_form_title || t('lead.title') || 'Before we start'}
                </h2>
                <p className="text-center text-gray-500 text-sm mb-5">
                    {settings?.lead_form_subtitle || t('lead.subtitle') || 'Please share your details so we can assist you better.'}
                </p>

                <form onSubmit={handleSubmit} className="space-y-3">
                    {fields.map((f, i) => {
                        const fieldConfigMap = getFieldConfig();
                        const config = fieldConfigMap[f.field];
                        if (!config) return null;
                        const Icon = config.icon;
                        return (
                            <div key={f.field} style={{ animation: `fadeUp 0.3s ease-out ${i * 0.06}s both` }}>
                                <div
                                    className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 transition-colors ${
                                        errors[f.field]
                                            ? 'border-red-300 bg-red-50/50'
                                            : 'border-gray-200 bg-gray-50/50 focus-within:border-blue-300 focus-within:bg-white'
                                    }`}
                                >
                                    <Icon className="w-4 h-4 text-gray-400 flex-shrink-0" />
                                    <input
                                        type={config.type}
                                        placeholder={`${config.placeholder}${f.required ? ' *' : ''}`}
                                        value={formData[f.field] || ''}
                                        onChange={(e) => {
                                            setFormData(prev => ({ ...prev, [f.field]: e.target.value }));
                                            if (errors[f.field]) {
                                                setErrors(prev => ({ ...prev, [f.field]: undefined }));
                                            }
                                            if (f.field === 'email') setEmailCheckState('idle');
                                        }}
                                        onBlur={f.field === 'email' ? handleEmailBlur : undefined}
                                        className="flex-1 bg-transparent outline-none text-sm text-[#16202C] placeholder:text-gray-400"
                                    />
                                    {f.field === 'email' && emailCheckState === 'checking' && (
                                        <div className="w-3 h-3 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin flex-shrink-0" />
                                    )}
                                </div>
                                {errors[f.field] && (
                                    <p className="text-red-500 text-xs mt-1 ml-1">{errors[f.field]}</p>
                                )}
                            </div>
                        );
                    })}

                    <button
                        type="submit"
                        disabled={submitting || emailCheckState === 'invalid'}
                        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-white text-sm font-medium transition-all hover:opacity-90 disabled:opacity-60"
                        style={{ backgroundColor: primary }}
                    >
                        {submitting ? (
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                            <>
                                {t('lead.submit') || 'Start Chat'}
                                <ArrowRight className="w-4 h-4" />
                            </>
                        )}
                    </button>
                </form>
            </div>

            <style>{`
                @keyframes fadeUp {
                    from { opacity: 0; transform: translateY(8px); }
                    to { opacity: 1; transform: translateY(0); }
                }
            `}</style>
        </div>
    );
};

export default LeadCaptureForm;
