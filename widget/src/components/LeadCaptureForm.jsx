import React, { useState } from 'react';
import { X, User, Mail, Phone, Building2, ArrowRight } from 'lucide-react';
import BotAvatar from './BotAvatar';

const FIELD_CONFIG = {
    name: { label: 'Your Name', icon: User, type: 'text', placeholder: 'John Doe' },
    email: { label: 'Email Address', icon: Mail, type: 'email', placeholder: 'john@company.com' },
    phone: { label: 'Phone Number', icon: Phone, type: 'tel', placeholder: '+1 (555) 000-0000' },
    company: { label: 'Company', icon: Building2, type: 'text', placeholder: 'Acme Inc.' },
};

const LeadCaptureForm = ({ settings, currentTheme, onClose, onSubmit }) => {
    const fields = settings?.lead_form_fields || [
        { field: 'name', required: true },
        { field: 'email', required: true },
    ];

    const [formData, setFormData] = useState({});
    const [errors, setErrors] = useState({});
    const [submitting, setSubmitting] = useState(false);

    const validate = () => {
        const newErrors = {};
        for (const f of fields) {
            if (f.required && !formData[f.field]?.trim()) {
                newErrors[f.field] = `${FIELD_CONFIG[f.field]?.label || f.field} is required`;
            }
            if (f.field === 'email' && formData.email?.trim()) {
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(formData.email.trim())) {
                    newErrors.email = 'Please enter a valid email';
                }
            }
        }
        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!validate()) return;
        setSubmitting(true);
        try {
            await onSubmit(formData);
        } catch {
            setSubmitting(false);
        }
    };

    return (
        <div className={currentTheme.container}>
            {/* Header */}
            <div className={currentTheme.header}>
                <div className="flex items-center gap-3">
                    <BotAvatar settings={settings} size="md" />
                    <h3 className="font-semibold text-sm text-[#16202C]">{settings.bot_name}</h3>
                </div>
                <button
                    onClick={onClose}
                    className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors"
                    title="Close"
                >
                    <X className="w-5 h-5" />
                </button>
            </div>

            {/* Form Content */}
            <div
                className="flex-1 flex flex-col items-center justify-center overflow-auto px-5 py-6"
                style={{ backgroundColor: settings.background_color || '#ffffff' }}
            >
                <div className="w-full max-w-sm" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                    {/* Avatar glow */}
                    <div className="relative flex items-center justify-center mb-4">
                        <div
                            style={{
                                position: 'absolute',
                                width: 70,
                                height: 70,
                                borderRadius: '50%',
                                background: `radial-gradient(circle, ${settings.primary_color || '#2B66BC'}20 0%, transparent 70%)`,
                                filter: 'blur(8px)',
                            }}
                        />
                        <div className="relative">
                            <BotAvatar settings={settings} size="lg" />
                        </div>
                    </div>

                    <h2 className="text-center text-[#16202C] text-lg font-bold mb-1">
                        Before we start
                    </h2>
                    <p className="text-center text-gray-500 text-sm mb-5">
                        Please share your details so we can assist you better.
                    </p>

                    <form onSubmit={handleSubmit} className="space-y-3">
                        {fields.map((f, i) => {
                            const config = FIELD_CONFIG[f.field];
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
                                            }}
                                            className="flex-1 bg-transparent outline-none text-sm text-[#16202C] placeholder:text-gray-400"
                                        />
                                    </div>
                                    {errors[f.field] && (
                                        <p className="text-red-500 text-xs mt-1 ml-1">{errors[f.field]}</p>
                                    )}
                                </div>
                            );
                        })}

                        <button
                            type="submit"
                            disabled={submitting}
                            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-white text-sm font-medium transition-all hover:opacity-90 disabled:opacity-60"
                            style={{ backgroundColor: settings.primary_color || '#3A0CA3' }}
                        >
                            {submitting ? (
                                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            ) : (
                                <>
                                    Start Chat
                                    <ArrowRight className="w-4 h-4" />
                                </>
                            )}
                        </button>
                    </form>
                </div>
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
