import React, { useState, useEffect, useRef } from 'react';
import { User, Mail, ArrowRight, Headphones, ArrowLeft } from 'lucide-react';
import { sanitizeColor } from '../services/sanitize';
import { validateEmail as checkEmailWithServer } from '../services/api';

const HandoffForm = ({ settings, onSubmit, onCancel, existingLeadInfo, status = 'pending' }) => {
    const hasName = !!(existingLeadInfo?.name?.trim());
    const hasEmail = !!(existingLeadInfo?.email?.trim());
    const hasAllRequired = hasName && hasEmail;

    const [formData, setFormData] = useState({
        name: existingLeadInfo?.name || '',
        email: existingLeadInfo?.email || '',
    });
    const [emailError, setEmailError] = useState('');
    // 'idle' | 'checking' | 'valid' | 'invalid' — drives the submit gate.
    // Starts 'valid' when the email is already on file (existingLeadInfo),
    // since it was already accepted once and doesn't need rechecking.
    const [emailCheckState, setEmailCheckState] = useState(hasEmail ? 'valid' : 'idle');
    const autoSubmitAttemptedRef = useRef(false);
    // Holds the in-flight server check so submit can await it if the
    // visitor clicks "Connect Now" before the blur check resolves.
    const emailCheckPromiseRef = useRef(null);
    const lastCheckedEmailRef = useRef('');

    const isSubmitting = status === 'submitting';
    const primaryColor = sanitizeColor(settings.primary_color, '#3A0CA3');

    // Auto-submit when all required info is already on file (skip the form
    // entirely). Department picker was removed — all chats go into the
    // single shared pool and the backend's routing service picks the
    // operator. Removing the picker also removes the getDepartments() round
    // trip we used to wait on before auto-submit was allowed to fire.
    useEffect(() => {
        if (!hasAllRequired || autoSubmitAttemptedRef.current) return;
        autoSubmitAttemptedRef.current = true;
        const timer = setTimeout(() => {
            onSubmit({
                name: existingLeadInfo.name,
                email: existingLeadInfo.email,
            });
        }, 300);
        return () => clearTimeout(timer);
    }, [hasAllRequired, existingLeadInfo, onSubmit]);

    const looksLikeEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    // Fires on blur — while the visitor moves on to the name field, the
    // server-side Reoon check runs in the background so it's usually
    // already resolved by the time they click "Connect Now".
    const handleEmailBlur = () => {
        const email = formData.email.trim();
        if (!email || email === lastCheckedEmailRef.current) return;
        if (!looksLikeEmail(email)) {
            setEmailCheckState('invalid');
            setEmailError('Please enter a valid email address.');
            return;
        }

        lastCheckedEmailRef.current = email;
        setEmailCheckState('checking');
        const promise = checkEmailWithServer(email).then((result) => {
            // A newer check (from further edits) may have superseded this
            // one — only apply the result if it's still the latest email.
            if (lastCheckedEmailRef.current !== email) return result;
            if (result.valid) {
                setEmailCheckState('valid');
                setEmailError('');
            } else {
                setEmailCheckState('invalid');
                setEmailError(result.reason || 'Please enter a valid email address.');
            }
            return result;
        });
        emailCheckPromiseRef.current = promise;
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!hasName && !formData.name.trim()) return;

        if (!hasEmail) {
            const email = formData.email.trim();
            if (!looksLikeEmail(email)) {
                setEmailCheckState('invalid');
                setEmailError('Please enter a valid email address.');
                return;
            }

            // The visitor may click "Connect Now" before the blur check
            // resolves (e.g. they filled the name field very fast) —
            // wait for it rather than letting an unchecked email through.
            if (emailCheckState === 'checking' && emailCheckPromiseRef.current) {
                const result = await emailCheckPromiseRef.current;
                if (!result.valid) return; // state/error already set inside the check
            } else if (emailCheckState === 'invalid') {
                return;
            } else if (emailCheckState === 'idle') {
                // Blur never fired (e.g. autofill + direct submit) — check now.
                setEmailCheckState('checking');
                const result = await checkEmailWithServer(email);
                if (!result.valid) {
                    setEmailCheckState('invalid');
                    setEmailError(result.reason || 'Please enter a valid email address.');
                    return;
                }
                setEmailCheckState('valid');
            }
        }

        setEmailError('');
        await onSubmit({
            ...formData,
            name: hasName ? existingLeadInfo.name : formData.name,
            email: hasEmail ? existingLeadInfo.email : formData.email,
        });
    };

    return (
        <div
            className="mx-3 my-1 rounded-2xl border border-gray-100 shadow-sm bg-white p-4 max-w-xs"
            style={{ animation: 'fadeUp 0.3s ease-out' }}
        >
            {/* Header */}
            <div className="flex items-center gap-2 mb-3">
                <div
                    className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: `${primaryColor}15` }}
                >
                    <Headphones className="w-3.5 h-3.5" style={{ color: primaryColor }} />
                </div>
                <div>
                    <p className="text-[13px] font-semibold text-[#16202C] leading-tight">
                        {hasAllRequired ? 'Connecting you...' : 'Connect with our team'}
                    </p>
                    {!hasAllRequired && (
                        <p className="text-[11px] text-gray-400 leading-tight mt-0.5">
                            {hasName
                                ? `Hi ${existingLeadInfo.name}! Just need your email.`
                                : 'Share a few details to get started.'}
                        </p>
                    )}
                </div>
            </div>

            {/* Auto-submit spinner when all info is already on file */}
            {hasAllRequired ? (
                <div className="flex items-center justify-center py-3">
                    <div className="w-5 h-5 border-2 border-gray-200 border-t-gray-500 rounded-full animate-spin" />
                </div>
            ) : (
                <form onSubmit={handleSubmit} className="space-y-2">
                    {/* Email field first — hidden if already known. Checked
                        on blur so validation runs in the background while
                        the visitor fills in their name. */}
                    {!hasEmail && (
                        <div>
                            <div className={`flex items-center gap-2 rounded-xl border bg-gray-50/50 px-3 py-2 focus-within:bg-white transition-colors ${emailError ? 'border-red-300' : 'border-gray-200 focus-within:border-blue-300'} ${isSubmitting ? 'opacity-60' : ''}`}>
                                <Mail className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                                <input
                                    type="email"
                                    placeholder="Email address *"
                                    value={formData.email}
                                    onChange={(e) => {
                                        setFormData(prev => ({ ...prev, email: e.target.value }));
                                        if (emailError) setEmailError('');
                                        setEmailCheckState('idle');
                                    }}
                                    onBlur={handleEmailBlur}
                                    className="flex-1 bg-transparent outline-none text-[13px] text-[#16202C] placeholder:text-gray-400"
                                    disabled={isSubmitting}
                                    required
                                />
                                {emailCheckState === 'checking' && (
                                    <div className="w-3 h-3 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin flex-shrink-0" />
                                )}
                            </div>
                            {emailError && (
                                <p className="mt-0.5 ml-1 text-[11px] text-red-500">{emailError}</p>
                            )}
                        </div>
                    )}

                    {/* Name field — hidden if already known */}
                    {!hasName && (
                        <div className={`flex items-center gap-2 rounded-xl border bg-gray-50/50 px-3 py-2 focus-within:bg-white transition-colors border-gray-200 focus-within:border-blue-300 ${isSubmitting ? 'opacity-60' : ''}`}>
                            <User className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                            <input
                                type="text"
                                placeholder="Your name *"
                                value={formData.name}
                                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                                className="flex-1 bg-transparent outline-none text-[13px] text-[#16202C] placeholder:text-gray-400"
                                disabled={isSubmitting}
                                required
                            />
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={isSubmitting || (!hasName && !formData.name.trim()) || (!hasEmail && !formData.email.trim()) || emailCheckState === 'invalid'}
                        className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-white text-[13px] font-medium transition-all hover:opacity-90 disabled:opacity-60"
                        style={{ backgroundColor: primaryColor }}
                    >
                        {isSubmitting ? (
                            <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                            <>
                                Connect Now
                                <ArrowRight className="w-3.5 h-3.5" />
                            </>
                        )}
                    </button>

                    {onCancel && !isSubmitting && (
                        <button
                            type="button"
                            onClick={onCancel}
                            className="w-full flex items-center justify-center gap-1 py-1.5 text-[12px] text-gray-400 hover:text-gray-600 transition-colors"
                        >
                            <ArrowLeft className="w-3 h-3" />
                            Continue with AI instead
                        </button>
                    )}
                </form>
            )}
        </div>
    );
};

export default HandoffForm;
