import React, { useState, useEffect, useRef } from 'react';
import { User, Mail, ArrowRight, Headphones, Building2, ArrowLeft, ChevronDown } from 'lucide-react';
import { getDepartments } from '../services/api';
import { sanitizeColor } from '../services/sanitize';

const HandoffForm = ({ settings, onSubmit, onCancel, existingLeadInfo, status = 'pending' }) => {
    const hasName = !!(existingLeadInfo?.name?.trim());
    const hasEmail = !!(existingLeadInfo?.email?.trim());
    const hasAllRequired = hasName && hasEmail;

    const [formData, setFormData] = useState({
        name: existingLeadInfo?.name || '',
        email: existingLeadInfo?.email || '',
        department_id: null,
    });
    // null = not yet loaded; [] = loaded with no departments; [...] = loaded with departments
    const [departments, setDepartments] = useState(null);
    const [emailError, setEmailError] = useState('');
    const autoSubmitAttemptedRef = useRef(false);

    const isSubmitting = status === 'submitting';
    const primaryColor = sanitizeColor(settings.primary_color, '#3A0CA3');

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
        if (!hasAllRequired || departments === null || autoSubmitAttemptedRef.current) return;
        autoSubmitAttemptedRef.current = true;
        const timer = setTimeout(() => {
            onSubmit({
                name: existingLeadInfo.name,
                email: existingLeadInfo.email,
                department_id: null,
            });
        }, 300);
        return () => clearTimeout(timer);
    }, [departments, hasAllRequired, existingLeadInfo, onSubmit]);

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

                    {/* Email field — hidden if already known */}
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
                                    }}
                                    className="flex-1 bg-transparent outline-none text-[13px] text-[#16202C] placeholder:text-gray-400"
                                    disabled={isSubmitting}
                                    required
                                />
                            </div>
                            {emailError && (
                                <p className="mt-0.5 ml-1 text-[11px] text-red-500">{emailError}</p>
                            )}
                        </div>
                    )}

                    {/* Department dropdown — shown only when multiple departments exist */}
                    {departments && departments.length > 0 && (
                        <div className={`flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50/50 px-3 py-2 focus-within:border-blue-300 focus-within:bg-white transition-colors ${isSubmitting ? 'opacity-60' : ''}`}>
                            <Building2 className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                            <select
                                value={formData.department_id || ''}
                                onChange={(e) => setFormData(prev => ({ ...prev, department_id: e.target.value ? Number(e.target.value) : null }))}
                                className="flex-1 bg-transparent outline-none text-[13px] text-[#16202C] appearance-none cursor-pointer"
                                disabled={isSubmitting}
                            >
                                <option value="">Select department</option>
                                {departments.map((dept) => (
                                    <option key={dept.id} value={dept.id}>{dept.name}</option>
                                ))}
                            </select>
                            <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0 pointer-events-none" />
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={isSubmitting || (!hasName && !formData.name.trim()) || (!hasEmail && !formData.email.trim())}
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
