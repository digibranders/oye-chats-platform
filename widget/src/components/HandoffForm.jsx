import React, { useState, useEffect } from 'react';
import { User, Mail, MessageSquare, ArrowRight, Headphones, Building2, ArrowLeft, ChevronDown } from 'lucide-react';
import { getDepartments } from '../services/api';

const HandoffForm = ({ settings, onSubmit, onCancel, existingLeadInfo }) => {
    // Derive which fields are already known from the session
    const hasName = !!(existingLeadInfo?.name?.trim());
    const hasEmail = !!(existingLeadInfo?.email?.trim());
    const hasAllRequired = hasName && hasEmail;

    const [formData, setFormData] = useState({
        name: existingLeadInfo?.name || '',
        email: existingLeadInfo?.email || '',
        reason: '',
        department_id: null,
    });
    const [submitting, setSubmitting] = useState(false);
    // null = not yet loaded; [] = loaded with no departments; [...] = loaded with departments
    const [departments, setDepartments] = useState(null);
    const [emailError, setEmailError] = useState('');
    const [autoSubmitAttempted, setAutoSubmitAttempted] = useState(false);

    useEffect(() => {
        getDepartments().then((data) => {
            if (data.departments && data.departments.length > 1) {
                setDepartments(data.departments);
            } else {
                setDepartments([]);
            }
        }).catch(() => setDepartments([]));
    }, []);

    // Auto-submit when all required info is already on file (skip the form entirely)
    useEffect(() => {
        if (hasAllRequired && departments !== null && !autoSubmitAttempted) {
            setAutoSubmitAttempted(true);
            setSubmitting(true);
            setTimeout(() => {
                onSubmit({
                    name: existingLeadInfo.name,
                    email: existingLeadInfo.email,
                    reason: '',
                    department_id: null,
                }).finally(() => setSubmitting(false));
            }, 300);
        }
    }, [departments, hasAllRequired, autoSubmitAttempted]); // eslint-disable-line react-hooks/exhaustive-deps

    const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!hasName && !formData.name.trim()) return;
        if (!hasEmail) {
            if (!validateEmail(formData.email)) {
                setEmailError('Please enter a valid email address.');
                return;
            }
        }
        setEmailError('');
        setSubmitting(true);
        try {
            await onSubmit({
                ...formData,
                name: hasName ? existingLeadInfo.name : formData.name,
                email: hasEmail ? existingLeadInfo.email : formData.email,
            });
        } finally {
            setSubmitting(false);
        }
    };

    // Dynamic heading copy based on how much info is already known
    const headingText = hasAllRequired
        ? 'Connecting you with our team...'
        : hasName
        ? `Just one more detail`
        : 'Connect with our team';

    const subText = hasAllRequired
        ? 'We have your details. One moment while we connect you.'
        : hasName
        ? `Hi ${existingLeadInfo.name}! We just need your email to connect you.`
        : "Please share your details and we'll connect you right away.";

    return (
        <div className="flex-1 flex flex-col items-center justify-center px-5 py-6" style={{ backgroundColor: settings.background_color || '#ffffff' }}>
            <div className="w-full max-w-sm" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                <div className="flex items-center justify-center mb-4">
                    <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ backgroundColor: `${settings.primary_color || '#3A0CA3'}15` }}>
                        <Headphones className="w-7 h-7" style={{ color: settings.primary_color || '#3A0CA3' }} />
                    </div>
                </div>

                <h2 className="text-center text-[#16202C] text-lg font-bold mb-1">
                    {headingText}
                </h2>
                <p className="text-center text-gray-500 text-sm mb-5">
                    {subText}
                </p>

                {/* Show a spinner and skip the form if we already have all required info */}
                {hasAllRequired ? (
                    <div className="flex items-center justify-center py-6">
                        <div className="w-6 h-6 border-2 border-gray-200 border-t-gray-500 rounded-full animate-spin" />
                    </div>
                ) : (
                    <form onSubmit={handleSubmit} className="space-y-3">
                        {/* Name field — hidden if already known */}
                        {!hasName && (
                            <div className="flex items-center gap-2.5 rounded-xl border border-gray-200 bg-gray-50/50 px-3.5 py-2.5 focus-within:border-blue-300 focus-within:bg-white transition-colors">
                                <User className="w-4 h-4 text-gray-400 flex-shrink-0" />
                                <input
                                    type="text"
                                    placeholder="Your name *"
                                    value={formData.name}
                                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                                    className="flex-1 bg-transparent outline-none text-sm text-[#16202C] placeholder:text-gray-400"
                                    required
                                />
                            </div>
                        )}

                        {/* Email field — hidden if already known */}
                        {!hasEmail && (
                            <div>
                                <div className={`flex items-center gap-2.5 rounded-xl border bg-gray-50/50 px-3.5 py-2.5 focus-within:bg-white transition-colors ${emailError ? 'border-red-300 focus-within:border-red-400' : 'border-gray-200 focus-within:border-blue-300'}`}>
                                    <Mail className="w-4 h-4 text-gray-400 flex-shrink-0" />
                                    <input
                                        type="email"
                                        placeholder="Email address *"
                                        value={formData.email}
                                        onChange={(e) => { setFormData(prev => ({ ...prev, email: e.target.value })); if (emailError) setEmailError(''); }}
                                        className="flex-1 bg-transparent outline-none text-sm text-[#16202C] placeholder:text-gray-400"
                                        aria-describedby={emailError ? 'email-error' : undefined}
                                        required
                                    />
                                </div>
                                {emailError && (
                                    <p id="email-error" className="mt-1 ml-1 text-[11px] text-red-500">{emailError}</p>
                                )}
                            </div>
                        )}

                        {departments && departments.length > 0 && (
                            <div className="flex items-center gap-2.5 rounded-xl border border-gray-200 bg-gray-50/50 px-3.5 py-2.5 focus-within:border-blue-300 focus-within:bg-white transition-colors">
                                <Building2 className="w-4 h-4 text-gray-400 flex-shrink-0" />
                                <select
                                    value={formData.department_id || ''}
                                    onChange={(e) => setFormData(prev => ({ ...prev, department_id: e.target.value ? Number(e.target.value) : null }))}
                                    className="flex-1 bg-transparent outline-none text-sm text-[#16202C] appearance-none cursor-pointer"
                                >
                                    <option value="">Select department</option>
                                    {departments.map((dept) => (
                                        <option key={dept.id} value={dept.id}>{dept.name}</option>
                                    ))}
                                </select>
                                <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0 pointer-events-none" />
                            </div>
                        )}

                        <div className="flex items-start gap-2.5 rounded-xl border border-gray-200 bg-gray-50/50 px-3.5 py-2.5 focus-within:border-blue-300 focus-within:bg-white transition-colors">
                            <MessageSquare className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                            <textarea
                                placeholder="How can we help? (optional)"
                                value={formData.reason}
                                onChange={(e) => setFormData(prev => ({ ...prev, reason: e.target.value }))}
                                className="flex-1 bg-transparent outline-none text-sm text-[#16202C] placeholder:text-gray-400 resize-none min-h-[60px]"
                                rows={2}
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={submitting || (!hasName && !formData.name.trim()) || (!hasEmail && !formData.email.trim())}
                            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-white text-sm font-medium transition-all hover:opacity-90 disabled:opacity-60"
                            style={{ backgroundColor: settings.primary_color || '#3A0CA3' }}
                        >
                            {submitting ? (
                                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            ) : (
                                <>
                                    Connect Now
                                    <ArrowRight className="w-4 h-4" />
                                </>
                            )}
                        </button>

                        {onCancel && (
                            <button
                                type="button"
                                onClick={onCancel}
                                className="w-full flex items-center justify-center gap-1.5 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors mt-1"
                            >
                                <ArrowLeft className="w-3.5 h-3.5" />
                                Continue with AI assistant instead
                            </button>
                        )}
                    </form>
                )}
            </div>

        </div>
    );
};

export default HandoffForm;
