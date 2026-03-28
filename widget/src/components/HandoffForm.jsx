import React, { useState, useEffect } from 'react';
import { User, Mail, MessageSquare, ArrowRight, Headphones, Building2 } from 'lucide-react';
import { getDepartments } from '../services/api';

const HandoffForm = ({ settings, onSubmit, existingLeadInfo }) => {
    const [formData, setFormData] = useState({
        name: existingLeadInfo?.name || '',
        email: existingLeadInfo?.email || '',
        reason: '',
        department_id: null,
    });
    const [submitting, setSubmitting] = useState(false);
    const [departments, setDepartments] = useState([]);

    useEffect(() => {
        getDepartments().then((data) => {
            if (data.departments && data.departments.length > 1) {
                setDepartments(data.departments);
            }
        });
    }, []);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!formData.name.trim() || !formData.email.trim()) return;
        setSubmitting(true);
        try {
            await onSubmit(formData);
        } catch {
            setSubmitting(false);
        }
    };

    return (
        <div className="flex-1 flex flex-col items-center justify-center px-5 py-6" style={{ backgroundColor: settings.background_color || '#ffffff' }}>
            <div className="w-full max-w-sm" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                <div className="flex items-center justify-center mb-4">
                    <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ backgroundColor: `${settings.primary_color || '#3A0CA3'}15` }}>
                        <Headphones className="w-7 h-7" style={{ color: settings.primary_color || '#3A0CA3' }} />
                    </div>
                </div>

                <h2 className="text-center text-[#16202C] text-lg font-bold mb-1">
                    Connect with our team
                </h2>
                <p className="text-center text-gray-500 text-sm mb-5">
                    Please share your details and we'll connect you right away.
                </p>

                <form onSubmit={handleSubmit} className="space-y-3">
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

                    <div className="flex items-center gap-2.5 rounded-xl border border-gray-200 bg-gray-50/50 px-3.5 py-2.5 focus-within:border-blue-300 focus-within:bg-white transition-colors">
                        <Mail className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        <input
                            type="email"
                            placeholder="Email address *"
                            value={formData.email}
                            onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                            className="flex-1 bg-transparent outline-none text-sm text-[#16202C] placeholder:text-gray-400"
                            required
                        />
                    </div>

                    {departments.length > 0 && (
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
                        disabled={submitting || !formData.name.trim() || !formData.email.trim()}
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

export default HandoffForm;
